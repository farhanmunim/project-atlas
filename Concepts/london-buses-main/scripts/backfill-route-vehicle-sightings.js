/**
 * backfill-route-vehicle-sightings.js — Enrich route-vehicles.json with the
 * recurrence counts (sightings / distinct-days) recovered from Supabase.
 *
 * The core-fleet filter in build-classifications.js keys on each reg's `days`
 * (how many distinct days it ran the route) to separate a route's regular fleet
 * from one-off cover buses. The weekly snapshot alone takes weeks to build that
 * signal up. This step pulls it forward by reading every observation Supabase
 * already holds — BOTH the permanent weekly log (route_vehicle_observations,
 * months of history) AND the rolling daily samples (route_vehicle_sightings,
 * fed by sample-vehicles.js) — via the route_vehicle_recurrence() RPC, and
 * merges the counts back into route-vehicles.json before the build reads it.
 *
 * Robustness:
 *   • Soft-fail: if Supabase isn't configured/reachable, or the RPC is missing,
 *     it leaves route-vehicles.json untouched (the build falls back to the
 *     forward-accumulated counts already in the file). Never exits non-zero.
 *   • Merge, never regress: counts become max(existing, supabase); first/last
 *     seen widen to the union. This preserves THIS run's just-collected snapshot
 *     (already written by fetch-route-vehicles.js) even though it hasn't been
 *     pushed to Supabase yet.
 *   • Adds regs the daily sampler saw that the weekly snapshot missed.
 *   • TTL: entries last seen before the window are dropped (matches the fetcher).
 *
 * Flags: --dry-run (report only), --window=<days> (default 56).
 *
 * Run: npm run backfill-route-vehicle-sightings
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';
import { atomicWriteJson, loadJsonCache } from './_lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'route-vehicles.json');

const argv       = process.argv.slice(2);
const DRY_RUN    = argv.includes('--dry-run');
const windowArg  = argv.find(a => a.startsWith('--window='));
const WINDOW_DAYS = windowArg ? Math.max(1, parseInt(windowArg.split('=')[1], 10) || 56) : 56;

loadEnv();
const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function dateOf(iso) { return typeof iso === 'string' ? iso.slice(0, 10) : null; }
function minIso(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }
function maxIso(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env not configured — leaving route-vehicles.json as-is (forward counts).');
    return;
  }

  const file = loadJsonCache(OUT_PATH, null);
  if (!file?.routes) {
    console.warn(`No usable ${OUT_PATH} — nothing to enrich. Skipping.`);
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  console.log(`Reading recurrence since ${sinceIso} (window ${WINDOW_DAYS}d)...`);

  const { data, error } = await supabase.rpc('route_vehicle_recurrence', { p_since: sinceIso });
  if (error) {
    console.warn(`  RPC route_vehicle_recurrence failed (${error.message}) — leaving file as-is.`);
    return;
  }
  if (!Array.isArray(data) || !data.length) {
    console.warn('  RPC returned no rows — leaving file as-is.');
    return;
  }

  // Index recurrence by route → reg.
  const rec = new Map();  // routeId(upper) → Map(reg(upper) → {sightings,days,first,last})
  for (const row of data) {
    const routeId = String(row.route_id ?? '').toUpperCase();
    const reg     = String(row.registration ?? '').toUpperCase();
    if (!routeId || !reg) continue;
    if (!rec.has(routeId)) rec.set(routeId, new Map());
    rec.get(routeId).set(reg, {
      sightings: Number(row.sightings) || 0,
      days:      Number(row.days) || 0,
      first:     row.first_seen ?? null,
      last:      row.last_seen ?? null,
    });
  }
  console.log(`  Recurrence rows: ${data.length} across ${rec.size} routes.`);

  const cutoffMs = Date.now() - WINDOW_DAYS * 86_400_000;
  let enriched = 0, added = 0, dropped = 0, routesTouched = 0;

  const routesOut = {};
  const allRouteIds = new Set([
    ...Object.keys(file.routes).map(r => r.toUpperCase()),
    ...rec.keys(),
  ]);

  for (const routeId of [...allRouteIds].sort()) {
    const existingList = file.routes[routeId] ?? file.routes[routeId.toLowerCase()] ?? [];
    const recRoute = rec.get(routeId) ?? new Map();
    const seenReg = new Set();
    const merged = [];

    // 1. Existing entries, enriched from recurrence.
    for (const entry of existingList) {
      const reg = (typeof entry === 'string' ? entry : entry?.reg)?.toUpperCase();
      if (!reg) continue;
      const e = typeof entry === 'object' ? entry : { reg };
      const r = recRoute.get(reg);
      let firstSeenAt = e.firstSeenAt ?? e.lastSeenAt ?? null;
      let lastSeenAt  = e.lastSeenAt ?? null;
      let sightings   = Number.isFinite(e.sightings) ? e.sightings : 1;
      let days        = Number.isFinite(e.days) ? e.days : 1;
      if (r) {
        // Merge, never regress — the existing entry already reflects THIS run's
        // snapshot (which Supabase may not have yet); take the wider/larger.
        sightings   = Math.max(sightings, r.sightings);
        days        = Math.max(days, r.days);
        firstSeenAt = minIso(firstSeenAt, r.first);
        lastSeenAt  = maxIso(lastSeenAt, r.last);
        enriched++;
      }
      if (lastSeenAt && new Date(lastSeenAt).getTime() < cutoffMs) { dropped++; continue; }
      seenReg.add(reg);
      merged.push({ reg, firstSeenAt, lastSeenAt, sightings, days });
    }

    // 2. Regs Supabase saw (within window) that the weekly snapshot missed.
    for (const [reg, r] of recRoute) {
      if (seenReg.has(reg)) continue;
      if (!r.last || new Date(r.last).getTime() < cutoffMs) continue;
      merged.push({ reg, firstSeenAt: r.first, lastSeenAt: r.last, sightings: r.sightings, days: r.days });
      added++;
    }

    if (merged.length) {
      merged.sort((a, b) => a.reg.localeCompare(b.reg));
      routesOut[routeId] = merged;
      routesTouched++;
    }
  }

  // Day-distribution before/after so the effect is visible in CI logs.
  const dayHist = list => list.reduce((h, e) => { const d = Math.min(e.days ?? 1, 5); h[d] = (h[d] ?? 0) + 1; return h; }, {});
  const after = Object.values(routesOut).flat();
  const coreAfter = after.filter(e => (e.days ?? 1) >= 2).length;
  console.log(`  Enriched ${enriched} regs, added ${added}, dropped ${dropped} (stale).`);
  console.log(`  Reg-entries with days>=2 (core-eligible) after backfill: ${coreAfter}/${after.length}.`);
  console.log(`  days histogram (capped at 5+): ${JSON.stringify(dayHist(after))}`);

  if (DRY_RUN) {
    console.log('  --dry-run: not writing.');
    return;
  }

  const output = {
    generatedAt:        file.generatedAt,
    observationTtlDays: file.observationTtlDays ?? WINDOW_DAYS,
    backfilledAt:       new Date().toISOString(),
    routeCount:         Object.keys(routesOut).length,
    routes:             routesOut,
  };
  atomicWriteJson(OUT_PATH, output);
  console.log(`Wrote enriched observations for ${output.routeCount} routes to ${OUT_PATH}.`);
}

main().catch(err => { console.warn('backfill soft-failed:', err.message); });
