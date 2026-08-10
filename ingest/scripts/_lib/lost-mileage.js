/**
 * _lib/lost-mileage.js — daily gross lost-mileage computation (pure logic).
 *
 * Inputs: the day's scheduled side (departure minutes + km from route_schedule),
 * the tracker's observed trips for the route, and the day's UNMEASURED windows
 * (hours where the operator's feed was unhealthy). Output: one warehouse row.
 *
 * Matching: route_schedule's departure minutes are measured at the route's
 * TIMING POINT (a mid-route stop), so each observed trip's passing time at
 * that stop's along-km is estimated from the trip's own timing (linear
 * interpolation within the observed span, speed-clamped extrapolation
 * outside it), then greedily matched to the nearest unclaimed scheduled
 * minute within TOLERANCE_MIN. Scheduled departures inside unmeasured
 * windows are excluded from loss accounting entirely — an outage must read
 * as "unknown", never as "lost".
 *
 * Operated km per matched trip: the full route length when the trip covered
 * ≥ CURTAIL_COVERAGE of it, else its observed max-along (a curtailment).
 * Gross by construction: causes are invisible externally.
 */

export const TOLERANCE_MIN = 12;
export const CURTAIL_COVERAGE = 0.85;
const SPEED_MIN = 5, SPEED_MAX = 40, SPEED_FALLBACK = 17;   // km/h

/** Minute-of-day the trip passed (or projects to pass) `alongKm` — linear on the
 *  trip's own observed timing inside [startKm,endKm], speed-clamped outside. */
export function estimatePassingMin(trip, alongKm, dayStartMs) {
  const t0 = Date.parse(trip.startAt), t1 = Date.parse(trip.endAt);
  const k0 = trip.startKm, k1 = Math.max(trip.endKm, k0 + 0.01);
  const durH = Math.max(1 / 60, (t1 - t0) / 3600000);
  let speed = (k1 - k0) / durH;
  if (!Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX) speed = SPEED_FALLBACK;
  const passMs = t0 + ((alongKm - k0) / speed) * 3600000;
  return Math.round((passMs - dayStartMs) / 60000);
}

const inWindows = (min, windows) => (windows || []).some((w) => min >= w.fromMin && min < w.toMin);

/**
 * @param scheduled  { departuresMin:[…], tripsCount, km, lenKm }  (departuresMin may be fewer than
 *                   tripsCount when the timetable carries only the timing point's departures —
 *                   trips without a known departure time are prorated)
 * @param trips      tracker records for this route+day, each pre-annotated with `passMin`
 *                   (estimatePassingMin at the route's timing-point along-km)
 * @param unmeasured [{fromMin,toMin}] feed-unhealthy windows (minutes of day)
 * @param dayStartMs epoch ms of this day's 00:00 UTC (kept for symmetry/logging)
 */
export function computeLostMileage(scheduled, trips, unmeasured, dayStartMs) {
  const deps = [...(scheduled.departuresMin || [])].sort((a, b) => a - b);
  const lenKm = scheduled.lenKm || (scheduled.tripsCount ? scheduled.km / scheduled.tripsCount : null);

  // observed trips by timing-point passing minute, earliest first
  const obs = (trips || []).map((t) => ({ t, dep: t.passMin })).filter((x) => Number.isFinite(x.dep)).sort((a, b) => a.dep - b.dep);

  const claimed = new Set();
  let matched = 0, curtailed = 0, operatedKm = 0;
  for (const { t, dep } of obs) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < deps.length; i++) {
      if (claimed.has(i)) continue;
      const d = Math.abs(deps[i] - dep);
      if (d < bestD) { bestD = d; bestI = i; }
      if (deps[i] - dep > TOLERANCE_MIN) break;   // sorted — nothing closer ahead
    }
    if (bestI < 0 || bestD > TOLERANCE_MIN) continue;
    claimed.add(bestI);
    matched++;
    if (t.coverage != null && t.coverage < CURTAIL_COVERAGE) { curtailed++; operatedKm += t.endKm; }
    else operatedKm += (t.routeLenKm ?? lenKm ?? t.kmObserved);
  }

  const unmeasuredDeps = deps.filter((m) => inWindows(m, unmeasured)).length;
  const lostDeps = deps.filter((m, i) => !claimed.has(i) && !inWindows(m, unmeasured)).length;

  // departures we know times for vs total scheduled trips: prorate the remainder
  // by the measured loss rate so partial timetable detail can't inflate losses.
  const knownDeps = deps.length || 1;
  const scale = (scheduled.tripsCount || deps.length) / knownDeps;
  const perTripKm = lenKm ?? (scheduled.km && scheduled.tripsCount ? scheduled.km / scheduled.tripsCount : 0);

  const measuredScheduledTrips = Math.round((deps.length - unmeasuredDeps) * scale);
  const lostTrips = Math.round(lostDeps * scale);
  const unmeasuredTrips = Math.round(unmeasuredDeps * scale);
  const scheduledKm = scheduled.km ?? +(deps.length * scale * perTripKm).toFixed(1);
  const unmeasuredKm = +(unmeasuredTrips * perTripKm).toFixed(1);
  const lostKm = +Math.max(0, Math.min(lostTrips * perTripKm, scheduledKm - unmeasuredKm)).toFixed(1);
  const measuredKm = Math.max(0, scheduledKm - unmeasuredKm);

  return {
    scheduled_trips: scheduled.tripsCount ?? deps.length,
    measured_scheduled_trips: measuredScheduledTrips,
    observed_trips: obs.length,
    matched_trips: matched,
    lost_trips: lostTrips,
    curtailed_trips: curtailed,
    scheduled_km: +scheduledKm.toFixed(1),
    operated_km_est: +Math.min(operatedKm * scale, measuredKm || operatedKm * scale).toFixed(1),
    lost_km_est: lostKm,
    lost_pct: measuredKm > 0 ? +(lostKm / measuredKm * 100).toFixed(1) : null,
    unmeasured_trips: unmeasuredTrips,
    unmeasured_km: unmeasuredKm,
  };
}

/** Feed-health windows: per-operator hourly vehicle counts vs that operator's
 *  14-day median for the same hour. Below `floor` (default 40%) ⇒ unmeasured.
 *  counts/history: { [hour 0-23]: n } / { [hour]: [n,…] } */
export function unhealthyWindows(counts, medianByHour, { floor = 0.4 } = {}) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const med = medianByHour?.[h] ?? 0;
    if (med >= 5 && (counts?.[h] ?? 0) < med * floor) out.push({ fromMin: h * 60, toMin: (h + 1) * 60 });
  }
  // merge adjacent hours
  const merged = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && last.toMin === w.fromMin) last.toMin = w.toMin; else merged.push({ ...w });
  }
  return merged;
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : 0; };
