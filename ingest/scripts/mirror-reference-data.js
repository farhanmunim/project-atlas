/**
 * mirror-reference-data.js — mirror the reference datasets into the warehouse so
 * the VPS Postgres is a single source of truth.
 *
 * These five datasets are reference data (they change only on network revisions /
 * annual releases), produced by the Atlas pipeline and served from the static
 * store at /api/v1/*. This step pulls them from that public API and upserts them
 * into the warehouse — decoupled from this pipeline's own (flaky) TfL fetchers,
 * always using the already-built, already-validated data:
 *
 *   /api/v1/route-stops       → public.route_stops       (per route/direction)
 *   /api/v1/routes-overview   → public.route_geometry    (per route/direction)
 *   /api/v1/bridges           → public.bridges           (per structure)
 *   /api/v1/crowding-profile  → public.crowding_profile  (per route/BUSTO year)
 *   /api/v1/localities        → public.localities        (per place)
 *   /api/v1/route-diversions  → public.route_diversions  (per route/episode — rows
 *                               accrue per detected_at, never deleted, so the
 *                               table doubles as the diversion history)
 *
 * Migrations 0023–0027 + 0029. Soft by design: a source that won't fetch is skipped
 * (last-good stays); a warehouse that isn't configured no-ops. Run standalone
 * (`npm run mirror-reference-data`) or as a step in refresh.js.
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';

loadEnv();
const WAREHOUSE_URL         = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';
// Where the reference datasets are served (the static store via our public API).
const ATLAS_API = (process.env.ATLAS_API_BASE ?? 'https://atlas.farhan.app/api/v1').replace(/\/+$/, '');
const BATCH = 500;

if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) {
  console.warn('Warehouse env not configured (WAREHOUSE_URL / WAREHOUSE_SERVICE_KEY missing) — skipping mirror.');
  process.exit(0);
}
const db = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getJson(path) {
  const r = await fetch(`${ATLAS_API}/${path}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET /${path} → HTTP ${r.status}`);
  return r.json();
}
async function upsert(table, rows, conflict) {
  if (!rows.length) { console.log(`  ${table}: nothing to write`); return; }
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await db.from(table).upsert(chunk, { onConflict: conflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`);
    written += chunk.length;
  }
  console.log(`  ${table}: wrote ${written} rows`);
}
const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);

// Each mirror is independent + soft — one source failing must not lose the others.
async function step(name, fn) {
  try { await fn(); }
  catch (e) { console.warn(`  ${name} skipped — ${e.message}`); }
}

async function mirrorStops() {
  const d = await getJson('route-stops');
  const routes = d.routes || d;
  const rows = [];
  for (const [routeId, dirs] of Object.entries(routes)) {
    for (const direction of ['outbound', 'inbound']) {
      const stops = (dirs && dirs[direction]) || [];
      if (!stops.length) continue;
      rows.push({ route_id: routeId, direction, stops, n_stops: stops.length });
    }
  }
  await upsert('route_stops', rows, 'route_id,direction');
}

async function mirrorGeometry() {
  const d = await getJson('routes-overview');
  const feats = d.features || [];
  const rows = feats.filter((f) => f && f.geometry && f.properties).map((f) => {
    const p = f.properties;
    return {
      route_id: String(p.routeId ?? p.name), direction: String(p.direction ?? '1'),
      geom_type: f.geometry.type, coordinates: f.geometry.coordinates,
      length_km: num(p.lengthKm), n_stops: num(p.stops), route_type: p.routeType ?? null,
    };
  });
  await upsert('route_geometry', rows, 'route_id,direction');
}

async function mirrorBridges() {
  const d = await getJson('bridges');
  const list = d.bridges || d;
  const rows = (Array.isArray(list) ? list : []).filter((b) => b && b.id).map((b) => ({
    bridge_id: String(b.id), lat: num(b.lat), lng: num(b.lng != null ? b.lng : b.lon),
    height_m: num(b.height_m), height_imperial: b.height_imperial ?? null,
    name: b.name ?? null, road: b.road ?? null, structure_type: b.structure_type ?? null, borough: b.borough ?? null,
  }));
  await upsert('bridges', rows, 'bridge_id');
}

async function mirrorCrowdingProfile() {
  const d = await getJson('crowding-profile');
  const year = d.year || 'unknown';
  const routes = d.routes || {};
  const rows = Object.entries(routes).map(([routeId, p]) => ({
    route_id: routeId, busto_year: year, profile_dir: (p && p.profileDir) ?? null,
    load_profile: (p && p.loadProfile) ?? null, time_of_day: (p && p.timeOfDay) ?? null,
  }));
  await upsert('crowding_profile', rows, 'route_id,busto_year');
}

async function mirrorLocalities() {
  const d = await getJson('localities');
  const list = d.localities || d;
  const seen = new Set(), rows = [];
  (Array.isArray(list) ? list : []).forEach((l) => {
    if (!l || !l.name || l.lat == null || l.lng == null) return;
    const k = `${l.name}|${(+l.lat).toFixed(5)}|${(+l.lng).toFixed(5)}`;
    if (seen.has(k)) return; seen.add(k);
    rows.push({ name: l.name, lat: num(l.lat), lng: num(l.lng), kind: l.kind ?? null });
  });
  await upsert('localities', rows, 'name,lat,lng');
}

async function mirrorDiversions() {
  const d = await getJson('route-diversions');
  const routes = d.routes || {};
  const rows = Object.entries(routes).filter(([, v]) => v && v.detectedAt).map(([name, v]) => ({
    route_id: String(v.id ?? name).toLowerCase(), route_name: name,
    detected_at: v.detectedAt, status: v.status ?? 'unknown', severity: num(v.severity),
    reasons: v.disruptions ?? null, since: v.since ?? null, until_ts: v.until ?? null,
    geometry_status: v.geometryStatus ?? null,
    missed_stops: v.missedStops ?? null, added_stops: v.addedStops ?? null,
    diversion_segments: v.diversionSegments ?? null, bypassed_segments: v.bypassedSegments ?? null,
    fetched_at: new Date().toISOString(),
  }));
  await upsert('route_diversions', rows, 'route_id,detected_at');
}

// Body/type enrichment for public.vehicles — only rows that HAVE enrichment, upserted on
// registration so PostgREST merges just these columns and never disturbs DVLA-sourced ones.
async function mirrorVehicleBodies() {
  const d = await getJson('vehicles');
  const rows = Object.values(d.byReg || {}).filter((v) => v.reg && (v.body || v.fleetCode || v.deck)).map((v) => ({
    registration: v.reg, body: v.body ?? null, deck: v.deck ?? null,
    fleet_code: v.fleetCode ?? null, propulsion_source: v.propulsionSource ?? null,
  }));
  await upsert('vehicles', rows, 'registration');
}

async function main() {
  console.log(`Mirroring reference datasets from ${ATLAS_API} → warehouse`);
  await step('route_stops', mirrorStops);
  await step('route_geometry', mirrorGeometry);
  await step('bridges', mirrorBridges);
  await step('crowding_profile', mirrorCrowdingProfile);
  await step('localities', mirrorLocalities);
  await step('route_diversions', mirrorDiversions);
  await step('vehicle_bodies', mirrorVehicleBodies);
  console.log('Reference mirror done.');
}
main().catch((e) => { console.error(`mirror-reference-data failed: ${e.message}`); process.exit(1); });
