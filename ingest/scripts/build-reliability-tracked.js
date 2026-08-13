/**
 * build-reliability-tracked.js — yesterday's TRACKED EWT/OTD estimate per route
 * (Atlas's reliability v2, EXPERIMENTAL).
 *
 * Reads the continuous collector's trip log (data/tracking/trips-<day>.jsonl),
 * interpolates each outbound trip's passing time at the route's timing point
 * (waypoint-trail pace-aware — _lib/lost-mileage.js estimatePassingMin), and
 * feeds the passing minutes + route_schedule departures into the pure QSI core
 * (_lib/reliability-tracked.js): EWT = AWT − SWT over COMPLETE observed
 * headways (high-frequency), OTD = % departures −2…+5 min (low-frequency).
 * Feed honesty: headways never span an operator-outage window; departures
 * inside one are unmeasured, never non-arrivals.
 *
 * Upserts route_reliability_tracked_daily (migration 0032) — deliberately a
 * SEPARATE table from the sampled route_reliability_daily so the two estimates
 * calibrate against each other and TfL's quarterly QSI before promotion.
 *
 * Runs chained after build-lost-mileage on the existing 00:37 UTC task
 * (package.json). Soft-fails on every missing prerequisite: no trip log,
 * partial collector day, no warehouse env, missing table — warn and exit 0.
 *
 *   node scripts/build-reliability-tracked.js [--day=YYYY-MM-DD]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_lib/env.js';
import { estimatePassingMin } from './_lib/lost-mileage.js';
import { computeTrackedReliability } from './_lib/reliability-tracked.js';
import { readJsonl, loadScheduleLatest, loadTimingContext, loadFeedWindows, routeOperators } from './_lib/tracking-day.js';

loadEnv();
const SCRIPT = 'build-reliability-tracked';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'tracking');
const ATLAS_API = (process.env.ATLAS_API_BASE ?? 'https://atlas.farhan.app/api/v1').replace(/\/+$/, '');

const WAREHOUSE_URL = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';
const BATCH = 500;
const MIN_DAY_TRIPS = 500;        // same partial-day refusal as the lost-mileage matcher

const argDay = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const day = argDay || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const day0 = Date.parse(day + 'T00:00:00Z');
const dayType = (() => { const d = new Date(day0).getUTCDay(); return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday'; })();

async function main() {
  const trips = readJsonl(path.join(DIR, `trips-${day}.jsonl`));
  if (!trips) { console.warn(`build-reliability-tracked: no trip log for ${day} — collector not running here; skipping.`); return; }
  if (trips.length < MIN_DAY_TRIPS) { console.warn(`build-reliability-tracked: only ${trips.length} trips logged for ${day} (<${MIN_DAY_TRIPS}) — partial collector day; refusing to write.`); return; }
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) { console.warn('build-reliability-tracked: warehouse env not configured — skipping.'); return; }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // shared day inputs (same loaders as build-lost-mileage — _lib/tracking-day.js)
  const sched = await loadScheduleLatest(supabase);
  const { timingKmOf } = await loadTimingContext(ATLAS_API, SCRIPT);
  const windowsByOp = loadFeedWindows(DIR, day, day0);
  const routeOp = routeOperators(trips);

  // observed passings at the timing point, per route (outbound trips)
  const byRoute = {};
  for (const t of trips) if (t.dir === '1') (byRoute[t.route] ||= []).push(t);

  const rows = [];
  for (const [name, s] of sched) {
    const deps = s.scheduled_departures?.[dayType] || [];
    if (deps.length < 2) continue;                                 // no usable timetable this day type
    const perTripKm = s.scheduled_km && s.scheduled_trips ? s.scheduled_km / s.scheduled_trips : null;
    const timingKm = timingKmOf(name, s, perTripKm);
    const passings = (byRoute[name] || []).map((t) => estimatePassingMin(t, timingKm, day0)).filter(Number.isFinite);
    const windows = windowsByOp[routeOp[name]] ?? [];
    const m = computeTrackedReliability({ departuresMin: deps }, passings, windows);
    if (m.ewt_minutes == null && m.otd_percent == null) continue;  // thin day — nothing publishable
    const coverage = deps.length ? +((m.deps_measured / deps.length) * 100).toFixed(1) : null;
    const basis = s.service_class === 'high-frequency' ? m.observed_headways : m.deps_measured;
    rows.push({
      route_id: name, day, day_type: dayType, service_class: s.service_class ?? null, ...m,
      feed_coverage_pct: coverage,
      confidence: coverage >= 90 && basis >= 10 ? 'high' : coverage >= 70 && basis >= 5 ? 'medium' : 'low',
      extracted_at: new Date().toISOString(),
    });
  }
  if (!rows.length) { console.warn('build-reliability-tracked: nothing computable — skipping.'); return; }

  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('route_reliability_tracked_daily').upsert(rows.slice(i, i + BATCH), { onConflict: 'route_id,day', ignoreDuplicates: false });
    if (error) {
      if (/route_reliability_tracked_daily|schema cache|does not exist/i.test(error.message)) { console.warn(`build-reliability-tracked: table missing (migration 0032 pending) — ${error.message}`); return; }
      throw new Error(`route_reliability_tracked_daily upsert failed at row ${i}: ${error.message}`);
    }
  }
  const hf = rows.filter((r) => r.ewt_minutes != null);
  const lf = rows.filter((r) => r.otd_percent != null);
  const mean = (xs, k) => (xs.length ? (xs.reduce((a, r) => a + r[k], 0) / xs.length).toFixed(2) : '—');
  console.log(`build-reliability-tracked ${day} (${dayType}): ${rows.length} routes · high-freq ${hf.length} (mean EWT ${mean(hf, 'ewt_minutes')} min · TfL network ~1.1) · low-freq ${lf.length} (mean OTD ${mean(lf, 'otd_percent')}% · TfL ~80+)`);
}

main().catch((err) => { console.warn('build-reliability-tracked soft-failed:', err.message); });
