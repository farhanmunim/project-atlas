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
 *     • Reconstruct OBSERVED passings at the timing point, clustering each vehicle's
 *       sightings into distinct passing events (so its later trips count too).
 *     • Compute AWT TfL's way — PER HOUR (the minimum QSI unit), first bus of each
 *       hour carrying no headway, headways diffed only WITHIN the hour, in service
 *       hours — then aggregate hourly AWT weighted by observed buses. Per-hour
 *       blocks stop a cross-hour sampling hole inflating AWT (the old whole-day
 *       diff produced EWTs of ~17-27 min vs TfL's ~1-2). hAWT = Σ(hₐ²)/(2·Σhₐ).
 *     • EWT = AWT − SWT (clamped: a negative ⇒ under-observed ⇒ null; needs a
 *       minimum observed-bus count to publish). SWT from route_schedule.
 *     See ingest/RELIABILITY-METHODOLOGY.md for the cited TfL definitions.
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
 *   • Sampling is denser than before (the sampler takes several sweeps per run),
 *     but still coarser than TfL's continuous AVL, so very short headways can be
 *     under-observed; per-hour blocks + a minimum bus count keep this honest by
 *     emitting null rather than a noisy number when coverage is thin.
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

import { loadEnv } from './_lib/env.js';
// @supabase/supabase-js is imported lazily inside main() so the pure-function
// --selftest path runs without ingest/node_modules installed.

const BATCH       = 500;
const WINDOW_HRS  = 24;     // reconstruct over the trailing 24h of samples
const PAGE        = 1000;   // Supabase default row cap per select — page through it

// ── TfL-aligned reconstruction parameters (see ingest/RELIABILITY-METHODOLOGY.md) ──
// TfL computes AWT/SWT PER HOUR (the minimum QSI unit), with the first bus of each hour
// carrying no headway, only in service hours, then aggregates weighted by observed buses.
// Doing it per-hour is what stops a sampling hole that spans an hour boundary from being
// counted as one giant headway (the bug that inflated EWT to ~17-27 min).
const SERVICE_START_HR  = 5;    // 05:00–23:59 daytime QSI window (UTC ≈ London here)
const SERVICE_END_HR    = 24;
const MAX_HEADWAY_MIN   = 60;   // within-hour cap; a longer "gap" is a sampling artifact, dropped
const MIN_OBSERVED_BUSES = 12;  // need enough passings before an EWT is trustworthy; else null
const MIN_OTD_DEPARTURES = 5;   // low-freq: need a few observed departures before an OTD; else null

loadEnv();
const WAREHOUSE_URL         = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';

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

const PASSING_GAP_MIN = 25;   // sightings of one vehicle ≤25 min apart = same passing event

// Reconstruct distinct PASSING events per stop. A vehicle is sampled repeatedly as it
// approaches (converging predictions) and also reappears on its LATER trips hours later;
// collapsing to one time per (stop,vehicle) would drop those later trips. So cluster each
// vehicle's sightings (one per sweep): consecutive sightings ≤PASSING_GAP_MIN apart are one
// event; a larger gap starts a new passing.
//
// Passing TIME per event = the expected_at of the sighting with the SMALLEST predicted
// time-to-station (expected_at − recorded_at). As a bus nears the stop its prediction
// converges to the true passing, so the most-converged sighting is the best measured-ish
// passing time — far better than the earliest (furthest-out, least-accurate) prediction.
// Falls back to the earliest expected_at when recorded_at is absent. Returns Map<stop, ms[]>.
function passingsByStop(samples) {
  const byVeh = new Map();   // stop|vehicle → [{ exp, ttsMin }]
  for (const s of samples) {
    const reg = s.vehicle_id; if (!reg) continue;
    const stop = s.stop_id ?? '∅';
    const exp = s.expected_at ? new Date(s.expected_at).getTime() : NaN;
    if (!Number.isFinite(exp)) continue;
    const rec = s.recorded_at ? new Date(s.recorded_at).getTime() : NaN;
    const ttsMin = Number.isFinite(rec) ? (exp - rec) / 60_000 : Infinity;   // ∞ = unknown → deprioritised
    (byVeh.get(`${stop}|${reg}`) ?? byVeh.set(`${stop}|${reg}`, []).get(`${stop}|${reg}`)).push({ exp, ttsMin });
  }
  const gapMs = PASSING_GAP_MIN * 60_000;
  const byStop = new Map();
  // the best passing time within a cluster of sightings = the most-converged one
  const passingOf = (cluster) => cluster.reduce((best, c) => (c.ttsMin < best.ttsMin ? c : best)).exp;
  for (const [key, sights] of byVeh) {
    const stop = key.slice(0, key.lastIndexOf('|'));
    sights.sort((a, b) => a.exp - b.exp);
    const out = byStop.get(stop) ?? byStop.set(stop, []).get(stop);
    let cluster = [sights[0]], last = sights[0].exp;
    for (let i = 1; i < sights.length; i++) {
      if (sights[i].exp - last > gapMs) { out.push(passingOf(cluster)); cluster = []; }  // new passing
      cluster.push(sights[i]); last = sights[i].exp;
    }
    out.push(passingOf(cluster));
  }
  return byStop;
}

// Actual Waiting Time the TfL way: PER HOUR (the minimum QSI unit), the first bus of
// each clock-hour carries no headway, headways are diffed only WITHIN the hour, then the
// hourly AWTs are aggregated weighted by observed buses (OB) — TfL's Step I/II weighting.
// Returns { awt (min) | null, observedBuses }. Per-hour bucketing is what prevents a gap
// that spans an hour boundary (e.g. a sampling hole) from inflating AWT.
function awtHourly(byStop) {
  let wAwt = 0, wSum = 0, obsTotal = 0;
  for (const times of byStop.values()) {
    // bucket passings into absolute clock-hours, in the service window
    const hours = new Map();
    for (const t of times) {
      const hr = new Date(t).getUTCHours();
      if (hr < SERVICE_START_HR || hr >= SERVICE_END_HR) continue;
      const bucket = Math.floor(t / 3_600_000);
      (hours.get(bucket) ?? hours.set(bucket, []).get(bucket)).push(t);
    }
    for (const hrTimes of hours.values()) {
      hrTimes.sort((a, b) => a - b);
      const hw = [];
      for (let i = 1; i < hrTimes.length; i++) {   // i=1 ⇒ first bus of the hour has no headway
        const d = (hrTimes[i] - hrTimes[i - 1]) / 60000;
        if (d > 0 && d <= MAX_HEADWAY_MIN) hw.push(d);
      }
      if (!hw.length) continue;
      const aw = waitingTime(hw); if (aw == null) continue;
      const ob = hrTimes.length;                  // observed buses this hour at this stop
      wAwt += aw * ob; wSum += ob; obsTotal += ob;
    }
  }
  return { awt: wSum > 0 ? wAwt / wSum : null, observedBuses: obsTotal };
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

// Day-type for a YYYY-MM-DD (noon-anchored to dodge TZ edges).
function pickDayType(dayStr) {
  const d = new Date(`${dayStr}T12:00:00Z`).getUTCDay();   // 0=Sun … 6=Sat
  return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday';
}

// Real-schedule OTD: score each observed passing (ms) at the timing point against the
// nearest SCHEDULED departure (minutes-after-midnight). On-time = 2.5 min early .. 5 min
// late (TfL's window). Far better than the synthetic grid — uses actual scheduled times.
function otdAgainstSchedule(passMs, schedMins) {
  if (!Array.isArray(schedMins) || schedMins.length < 2 || !Array.isArray(passMs) || !passMs.length) return null;
  const sched = [...schedMins].sort((a, b) => a - b);
  let onTime = 0, n = 0;
  for (const ms of passMs) {
    const d = new Date(ms);
    const hr = d.getUTCHours();
    if (hr < SERVICE_START_HR || hr >= SERVICE_END_HR) continue;
    const mins = hr * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    let dev = Infinity;
    for (const s of sched) { const e = mins - s; if (Math.abs(e) < Math.abs(dev)) dev = e; }  // + = late
    n++;
    if (dev >= -2.5 && dev <= 5) onTime++;
  }
  return n >= MIN_OTD_DEPARTURES ? +(100 * onTime / n).toFixed(1) : null;
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
    if (devMin >= -2.5 && devMin <= 5) onTime++;            // TfL on-time: 2.5 early .. 5 late
  }
  return +(100 * onTime / times.length).toFixed(1);
}

// Page through a Supabase table with a filter, returning all rows. orderCols
// pins a deterministic order — without one, pages of an unordered scan can
// overlap or skip rows once tables grow past a single page (they now do).
async function selectAll(supabase, table, build, orderCols = []) {
  const out = [];
  let from = 0;
  while (true) {
    let q = build(supabase.from(table).select('*'));
    for (const c of orderCols) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) {
    console.warn('Warehouse env not configured — cannot build reliability. Skipping.');
    return;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const since = new Date(Date.now() - WINDOW_HRS * 3600_000).toISOString();
  const day = new Date().toISOString().slice(0, 10);

  console.log(`Reading arrival_samples since ${since} ...`);
  const samples = await selectAll(supabase, 'arrival_samples', (q) => q.gte('recorded_at', since), ['id']);
  console.log(`  ${samples.length} samples`);

  console.log('Reading latest route_schedule ...');
  const schedRows = await selectAll(supabase, 'route_schedule', (q) => q, ['route_id', 'snapshot_date']);
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
      const { awt: awtRaw, observedBuses } = awtHourly(passingsByStop(rsamples));
      // Only publish an EWT when enough buses were observed; a thin sample is noise.
      if (awtRaw != null && observedBuses >= MIN_OBSERVED_BUSES) {
        awt = +awtRaw.toFixed(2);
        if (swt != null) {
          const e = awt - swt;
          // EWT cannot be negative (AWT ≥ SWT in principle); a negative value means we
          // under-observed this route today → null rather than a misleading number.
          ewt = e >= 0 ? +e.toFixed(2) : null;
        }
      }
    } else if (serviceClass === 'low-frequency') {
      // Prefer real scheduled departures (migration 0021) at the representative timing point;
      // fall back to the synthetic-grid estimate when the schedule isn't populated yet.
      const sd = sched?.scheduled_departures;
      const repStop = sched?.timing_point_stop_id != null ? String(sched.timing_point_stop_id) : null;
      if (sd && repStop) {
        const dayType = pickDayType(day);
        const schedMins = (Array.isArray(sd[dayType]) && sd[dayType].length) ? sd[dayType]
                        : (Array.isArray(sd.weekday) ? sd.weekday : []);
        const passMs = passingsByStop(rsamples).get(repStop) || [];
        otd = otdAgainstSchedule(passMs, schedMins);
      }
      if (otd == null) otd = estimateOtd(rsamples, Number.isFinite(sched?.headway_min) ? Number(sched.headway_min) : null);
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

// ── Self-test (no Supabase): `node build-reliability.js --selftest` ─────────────
// Proves the per-hour reconstruction matches TfL's headway-squared definition and,
// crucially, that a sampling hole spanning an hour boundary no longer inflates AWT.
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} — got ${got}`); } };
  const approx = (a, b, e = 0.01) => a != null && Math.abs(a - b) <= e;

  // 1) Regular headways: AWT = h/2 (10-min service → 5.0)
  ok('regular 10-min headways → AWT 5.0', approx(waitingTime([10, 10, 10, 10]), 5), waitingTime([10, 10, 10, 10]));
  // 2) Irregular headways inflate AWT above half the mean (passenger-weighted)
  ok('irregular [5,15] → AWT 6.25 (> mean/2=5)', approx(waitingTime([5, 15]), 6.25), waitingTime([5, 15]));

  // 3) THE FIX: 10-min service with a 40-min cross-hour sampling hole must read AWT≈5,
  //    not the ~10.5 the old whole-day diff produced.
  const mk = (iso, i) => ({ vehicle_id: `V${i}`, stop_id: 'S1', expected_at: iso });
  const samples = [];
  let i = 0;
  for (const m of ['00','10','20','30','40','50']) samples.push(mk(`2026-06-26T09:${m}:00Z`, i++)); // 09:00–09:50
  for (const m of ['30','40','50'])                samples.push(mk(`2026-06-26T10:${m}:00Z`, i++)); // 10:30–10:50 (40-min hole before)
  const { awt, observedBuses } = awtHourly(passingsByStop(samples));
  ok('per-hour AWT ignores the 40-min cross-hour hole (≈5.0)', approx(awt, 5, 0.2), awt);
  ok('observed buses counted (9)', observedBuses === 9, observedBuses);

  // 4) Outside service hours (e.g. 03:00) are excluded
  const night = [mk('2026-06-26T03:00:00Z', 100), mk('2026-06-26T03:10:00Z', 101)];
  ok('night passings excluded from AWT', awtHourly(passingsByStop(night)).awt == null, awtHourly(passingsByStop(night)).awt);

  // 5) Passing clustering: one vehicle sampled 3× while approaching (≤25 min) = ONE passing;
  //    the same vehicle on a later trip 3h on = a SECOND passing.
  const v = (iso) => ({ vehicle_id: 'VC', stop_id: 'S1', expected_at: iso });
  const clustered = passingsByStop([
    v('2026-06-26T09:00:00Z'), v('2026-06-26T09:03:00Z'), v('2026-06-26T09:05:00Z'), // approaching → 1
    v('2026-06-26T12:00:00Z'),                                                       // later trip → 1
  ]).get('S1') || [];
  ok('one vehicle → 2 distinct passings (approach cluster + later trip)', clustered.length === 2, clustered.length);

  // 6) Nearest-passing: within a cluster, the passing time is the MOST-CONVERGED prediction
  //    (smallest expected−recorded), not the earliest/furthest-out one.
  const s = (exp, rec) => ({ vehicle_id: 'VP', stop_id: 'S1', expected_at: exp, recorded_at: rec });
  const np = passingsByStop([
    s('2026-06-26T09:02:00Z', '2026-06-26T08:50:00Z'),  // tts 12 min
    s('2026-06-26T09:01:00Z', '2026-06-26T08:58:00Z'),  // tts 3 min
    s('2026-06-26T09:00:30Z', '2026-06-26T09:00:00Z'),  // tts 0.5 min ← should win
  ]).get('S1') || [];
  ok('nearest-passing picks the most-converged prediction',
    np.length === 1 && new Date(np[0]).toISOString() === '2026-06-26T09:00:30.000Z',
    np.map(t => new Date(t).toISOString()));

  // 8) Real-schedule OTD: 5 passings vs scheduled [08:00,08:20,08:40,09:00] → 4 on-time = 80%.
  const toMs = (t) => new Date(`2026-06-26T${t}:00Z`).getTime();   // 2026-06-26 = a Friday (weekday)
  const otdv = otdAgainstSchedule(
    ['08:01', '08:18', '08:23', '08:48', '09:00'].map(toMs),       // 08:48 nearest 08:40 = +8 late
    [480, 500, 520, 540],
  );
  ok('real-schedule OTD = 80% (4/5 within 2.5-early..5-late)', otdv === 80, otdv);

  console.log(`\nselftest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  selfTest();
} else {
  main().catch(err => {
    // Soft-fail: keep prior daily rows on a Supabase outage; next run rebuilds.
    console.warn(`build-reliability soft-failed: ${err.message}`);
    process.exit(0);
  });
}
