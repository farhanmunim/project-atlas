/**
 * build-reliability.js — Derive Atlas's OWN daily reliability from raw samples.
 *
 * Reads the trailing day's accumulated arrival_samples plus the scheduled
 * baseline (route_schedule) from Supabase, reconstructs observed headways per
 * route, and computes — per TfL's definitions — the metric appropriate to the
 * route's service class, then upserts route_reliability_daily (one row per
 * route per day, onConflict route_id,day).
 *
 * METHODOLOGY (implements TfL's definitions):
 *
 *   High-frequency routes (service_class = 'high-frequency'):
 *     • Reconstruct OBSERVED headways hₐ: at the timing-point stop, take each
 *       distinct vehicle's soonest passing (min recorded expected_at), sort
 *       those passings by time, diff consecutive → the gaps between buses.
 *     • AWT = Σ(hₐ²) / (2·Σhₐ)              (Actual Waiting Time)
 *     • EWT = AWT − SWT                      (Excess Waiting Time; lower better)
 *       SWT is taken from route_schedule (computed over SCHEDULED headways).
 *
 *   Low-frequency routes (service_class = 'low-frequency'):
 *     • OTD = % of observed departures running between 2 min EARLY and 5 min
 *       LATE versus the nearest scheduled departure. We don't have the full
 *       schedule timetable here, so OTD is approximated from the deviation of
 *       observed passings against the scheduled headway grid anchored on the
 *       route's mean scheduled headway — see the caveat below.
 *
 *   Lost mileage (both classes):
 *     • operated_km ≈ distinct observed vehicle-trips × route length (km)
 *     • lost_km = scheduled_km − operated_km   (floored at 0)
 *     • mileage_operated_percent = operated_km / scheduled_km × 100
 *
 * ── ACCURACY CAVEATS (these are ESTIMATES, not TfL's measured figures) ──────
 *   • Sampled predictions, not measured departures: arrival_samples carry
 *     TfL's expectedArrival predictions, which drift from the actual passing.
 *   • Periodic sampling (~30 min) under-observes short headways and can miss a
 *     bus that passed entirely between two samples — so AWT/EWT are
 *     directional, biased toward the larger gaps we DID catch.
 *   • Observed vehicle-trips is a coarse mileage proxy: a vehicle seen at the
 *     timing point is assumed to run the full route length once; dead mileage,
 *     short-workings and curtailments are ignored.
 *   • OTD here lacks per-trip scheduled departure times, so it's the weakest
 *     estimate of the set — treat it as indicative only.
 * The QSI-PDF figures in route_performance remain authoritative; this table is
 * a higher-frequency supplement, labelled as such wherever Atlas surfaces it.
 *
 * Soft-fail: if Supabase env is missing or unreachable, logs and exits 0 (no
 * service-role key locally is a no-op, like the other Supabase steps).
 *
 * Run: npm run build-reliability
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';

const BATCH       = 500;
const WINDOW_HRS  = 24;     // reconstruct over the trailing 24h of samples
const PAGE        = 1000;   // Supabase default row cap per select — page through it

loadEnv();
const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// ── Waiting-time formulas (shared definition with fetch-schedule.js) ────────
// AWT = Σ(h²)/(2·Σh) over a list of headways. Identical formula to SWT; the
// only difference is whether the headways are scheduled or observed.
function waitingTime(headways) {
  if (!headways.length) return null;
  let sumSq = 0, sum = 0;
  for (const h of headways) { sumSq += h * h; sum += h; }
  if (sum <= 0) return null;
  return sumSq / (2 * sum);
}

// Reconstruct observed headways (minutes) from a route's samples.
// Each sample is one vehicle's predicted passing at a stop. Collapse to one
// passing per (stop, vehicle) = its EARLIEST recorded expected_at, then within
// each stop sort passings by time and diff consecutive. Pool gaps across the
// timing-point stop(s). Drops gaps ≤0 or >120 min (sampling artefacts / breaks).
function observedHeadways(samples) {
  // (stop|vehicle) → earliest expected passing time (ms)
  const passing = new Map();
  for (const s of samples) {
    const stop = s.stop_id ?? '∅';
    const reg  = s.vehicle_id;
    if (!reg) continue;
    const t = s.expected_at ? new Date(s.expected_at).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const key = `${stop}|${reg}`;
    const prev = passing.get(key);
    if (prev == null || t < prev) passing.set(key, t);
  }
  // group passings by stop
  const byStop = new Map();
  for (const [key, t] of passing) {
    const stop = key.split('|')[0];
    (byStop.get(stop) ?? byStop.set(stop, []).get(stop)).push(t);
  }
  const headways = [];
  for (const times of byStop.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const d = (times[i] - times[i - 1]) / 60000;   // ms → min
      if (d > 0 && d <= 120) headways.push(d);
    }
  }
  return headways;
}

// Count distinct observed vehicle-trips for the route (proxy for trips run).
// A "trip" ≈ a distinct vehicle appearing at the timing point. This under-
// counts vehicles that complete several round-trips a day, so operated_km is
// conservative — documented in the caveats above.
function distinctVehicleTrips(samples) {
  const regs = new Set();
  for (const s of samples) if (s.vehicle_id) regs.add(s.vehicle_id);
  return regs.size;
}

// OTD estimate for low-frequency routes. Without per-trip scheduled times we
// approximate: build a scheduled grid from the route's mean scheduled headway
// anchored at the first observed passing, then score each observed passing by
// its deviation to the nearest grid slot. On-time = −5 min (late) .. +2 min
// (early) of schedule, i.e. within [-5, +2] of grid. Weakest metric in the set.
function estimateOtd(samples, schedHeadwayMin) {
  if (!schedHeadwayMin || schedHeadwayMin <= 0) return null;
  const times = [];
  const seen = new Map();
  for (const s of samples) {
    if (!s.vehicle_id || !s.expected_at) continue;
    const t = new Date(s.expected_at).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = seen.get(s.vehicle_id);
    if (prev == null || t < prev) seen.set(s.vehicle_id, t);
  }
  for (const t of seen.values()) times.push(t);
  if (times.length < 2) return null;
  times.sort((a, b) => a - b);
  const anchor = times[0];
  const stepMs = schedHeadwayMin * 60000;
  let onTime = 0;
  for (const t of times) {
    const slot = Math.round((t - anchor) / stepMs);
    const devMin = (t - (anchor + slot * stepMs)) / 60000;  // + = late, − = early
    if (devMin >= -2 && devMin <= 5) onTime++;              // 2 early .. 5 late
  }
  return +(100 * onTime / times.length).toFixed(1);
}

// Page through a Supabase table with a filter, returning all rows.
async function selectAll(supabase, table, build) {
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(supabase.from(table).select('*')).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env not configured — cannot build reliability. Skipping.');
    return;
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const since = new Date(Date.now() - WINDOW_HRS * 3600_000).toISOString();
  const day = new Date().toISOString().slice(0, 10);

  console.log(`Reading arrival_samples since ${since} ...`);
  const samples = await selectAll(supabase, 'arrival_samples', (q) => q.gte('recorded_at', since));
  console.log(`  ${samples.length} samples`);

  console.log('Reading latest route_schedule ...');
  const schedRows = await selectAll(supabase, 'route_schedule', (q) => q);
  // Keep the newest snapshot per route (most recent snapshot_date wins).
  const schedule = {};
  for (const r of schedRows) {
    const id = String(r.route_id).toUpperCase();
    const prev = schedule[id];
    if (!prev || String(r.snapshot_date) > String(prev.snapshot_date)) schedule[id] = r;
  }
  console.log(`  ${Object.keys(schedule).length} routes with a schedule baseline`);

  // Group samples by route.
  const byRoute = new Map();
  for (const s of samples) {
    const id = String(s.route_id).toUpperCase();
    (byRoute.get(id) ?? byRoute.set(id, []).get(id)).push(s);
  }

  const rows = [];
  for (const [routeId, rsamples] of byRoute) {
    const sched = schedule[routeId] ?? null;
    const serviceClass = sched?.service_class ?? null;
    const swt = Number.isFinite(sched?.swt_minutes) ? Number(sched.swt_minutes) : null;
    const lengthKm = Number.isFinite(sched?.scheduled_km) && Number.isFinite(sched?.scheduled_trips) && sched.scheduled_trips
      ? Number(sched.scheduled_km) / Number(sched.scheduled_trips)   // recover per-trip length
      : null;
    const scheduledKm = Number.isFinite(sched?.scheduled_km) ? Number(sched.scheduled_km) : null;

    // Reliability metric by class.
    let awt = null, ewt = null, otd = null;
    if (serviceClass === 'high-frequency') {
      const hw = observedHeadways(rsamples);
      const w = waitingTime(hw);
      if (w != null) {
        awt = +w.toFixed(2);
        if (swt != null) ewt = +(awt - swt).toFixed(2);
      }
    } else if (serviceClass === 'low-frequency') {
      otd = estimateOtd(rsamples, Number.isFinite(sched?.headway_min) ? Number(sched.headway_min) : null);
    }

    // Lost mileage.
    let operatedKm = null, lostKm = null, mileagePct = null;
    if (lengthKm != null) {
      operatedKm = +(distinctVehicleTrips(rsamples) * lengthKm).toFixed(2);
      if (scheduledKm != null && scheduledKm > 0) {
        lostKm = +Math.max(0, scheduledKm - operatedKm).toFixed(2);
        mileagePct = +Math.min(100, 100 * operatedKm / scheduledKm).toFixed(1);
      }
    }

    rows.push({
      route_id:                 routeId,
      day,
      service_class:            serviceClass,
      awt_minutes:              awt,
      swt_minutes:              swt,
      ewt_minutes:              ewt,
      otd_percent:              otd,
      scheduled_km:             scheduledKm,
      operated_km:              operatedKm,
      lost_km:                  lostKm,
      mileage_operated_percent: mileagePct,
      sample_count:             rsamples.length,
    });
  }

  console.log(`Derived ${rows.length} route rows for ${day}.`);

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('route_reliability_daily')
      .upsert(chunk, { onConflict: 'route_id,day', ignoreDuplicates: false });
    if (error) throw new Error(`route_reliability_daily upsert failed at row ${i}: ${error.message}`);
    written += chunk.length;
  }
  console.log(`Wrote ${written} rows to route_reliability_daily.`);
}

main().catch(err => {
  // Soft-fail: keep prior daily rows on a Supabase outage; next run rebuilds.
  console.warn(`build-reliability soft-failed: ${err.message}`);
  process.exit(0);
});
