/**
 * test-reliability-tracked.js — unit validation of the tracked EWT/OTD core
 * (_lib/reliability-tracked.js) against hand-computed QSI references.
 * Run any time:  npm run test-reliability-tracked
 *
 * Honesty-critical cases covered: outage windows never span headways, never
 * count as non-arrivals; perfect service reads EWT 0 / OTD 100; thin days
 * return null rather than noise.
 */
import { computeTrackedReliability, OTD_MATCH_MIN, MIN_HEADWAYS, SERVICE_BREAK_MIN } from './_lib/reliability-tracked.js';
import { estimatePassingMin } from './_lib/lost-mileage.js';
import { journeysFor, scheduleCoverage } from './_lib/schedule-pick.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const range = (from, to, step) => { const out = []; for (let m = from; m <= to; m += step) out.push(m); return out; };

console.log('\ncomputeTrackedReliability — high-frequency (EWT)');
{
  // perfect service: observed exactly as scheduled, every 10 min 06:00–22:00
  const deps = range(360, 1320, 10);
  const r = computeTrackedReliability({ departuresMin: deps }, deps, []);
  // SWT of uniform 10-min headways = Σh²/2Σh = 10/2 = 5
  ok('uniform 10-min schedule → SWT 5.0', r.swt_minutes === 5, `${r.swt_minutes}`);
  ok('perfect service → EWT 0', r.ewt_minutes === 0, `${r.ewt_minutes}`);
  ok('headway counts reported', r.scheduled_headways === deps.length - 1 && r.observed_headways === deps.length - 1);

  // bunching: same vehicle count but alternating 5/15-min observed gaps.
  // AWT = (Σh²)/(2Σh) per pair = (25+225)/(2·20) = 6.25 → EWT = 1.25
  const bunched = [];
  for (let m = 360; m < 1320; m += 20) { bunched.push(m, m + 15); }
  bunched.push(1320);
  const r2 = computeTrackedReliability({ departuresMin: deps }, bunched, []);
  ok('alternating 15/5 bunching → AWT 6.25', approx(r2.awt_minutes, 6.25, 0.01), `${r2.awt_minutes}`);
  ok('bunching EWT = AWT − SWT = 1.25', approx(r2.ewt_minutes, 1.25, 0.01), `${r2.ewt_minutes}`);

  // missing every 4th bus: headways 10,10,20 repeating.
  // AWT = (100+100+400)/(2·40) = 7.5 → EWT 2.5
  const gappy = deps.filter((_, i) => i % 4 !== 3);
  const r3 = computeTrackedReliability({ departuresMin: deps }, gappy, []);
  ok('every 4th bus missing → EWT 2.5', approx(r3.ewt_minutes, 2.5, 0.05), `${r3.ewt_minutes}`);

  // an outage window must not turn a feed gap into a service gap: observed
  // vanishes 10:00–11:00 (outage declared) — headways never span the window.
  const win = [{ fromMin: 600, toMin: 660 }];
  const obs4 = deps.filter((m) => m < 600 || m >= 660);
  const r4 = computeTrackedReliability({ departuresMin: deps }, obs4, win);
  ok('outage hour excluded → EWT stays 0', r4.ewt_minutes === 0, `${r4.ewt_minutes}`);
  const rBad = computeTrackedReliability({ departuresMin: deps }, obs4, []);
  ok('(control) same gap WITHOUT the window reads as real bunching', rBad.ewt_minutes > 0.5, `${rBad.ewt_minutes}`);

  // thin day: below MIN_HEADWAYS → null, not noise
  const r5 = computeTrackedReliability({ departuresMin: [480, 490, 500] }, [481, 492], []);
  ok(`fewer than ${MIN_HEADWAYS} headways → nulls`, r5.ewt_minutes === null && r5.swt_minutes === null);
}

