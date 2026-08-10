/**
 * build-lost-mileage.js — yesterday's GROSS lost-mileage estimate per route.
 *
 * Reads the continuous collector's trip log (data/tracking/trips-<day>.jsonl)
 * and feed-health counts, matches observed outbound trips against the
 * scheduled departures in route_schedule at each route's TIMING POINT, and
 * upserts route_lost_mileage_daily (migration 0031). EXPERIMENTAL and gross
 * by construction — see the migration header for the honesty rules.
 *
 * Runs chained after build-reliability on the existing 00:37 UTC task
 * (package.json), so yesterday is complete. Soft-fails on every missing
 * prerequisite: no trip log (collector not deployed / down all day), no
 * warehouse env, missing table (migration pending) — warn and exit 0.
 *
 *   node scripts/build-lost-mileage.js [--day=YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_lib/env.js';
import { userAgentHeaders, fetchWithTimeout } from './_lib/http.js';
import { projectOnto } from './_lib/trip-tracker.js';
import { computeLostMileage, estimatePassingMin, unhealthyWindows, median } from './_lib/lost-mileage.js';

loadEnv();
const SCRIPT = 'build-lost-mileage';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'tracking');
const ATLAS_API = (process.env.ATLAS_API_BASE ?? 'https://atlas.farhan.app/api/v1').replace(/\/+$/, '');

const WAREHOUSE_URL = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';
const BATCH = 500;
const PAGE = 1000;
const MIN_DAY_TRIPS = 500;        // fewer network-wide = partial collector day → refuse to write garbage
const MEDIAN_LOOKBACK_DAYS = 14;

const argDay = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const day = argDay || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const day0 = Date.parse(day + 'T00:00:00Z');
const dayType = (() => { const d = new Date(day0).getUTCDay(); return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday'; })();

const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function getJson(url) {
  const r = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.json();
}

async function selectAll(supabase, table, build, orderCols = []) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = build(supabase.from(table).select('*'));
    for (const c of orderCols) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function main() {
  const trips = readJsonl(path.join(DIR, `trips-${day}.jsonl`));
  if (!trips) { console.warn(`build-lost-mileage: no trip log for ${day} — collector not running here; skipping.`); return; }
  if (trips.length < MIN_DAY_TRIPS) { console.warn(`build-lost-mileage: only ${trips.length} trips logged for ${day} (<${MIN_DAY_TRIPS}) — partial collector day; refusing to write.`); return; }
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) { console.warn('build-lost-mileage: warehouse env not configured — skipping.'); return; }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── scheduled side: latest route_schedule row per route ────────────────────
  const schedRows = await selectAll(supabase, 'route_schedule', (q) => q, ['route_id', 'snapshot_date']);
  const sched = new Map();
  for (const r of schedRows) sched.set(String(r.route_id).toUpperCase(), r);   // later snapshot wins (ordered)

  // ── timing-point along-km per route (stop position projected on geometry) ──
  const [stopsD, geoD] = await Promise.all([getJson(`${ATLAS_API}/route-stops`), getJson(`${ATLAS_API}/routes-overview`)]);
  const geoByName = {};
  for (const f of geoD.features || []) {
    if (String(f.properties?.direction) !== '1') continue;
    geoByName[String(f.properties.name).toUpperCase()] = f.geometry.coordinates;
  }
  const stopsById = {};   // routeNAME → { stopId → [lng,lat] }
  for (const [rid, dirs] of Object.entries(stopsD.routes || {})) {
    const m = {};
    for (const s of dirs.outbound || []) m[s.id] = [s.lng, s.lat];
    stopsById[rid.toUpperCase()] = m;
  }
  const timingKmOf = (name, schedRow, lenKm) => {
    const line = geoByName[name];
    const pos = stopsById[name]?.[schedRow?.timing_point_stop_id];
    if (line && pos) return projectOnto(line, pos[0], pos[1]).alongKm;
    return (lenKm || 0) / 2;   // fallback: mid-route
  };

  // ── feed health: today's counts vs 14-day medians, per operator ───────────
  const todayHealth = readJson(path.join(DIR, `feedhealth-${day}.json`)) || {};
  const histByOp = {};   // op → hour → [counts…]
  for (let i = 1; i <= MEDIAN_LOOKBACK_DAYS; i++) {
    const h = readJson(path.join(DIR, `feedhealth-${new Date(day0 - i * 86_400_000).toISOString().slice(0, 10)}.json`));
    if (!h) continue;
    for (const [op, hours] of Object.entries(h)) for (const [hr, n] of Object.entries(hours)) ((histByOp[op] ||= {})[hr] ||= []).push(n);
  }
  const windowsByOp = {};
  for (const op of Object.keys(todayHealth)) {
    const medBy = Object.fromEntries(Object.entries(histByOp[op] || {}).map(([h, xs]) => [h, median(xs)]));
    windowsByOp[op] = unhealthyWindows(todayHealth[op], medBy);
  }
  // route → operatorRef, from the day's own trips (majority vote)
  const opOf = {};
  for (const t of trips) { if (!t.operatorRef) continue; ((opOf[t.route] ||= {})[t.operatorRef] ??= 0); opOf[t.route][t.operatorRef]++; }
  const routeOp = Object.fromEntries(Object.entries(opOf).map(([r, ops]) => [r, Object.entries(ops).sort((a, b) => b[1] - a[1])[0][0]]));

  // ── per-route computation (outbound trips vs timing-point departures) ─────
  const byRoute = {};
  for (const t of trips) if (t.dir === '1') (byRoute[t.route] ||= []).push(t);
  const rows = [];
  for (const [name, s] of sched) {
    const deps = s.scheduled_departures?.[dayType] || [];
    if (!deps.length) continue;                                    // no timetable for this day type
    const perTripKm = s.scheduled_km && s.scheduled_trips ? s.scheduled_km / s.scheduled_trips : null;
    if (!perTripKm) continue;
    const timingKm = timingKmOf(name, s, perTripKm);
    const rTrips = (byRoute[name] || []).map((t) => ({ ...t, passMin: estimatePassingMin(t, timingKm, day0) }));
    const windows = windowsByOp[routeOp[name]] ?? [];
    const m = computeLostMileage(
      { departuresMin: deps, tripsCount: deps.length, km: +(deps.length * perTripKm).toFixed(1), lenKm: perTripKm },
      rTrips, windows, day0);
    const coverage = m.scheduled_km > 0 ? +((1 - m.unmeasured_km / m.scheduled_km) * 100).toFixed(1) : null;
    rows.push({
      route_id: name, day, day_type: dayType, ...m,
      feed_coverage_pct: coverage,
      confidence: coverage >= 90 && deps.length >= 5 ? 'high' : coverage >= 70 ? 'medium' : 'low',
      extracted_at: new Date().toISOString(),
    });
  }
  if (!rows.length) { console.warn('build-lost-mileage: nothing computable — skipping.'); return; }

  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('route_lost_mileage_daily').upsert(rows.slice(i, i + BATCH), { onConflict: 'route_id,day', ignoreDuplicates: false });
    if (error) {
      if (/route_lost_mileage_daily|schema cache|does not exist/i.test(error.message)) { console.warn(`build-lost-mileage: table missing (migration 0031 pending) — ${error.message}`); return; }
      throw new Error(`route_lost_mileage_daily upsert failed at row ${i}: ${error.message}`);
    }
  }
  const lost = rows.filter((r) => r.lost_trips > 0).length;
  const totLost = rows.reduce((a, r) => a + (r.lost_km_est || 0), 0);
  const avgPct = rows.filter((r) => r.lost_pct != null);
  console.log(`build-lost-mileage ${day} (${dayType}): ${rows.length} routes · ${lost} with losses · ${totLost.toFixed(0)} km lost est · mean lost ${avgPct.length ? (avgPct.reduce((a, r) => a + r.lost_pct, 0) / avgPct.length).toFixed(1) : '—'}% · calibration target (TfL quarterly): ~3%`);
}

main().catch((err) => { console.warn('build-lost-mileage soft-failed:', err.message); });
