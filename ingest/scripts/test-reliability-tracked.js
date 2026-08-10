/**
 * test-reliability-tracked.js — unit validation of the tracked EWT/OTD core
 * (_lib/reliability-tracked.js) against hand-computed QSI references.
 * Run any time:  npm run test-reliability-tracked
 *
 * Honesty-critical cases covered: outage windows never span headways, never
 * count as non-arrivals; perfect service reads EWT 0 / OTD 100; thin days
 * return null rather than noise.
 */
import { computeTrackedReliability, OTD_MATCH_MIN, MIN_HEADWAYS } from './_lib/reliability-tracked.js';

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

console.log(`\n${'='.repeat(48)}\ntest-reliability-tracked: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