console.log('\ncomputeTrackedReliability — low-frequency (OTD)');
{
  // hourly service 06:00–20:00 (15 departures), all observed exactly on time
  const deps = range(360, 1200, 60);
  const r = computeTrackedReliability({ departuresMin: deps }, deps, []);
  ok('all on time → OTD 100', r.otd_percent === 100, `${r.otd_percent}`);
  ok('breakdown: all counted on_time', r.on_time === 15 && r.early === 0 && r.late === 0 && r.non_arrival === 0);

  // 3 late (+8 min), 2 early (−4 min), 1 missing, rest on time
  const obs = deps.map((m, i) => (i < 3 ? m + 8 : i < 5 ? m - 4 : m)).filter((_, i) => i !== 14);
  const r2 = computeTrackedReliability({ departuresMin: deps }, obs, []);
  ok('9 of 15 on time → OTD 60.0', r2.otd_percent === 60, `${r2.otd_percent}`);
  ok('breakdown: 3 late · 2 early · 1 non-arrival', r2.late === 3 && r2.early === 2 && r2.non_arrival === 1, JSON.stringify(r2));

  // boundary: exactly −2 and +5 are ON time (inclusive)
  const r3 = computeTrackedReliability({ departuresMin: deps }, deps.map((m, i) => (i % 2 ? m + 5 : m - 2)), []);
  ok('−2 and +5 min boundaries count on time', r3.otd_percent === 100, `${r3.otd_percent}`);

  // a departure inside an outage window is unmeasured, not a non-arrival
  const win = [{ fromMin: 700, toMin: 750 }];   // swallows only the 720 departure
  const obs4 = deps.filter((m) => m !== 720);
  const r4 = computeTrackedReliability({ departuresMin: deps }, obs4, win);
  ok('departure inside outage → excluded, OTD 100', r4.otd_percent === 100 && r4.non_arrival === 0 && r4.deps_measured === 14, `measured=${r4.deps_measured}`);
  const rBad = computeTrackedReliability({ departuresMin: deps }, obs4, []);
  ok('(control) same miss WITHOUT the window is a non-arrival', rBad.non_arrival === 1);

  // greedy matching can't double-claim one observed passing
  const r5 = computeTrackedReliability({ departuresMin: [600, 610], departures: 2 }, [604], []);
  ok('one passing cannot serve two departures', r5.on_time + r5.early + r5.late === 1 && r5.non_arrival === 1);

  // beyond OTD_MATCH_MIN a passing is not a match
  const r6 = computeTrackedReliability({ departuresMin: range(360, 1200, 60) }, range(360, 1200, 60).map((m) => m + OTD_MATCH_MIN + 5), []);
  ok(`passings ${OTD_MATCH_MIN + 5} min off → all non-arrivals`, r6.non_arrival === 15, `${r6.non_arrival}`);

  // thin day → null
  const r7 = computeTrackedReliability({ departuresMin: [480, 600, 720] }, [481, 601, 721], []);
  ok('fewer than 5 departures → OTD null', r7.otd_percent === null);
}

console.log('\nend-to-end: trip log → passing times → EWT (the builder chain)');
{
  // synthetic day: a 12-km route, timing point at 4 km, buses every 10 min from
  // 06:00, each trip pinged with a waypoint trail (18 km/h ⇒ passes 4 km at
  // start + ~13.3 min). Perfect service, so tracked EWT must read 0.
  const day0 = Date.parse('2026-08-12T00:00:00Z');
  const mkTrip = (startMin) => ({
    startAt: new Date(day0 + startMin * 60000).toISOString(),
    endAt: new Date(day0 + (startMin + 40) * 60000).toISOString(),
    startKm: 0, endKm: 12, kmObserved: 12, routeLenKm: 12, coverage: 1,
    wp: Array.from({ length: 17 }, (_, i) => [i * 2.5, +(i * 2.5 * 0.3).toFixed(2)]),  // 18 km/h
  });
  const deps = range(360, 1200, 10).map((m) => m + 13);   // timetable at the timing point
  const trips = range(360, 1200, 10).map((m) => mkTrip(m));
  const passings = trips.map((t) => estimatePassingMin(t, 4, day0));
  ok('passing times land at start + ~13 min (waypoint pace)', passings.every((p, i) => Math.abs(p - (360 + i * 10 + 13.3)) <= 1), `first=${passings[0]}`);
  const r = computeTrackedReliability({ departuresMin: deps }, passings, []);
  ok('perfect synthetic day → tracked EWT 0.0', r.ewt_minutes === 0 && r.swt_minutes === 5, `ewt=${r.ewt_minutes} swt=${r.swt_minutes}`);
  // drop every 5th trip → real gaps appear (headways repeat 10,10,10,20:
  // AWT = Σh²/2Σh = 700/100 = 7.0 → EWT = 2.0)
  const gappy = passings.filter((_, i) => i % 5 !== 4);
  const r2 = computeTrackedReliability({ departuresMin: deps }, gappy, []);
  ok('every 5th trip missing → EWT ≈ 2.0', approx(r2.ewt_minutes, 2.0, 0.15), `${r2.ewt_minutes}`);
}

