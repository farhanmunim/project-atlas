/**
 * test-lost-mileage.js — unit validation of the lost-mileage cores (pure logic,
 * no network, no warehouse). Run any time:  npm run test-lost-mileage
 *
 * Covers the trip state machine (_lib/trip-tracker.js) and the daily matcher
 * (_lib/lost-mileage.js) against hand-computed expectations, including the
 * honesty-critical cases: feed outages must read UNMEASURED (never lost),
 * stale pings must not advance trips, dead runs must not open them.
 */
import { TripTracker, projectOnto } from './_lib/trip-tracker.js';
import { computeLostMileage, estimatePassingMin, unhealthyWindows, median, TOLERANCE_MIN } from './_lib/lost-mileage.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// A straight ~11.1 km west→east test route at lat 51.5 (0.16° lng ≈ 11.1 km).
const LINE = Array.from({ length: 17 }, (_, i) => [i * 0.01, 51.5]);
const GEO = { '25': { '1': LINE, '2': [...LINE].reverse() } };
const T0 = Date.parse('2026-08-10T08:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const veh = (reg, lngDeg, min, extra = {}) => ({ reg, publishedLine: '25', direction: '1', lat: 51.5, lng: lngDeg, recordedAt: iso(min), ...extra });

console.log('\n_lib/trip-tracker.js');
{
  const p = projectOnto(LINE, 0.08, 51.5);
  ok('projection: midpoint → ~half the length, on-route', approx(p.alongKm, 5.56, 0.1) && p.offM < 1, `along ${p.alongKm.toFixed(2)} km, off ${p.offM.toFixed(1)} m`);
  const off = projectOnto(LINE, 0.08, 51.51);
  ok('projection: 1.1 km north → offM ≈ 1100', approx(off.offM, 1112, 30), `${off.offM.toFixed(0)} m`);

  // full run west→east over 40 min, then vehicle vanishes → gap-close
  const tr = new TripTracker(GEO);
  let done = [];
  for (let i = 0; i <= 16; i++) done.push(...tr.update([veh('V1', i * 0.01, i * 2.5)], T0 + i * 2.5 * 60000));
  ok('trip stays open while progressing', done.length === 0);
  done = tr.update([], T0 + 55 * 60000);   // 15 min silent > GAP
  ok('gap closes the trip', done.length === 1, done[0] && `closed=${done[0].closed}`);
  const t = done[0];
  ok('trip record: full coverage, sane km', t && approx(t.kmObserved, 11.1, 0.2) && t.coverage > 0.95, t && `km=${t.kmObserved} cov=${t.coverage}`);
  ok('trip record: route/dir/reg carried', t && t.route === '25' && t.dir === '1' && t.reg === 'V1');

  // direction change closes + reopens
  const tr2 = new TripTracker(GEO);
  for (let i = 0; i <= 10; i++) tr2.update([veh('V2', i * 0.01, i * 3)], T0 + i * 3 * 60000);
  const d2 = tr2.update([veh('V2', 0.10, 31, { direction: '2' })], T0 + 31 * 60000);
  ok('direction flip closes the outbound trip', d2.length === 1 && d2[0].dir === '1', d2[0] && `km=${d2[0].kmObserved}`);

  // stale recordedAt must not advance the trip
  const tr3 = new TripTracker(GEO);
  tr3.update([veh('V3', 0.00, 0)], T0);
  for (let i = 1; i <= 10; i++) tr3.update([veh('V3', 0.10, 0)], T0 + i * 60000);   // same recordedAt
  const d3 = tr3.update([], T0 + 20 * 60000 + 10 * 60000 + 1);
  ok('stale pings ignored → trip too short → filtered', d3.length === 0);

  // sustained off-route (dead run) closes without junk
  const tr4 = new TripTracker(GEO);
  for (let i = 0; i <= 8; i++) tr4.update([veh('V4', i * 0.01, i * 2)], T0 + i * 2 * 60000);
  let d4 = [];
  for (let i = 0; i < 5; i++) d4.push(...tr4.update([veh('V4', 0.08, 17 + i, { lat: 51.53 })], T0 + (17 + i) * 60000));
  ok('sustained off-route closes the trip (dead run)', d4.length === 1 && d4[0].closed === 'off-route', d4[0] && `km=${d4[0].kmObserved}`);

  // sub-threshold noise never becomes a trip
  const tr5 = new TripTracker(GEO);
  tr5.update([veh('V5', 0.00, 0)], T0);
  tr5.update([veh('V5', 0.002, 2)], T0 + 2 * 60000);
  ok('2-minute 200 m shuffle filtered', tr5.flush().length === 0);
}

console.log('\n_lib/lost-mileage.js');
{
  const day0 = Date.parse('2026-08-10T00:00:00Z');
  // trips matched at timing-point along-km 0 in these tests (passing = departure);
  // estimatePassingMin itself is exercised separately below.
  const trip = (startMin, startKm, endKm, lenKm = 11.1) => {
    const t = {
      startAt: new Date(day0 + startMin * 60000).toISOString(),
      endAt: new Date(day0 + (startMin + 40) * 60000).toISOString(),
      startKm, endKm, kmObserved: endKm - startKm, routeLenKm: lenKm,
      coverage: +((endKm - startKm) / lenKm).toFixed(3),
    };
    t.passMin = estimatePassingMin(t, 0, day0);
    return t;
  };

  // passing-time estimation: a 40-min full run 0→11.1 km starting minute 480
  const full = trip(480, 0, 11.1);
  ok('passing @ start of span → start time', approx(estimatePassingMin(full, 0, day0), 480, 1));
  ok('passing @ mid-span → linear interpolation (~+20 min)', approx(estimatePassingMin(full, 5.55, day0), 500, 2), `${estimatePassingMin(full, 5.55, day0)}`);
  ok('passing @ end of span → end time', approx(estimatePassingMin(full, 11.1, day0), 520, 2));
  const midCaught = { ...trip(500, 5.55, 11.1) };   // caught halfway; observed speed ≈ 8.3 km/h → clamped → fallback 17
  ok('timing point BEFORE observed span → extrapolates earlier', estimatePassingMin(midCaught, 0, day0) < 500, `${estimatePassingMin(midCaught, 0, day0)}`);
  const curt = trip(480, 0, 5.0);                    // curtailed before a timing point at 8 km
  ok('timing point beyond curtailment → projected finite minute', Number.isFinite(estimatePassingMin(curt, 8, day0)));

  // 3 scheduled trips, 2 ran (full), 1 missing — no outages
  const sched = { departuresMin: [480, 540, 600], tripsCount: 3, km: 33.3, lenKm: 11.1 };
  const r1 = computeLostMileage(sched, [trip(481, 0, 11.1), trip(602, 0, 11.1)], [], day0);
  ok('2 of 3 matched, 1 lost', r1.matched_trips === 2 && r1.lost_trips === 1, JSON.stringify(r1));
  ok('lost_km = one trip length', approx(r1.lost_km_est, 11.1, 0.2), `${r1.lost_km_est}`);
  ok('lost_pct ≈ 33%', approx(r1.lost_pct, 33.3, 1), `${r1.lost_pct}%`);

  // the honesty rule: an outage window over the missing trip → unmeasured, NOT lost
  const r2 = computeLostMileage(sched, [trip(481, 0, 11.1), trip(602, 0, 11.1)], [{ fromMin: 520, toMin: 580 }], day0);
  ok('outage → unmeasured 1, lost 0', r2.lost_trips === 0 && r2.unmeasured_trips === 1, JSON.stringify({ lost: r2.lost_trips, unm: r2.unmeasured_trips }));
  ok('unmeasured km excluded from the denominator', r2.lost_pct === 0, `lost_pct=${r2.lost_pct}`);

  // curtailment: matched but stopped at 60% of the route
  const r3 = computeLostMileage(sched, [trip(481, 0, 6.7), trip(541, 0, 11.1), trip(601, 0, 11.1)], [], day0);
  ok('curtailed trip counted matched + partial km', r3.matched_trips === 3 && r3.curtailed_trips === 1 && r3.operated_km_est < 33.3, `op=${r3.operated_km_est}`);

  // matching respects tolerance — a trip 30 min off matches nothing
  const r4 = computeLostMileage(sched, [trip(480 + TOLERANCE_MIN + 20, 0, 11.1)], [], day0);
  ok(`observed trip ${TOLERANCE_MIN + 20} min off matches nothing`, r4.matched_trips === 0 && r4.lost_trips === 3);

  // proration: timetable knows 2 departure times but 4 scheduled trips
  const r5 = computeLostMileage({ departuresMin: [480, 540], tripsCount: 4, km: 44.4, lenKm: 11.1 }, [trip(481, 0, 11.1)], [], day0);
  ok('partial timetable prorates losses (1 of 2 known lost → 2 of 4)', r5.lost_trips === 2 && approx(r5.lost_km_est, 22.2, 0.3), JSON.stringify({ lost: r5.lost_trips, km: r5.lost_km_est }));

  // feed-health windows
  const medBy = { 8: 100, 9: 100, 10: 100 };
  const w = unhealthyWindows({ 8: 100, 9: 30, 10: 20 }, medBy);
  ok('hours below 40% of median → merged unmeasured window 09:00–11:00', w.length === 1 && w[0].fromMin === 540 && w[0].toMin === 660, JSON.stringify(w));
  ok('healthy hours produce no windows', unhealthyWindows({ 8: 90, 9: 80, 10: 75 }, medBy).length === 0);
  ok('an hour with a median but ZERO observed vehicles IS an outage', unhealthyWindows({ 8: 90, 9: 80 }, medBy).length === 1);
  ok('tiny fleets (median <5) never flag', unhealthyWindows({ 8: 0 }, { 8: 3 }).length === 0);
  ok('median helper', median([3, 1, 2]) === 2 && median([]) === 0 && median([4, 1, 3, 2]) === 2.5);
}

console.log(`\n${'='.repeat(48)}\ntest-lost-mileage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
