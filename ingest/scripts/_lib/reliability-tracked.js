/**
 * _lib/reliability-tracked.js — daily EWT / OTD from CONTINUOUS trip tracking
 * (pure logic, no I/O). The v2 of Atlas's reliability estimate.
 *
 * The v1 estimate (build-reliability.js, arrival_samples) polls Arrivals every
 * ~30 min, so it observes only slices of the day and reads EWT biased high
 * (audited 2026-08-10: mean ~2.6 min vs TfL's ~1.1, OTD ~48% vs ~80%+). The
 * continuous collector sees every vehicle every 25 s, so every trip's passing
 * time at the timing point is known — observed headways are COMPLETE within
 * feed-healthy windows, which removes the sampling bias by construction.
 *
 * Formulas (TfL QSI definitions, ingest/RELIABILITY-METHODOLOGY.md):
 *   SWT = Σ(hₛ²) / (2·Σhₛ)      over scheduled headways
 *   AWT = Σ(hₐ²) / (2·Σhₐ)      over observed headways
 *   EWT = AWT − SWT              (high-frequency routes)
 *   OTD = % departures −2…+5 min of schedule (low-frequency routes), with
 *         unmatched departures counted as non-arrivals (not on time)
 *
 * Honesty rules (same spirit as lost-mileage):
 *   - Headways are computed only WITHIN a feed-healthy segment — never across
 *     an unmeasured window (a gap caused by an outage is not a service gap).
 *   - Scheduled departures inside unmeasured windows are excluded from OTD.
 *   - Below MIN_HEADWAYS / MIN_DEPS the day's figure is null, not noise.
 */

export const OTD_EARLY_MIN = 2;    // dep more than 2 min early = not on time
export const OTD_LATE_MIN = 5;     // dep more than 5 min late  = not on time
export const OTD_MATCH_MIN = 20;   // beyond this a departure is a non-arrival
export const MIN_HEADWAYS = 5;     // fewer observed headways → no EWT for the day
export const MIN_DEPS = 5;         // fewer measured departures → no OTD for the day
export const SERVICE_BREAK_MIN = 90; // a scheduled gap ≥ this is a service break (e.g. the
                                     // overnight gap on a day route), NOT a waiting headway —
                                     // audited 2026-08-17: route 25's 00:38→04:45 break entered
                                     // Σh² as a 247-min headway and pushed SWT to 24.6 vs real ~4.7

const inWindows = (min, windows) => (windows || []).some((w) => min >= w.fromMin && min < w.toMin);

/** Split minute-of-day events into runs that never span an unmeasured window. */
function measuredRuns(minutes, windows) {
  const runs = [];
  let cur = null;
  const boundary = (a, b) => (windows || []).some((w) => a < w.fromMin && b >= w.fromMin);
  for (const m of [...minutes].sort((a, b) => a - b)) {
    if (inWindows(m, windows)) { cur = null; continue; }
    if (cur && !boundary(cur[cur.length - 1], m)) cur.push(m);
    else { cur = [m]; runs.push(cur); }
  }
  return runs;
}

/** Σh²/2Σh over consecutive gaps within each run. Returns { wait, n }. */
function excessWait(minutes, windows) {
  let sum = 0, sumSq = 0, n = 0;
  for (const run of measuredRuns(minutes, windows)) {
    for (let i = 1; i < run.length; i++) {
      const h = run[i] - run[i - 1];
      if (h <= 0) continue;
      sum += h; sumSq += h * h; n++;
    }
  }
  return { wait: sum > 0 ? sumSq / (2 * sum) : null, n };
}

/**
 * @param scheduled  { departuresMin:[…], serviceClass }  minutes-of-day at the timing point
 * @param passings   observed passing minutes at the same point (all tracked trips, one per trip)
 * @param unmeasured [{fromMin,toMin}] feed-unhealthy windows for the route's operator
 * @returns one day's estimate — high-freq fields (awt/swt/ewt) and low-freq fields
 *          (otd + breakdown) are both computed; the caller picks by serviceClass.
 */
export function computeTrackedReliability(scheduled, passings, unmeasured = []) {
  const deps = [...(scheduled.departuresMin || [])].sort((a, b) => a - b);
  const obs = [...(passings || [])].filter(Number.isFinite).sort((a, b) => a - b);

  // Service breaks — the SCHEDULE defines the operating periods. A scheduled gap
  // ≥ SERVICE_BREAK_MIN splits the day into segments for BOTH series, so neither
  // the scheduled overnight gap nor an observed gap spanning it counts as a
  // waiting headway (a passenger doesn't wait 4 h at midnight — service stopped).
  const breaks = [];
  for (let i = 1; i < deps.length; i++)
    if (deps[i] - deps[i - 1] >= SERVICE_BREAK_MIN) breaks.push({ fromMin: deps[i - 1] + 0.5, toMin: deps[i] - 0.5 });
  const splitWindows = [...(unmeasured || []), ...breaks];

  // ── high-frequency: waits from headways; unmeasured windows and service
  //    breaks never spanned ──
  const sw = excessWait(deps, splitWindows);
  const aw = excessWait(obs, splitWindows);
  const enough = sw.n >= MIN_HEADWAYS && aw.n >= MIN_HEADWAYS;
  const swt = enough ? +sw.wait.toFixed(2) : null;
  const awt = enough ? +aw.wait.toFixed(2) : null;
  const ewt = enough ? +(aw.wait - sw.wait).toFixed(2) : null;

  // ── low-frequency: per-departure greedy match (nearest unclaimed passing) ──
  const measuredDeps = deps.filter((m) => !inWindows(m, unmeasured));
  const claimed = new Set();
  let onTime = 0, early = 0, late = 0, nonArrival = 0;
  for (const dep of measuredDeps) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < obs.length; i++) {
      if (claimed.has(i)) continue;
      const d = Math.abs(obs[i] - dep);
      if (d < bestD) { bestD = d; bestI = i; }
      if (obs[i] - dep > OTD_MATCH_MIN) break;   // sorted — nothing closer ahead
    }
    if (bestI < 0 || bestD > OTD_MATCH_MIN) { nonArrival++; continue; }
    claimed.add(bestI);
    const delta = obs[bestI] - dep;               // + = late
    if (delta < -OTD_EARLY_MIN) early++;
    else if (delta > OTD_LATE_MIN) late++;
    else onTime++;
  }
  const otd = measuredDeps.length >= MIN_DEPS ? +(onTime / measuredDeps.length * 100).toFixed(1) : null;

  return {
    swt_minutes: swt, awt_minutes: awt, ewt_minutes: ewt,
    scheduled_headways: sw.n, observed_headways: aw.n,
    otd_percent: otd,
    deps_measured: measuredDeps.length,
    on_time: onTime, early, late, non_arrival: nonArrival,
    passings_observed: obs.length,
  };
}