console.log('\nservice breaks — the overnight gap is not a headway (route-25 audit, 2026-08-17)');
{
  // day route with an overnight break: every 10 min 04:45–00:38 next day is
  // modelled as 08→38 then 285→1438 (the real route 25 shape). The 247-min
  // scheduled gap must be treated as a service break, not a waiting headway.
  const deps = [...range(8, 38, 10), ...range(285, 1438, 10)];
  const obs = deps.map((m) => m);                       // perfect service
  const r = computeTrackedReliability({ departuresMin: deps }, obs, []);
  ok('overnight break excluded → SWT is the uniform 5.0, not ~25', r.swt_minutes === 5, `${r.swt_minutes}`);
  ok('perfect service across a break → EWT 0', r.ewt_minutes === 0, `${r.ewt_minutes}`);
  // an observed gap spanning the break must not count either: bus at 00:38 then next at 04:45
  ok(`break threshold is ${SERVICE_BREAK_MIN} min`, SERVICE_BREAK_MIN === 90);
  const rLate = computeTrackedReliability({ departuresMin: deps }, obs.filter((m) => m !== 38), []);
  ok('last-before-break bus missing → its headway loss stays local (EWT small)', rLate.ewt_minutes < 0.2, `${rLate.ewt_minutes}`);
  // control: a legitimate 60-min low-frequency headway still counts
  const hourly = range(360, 1200, 60);
  const rHr = computeTrackedReliability({ departuresMin: hourly }, hourly, []);
  ok('hourly service (60-min gaps) still yields SWT 30', rHr.swt_minutes === 30, `${rHr.swt_minutes}`);
}

console.log('\nschedule-pick — one representative schedule per day-type, never a concatenation');
{
  const j = (times) => times.map((m) => ({ hour: String(Math.floor(m / 60)), minute: String(m % 60) }));
  const tt = { timetable: { routes: [{ schedules: [
    { name: 'Monday to Thursday', knownJourneys: j([480, 490, 500]) },
    { name: 'Friday',             knownJourneys: j([480, 490, 500]) },
    { name: 'Saturday',           knownJourneys: j([485, 495]) },
  ] }] } };
  const wk = journeysFor(tt, 'weekday');
  ok('Mon–Thu + Friday do NOT concatenate (3 deps, not 6)', wk.length === 3, `${wk.length}`);
  ok('Mon–Thu (4-day coverage) beats Friday (1-day)', scheduleCoverage('Monday to Thursday') > scheduleCoverage('Friday'));
  ok('saturday unaffected', journeysFor(tt, 'saturday').length === 2);
  // after-midnight wrap: hour 24 → minute-of-day 0..59
  const ttN = { timetable: { routes: [{ schedules: [{ name: 'Monday to Friday', knownJourneys: j([]).concat([{ hour: '24', minute: '15' }, { hour: '5', minute: '0' }]) }] }] } };
  ok('hour 24 wraps to 15 past midnight', journeysFor(ttN, 'weekday')[0] === 15);
}

console.log(`\n${'='.repeat(48)}\ntest-reliability-tracked: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
