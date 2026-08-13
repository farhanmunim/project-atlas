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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_lib/env.js';
import { computeLostMileage, estimatePassingMin } from './_lib/lost-mileage.js';
import { readJsonl, loadScheduleLatest, loadTimingContext, loadFeedWindows, routeOperators } from './_lib/tracking-day.js';

loadEnv();
const SCRIPT = 'build-lost-mileage';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'tracking');
const ATLAS_API = (process.env.ATLAS_API_BASE ?? 'https://atlas.farhan.app/api/v1').replace(/\/+$/, '');

const WAREHOUSE_URL = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';
const BATCH = 500;
const MIN_DAY_TRIPS = 500;        // fewer network-wide = partial collector day → refuse to write garbage

const argDay = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const day = argDay || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const day0 = Date.parse(day + 'T00:00:00Z');
const dayType = (() => { const d = new Date(day0).getUTCDay(); return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday'; })();

async function main() {
  const trips = readJsonl(path.join(DIR, `trips-${day}.jsonl`));
  if (!trips) { console.warn(`build-lost-mileage: no trip log for ${day} — collector not running here; skipping.`); return; }
  if (trips.length < MIN_DAY_TRIPS) { console.warn(`build-lost-mileage: only ${trips.length} trips logged for ${day} (<${MIN_DAY_TRIPS}) — partial collector day; refusing to write.`); return; }
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) { console.warn('build-lost-mileage: warehouse env not configured — skipping.'); return; }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // shared day inputs (see _lib/tracking-day.js — also feeds build-reliability-tracked)
  const sched = await loadScheduleLatest(supabase);
  const { timingKmOf } = await loadTimingContext(ATLAS_API, SCRIPT);
  const windowsByOp = loadFeedWindows(DIR, day, day0);
  const routeOp = routeOperators(trips);

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
