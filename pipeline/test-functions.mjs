/**
 * test-functions.mjs — unit validation of Atlas's custom functions against
 * INDEPENDENT reference implementations and hand-computed expectations (per
 * CLAUDE.md "Validation (always)": don't trust a function because it ran —
 * cross-check its output). Dependency-free; run any time:
 *
 *   node pipeline/test-functions.mjs
 *
 * Covers: lib/tfl-status.js (validity-window logic incl. the W12 isNow
 * regression), build/diversions.js geometry (distToLineM vs haversine,
 * deviatingSegments thresholds), lib/geo.js (lengthKm vs an independent
 * haversine, simplify invariants), lib/normalize.js (make/propulsion/operator
 * canonicalisation against known DVLA strings).
 */
import { windowActiveNow, windowBounds } from "./lib/tfl-status.js";
import { distToLineM, deviatingSegments } from "./build/diversions.js";
import { lengthKm, simplify, round } from "./lib/geo.js";
import { cleanMake, propulsionOf, canonicalOperator, reconcilePropulsion } from "./lib/normalize.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// Independent haversine (metres) — the reference the geometry functions are judged against.
const havM = ([lng1, lat1], [lng2, lat2]) => {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

console.log("\nlib/tfl-status.js — validity windows");
{
  const now = Date.parse("2026-08-05T12:00:00Z");
  ok("no window ⇒ active", windowActiveNow([], now) && windowActiveNow(null, now));
  ok("isNow=true ⇒ active", windowActiveNow([{ isNow: true, fromDate: "2030-01-01T00:00:00Z", toDate: "2030-02-01T00:00:00Z" }], now));
  // THE W12 REGRESSION: in-progress works published with isNow=false but dates bracketing now
  ok("isNow=false + dates covering now ⇒ active (W12 case)",
    windowActiveNow([{ isNow: false, fromDate: "2026-07-20T07:00:00Z", toDate: "2026-11-30T22:00:00Z" }], now));
  ok("future window ⇒ NOT active", !windowActiveNow([{ isNow: false, fromDate: "2026-09-01T00:00:00Z", toDate: "2026-09-10T00:00:00Z" }], now));
  ok("past window ⇒ NOT active", !windowActiveNow([{ isNow: false, fromDate: "2026-01-01T00:00:00Z", toDate: "2026-02-01T00:00:00Z" }], now));
  ok("open-ended from (no toDate) covering now ⇒ active", windowActiveNow([{ fromDate: "2026-07-01T00:00:00Z" }], now));
  ok("any-of-many windows active ⇒ active", windowActiveNow([
    { isNow: false, fromDate: "2026-01-01T00:00:00Z", toDate: "2026-02-01T00:00:00Z" },
    { isNow: false, fromDate: "2026-08-01T00:00:00Z", toDate: "2026-08-10T00:00:00Z" }], now));
  const b = windowBounds([{ fromDate: "2026-08-01T00:00:00Z", toDate: "2026-08-10T00:00:00Z" }, { fromDate: "2026-07-20T07:00:00Z", toDate: "2026-11-30T22:00:00Z" }]);
  ok("windowBounds = earliest from / latest to", b.from === "2026-07-20T07:00:00.000Z" && b.to === "2026-11-30T22:00:00.000Z", `${b.from} → ${b.to}`);
}

console.log("\nbuild/diversions.js — distToLineM (vs independent haversine)");
{
  // a north–south line through Charing Cross; test point due east of its midpoint
  const line = [[-0.1278, 51.4874], [-0.1278, 51.5274]];
  const p = [-0.1204, 51.5074];   // ~0.0074° east at lat 51.5
  const expected = havM([-0.1278, 51.5074], p);   // perpendicular hit is at the same latitude
  const got = distToLineM(p, line);
  ok("perpendicular distance ≈ haversine", approx(got, expected, expected * 0.005), `${got.toFixed(1)}m vs ${expected.toFixed(1)}m (±0.5%)`);
  const beyond = [-0.1278, 51.54];                 // north of the segment end → clamps to endpoint
  ok("clamps to segment endpoint", approx(distToLineM(beyond, line), havM([-0.1278, 51.5274], beyond), 5),
    `${distToLineM(beyond, line).toFixed(1)}m vs ${havM([-0.1278, 51.5274], beyond).toFixed(1)}m`);
  ok("point on the line ⇒ ~0", distToLineM([-0.1278, 51.5], line) < 1, `${distToLineM([-0.1278, 51.5], line).toFixed(2)}m`);
}

console.log("\nbuild/diversions.js — deviatingSegments thresholds");
{
  // baseline: straight west→east line at lat 51.5; ~0.0143° lng ≈ 1 km steps
  const step = 0.0143;
  const base = Array.from({ length: 11 }, (_, i) => [i * step, 51.5]);
  // current: same line but points 4–6 shifted 0.002° lat (~222 m) north over ~2 km span
  const bump = base.map(([x, y], i) => (i >= 4 && i <= 6 ? [x, y + 0.002] : [x, y]));
  const segs = deviatingSegments(bump, base);
  ok("~222 m deviation over 2 km ⇒ 1 segment", segs.length === 1, `${segs.length} segment(s)`);
  ok("segment extended one point each side (5 deviating+2)", segs.length === 1 && segs[0].length === 5, `${segs[0]?.length} pts`);
  // sub-threshold: 0.0005° (~55 m) — inside simplification noise, must NOT fire
  const small = base.map(([x, y], i) => (i >= 4 && i <= 6 ? [x, y + 0.0005] : [x, y]));
  ok("~55 m deviation ⇒ no segments (below 75 m threshold)", deviatingSegments(small, base).length === 0);
  // one-point spike >75 m but < MIN_SPAN_M total length after ±1 extension is ~2 km… so use
  // a tight spike: single point 100 m off between two on-line neighbours 50 m apart
  const tight = [[0, 51.5], [0.0004, 51.5], [0.0007, 51.5009], [0.001, 51.5], [0.0014, 51.5]];
  const tightBase = [[0, 51.5], [0.0014, 51.5]];
  ok("short spike (<150 m span) ⇒ filtered as noise", deviatingSegments(tight, tightBase).length === 0);
  ok("identical lines ⇒ no segments", deviatingSegments(base, base).length === 0);
}

console.log("\nlib/geo.js — lengthKm & simplify (vs independent haversine)");
{
  const line = [[-0.1278, 51.5074], [-0.1278, 51.5174], [-0.1178, 51.5174]];
  const expected = (havM(line[0], line[1]) + havM(line[1], line[2])) / 1000;
  ok("lengthKm ≈ independent haversine", approx(lengthKm(line), expected, expected * 0.001), `${lengthKm(line).toFixed(4)} vs ${expected.toFixed(4)} km`);
  const dense = Array.from({ length: 101 }, (_, i) => [i * 0.0001, 51.5]);   // straight, 100 pts
  const simp = simplify(dense, 0.0005);
  ok("simplify collapses a straight line to its endpoints", simp.length === 2, `${simp.length} pts`);
  ok("simplify preserves endpoints", simp[0][0] === dense[0][0] && simp[simp.length - 1][0] === dense[dense.length - 1][0]);
  ok("round(51.50744, 4) = 51.5074", round(51.50744, 4) === 51.5074);
}

console.log("\nlib/normalize.js — DVLA/operator canonicalisation");
{
  ok('cleanMake("ALEXANDER DENNIS LTD") → Alexander Dennis', cleanMake("ALEXANDER DENNIS LTD") === "Alexander Dennis");
  ok('cleanMake("WRIGHTBUS") → VDL is NOT hit (WRIGHT rule wins first)', cleanMake("WRIGHTBUS") === "Wrightbus", cleanMake("WRIGHTBUS"));
  ok('cleanMake("BYD ENVIRO 200EV") strips body noise → BYD', cleanMake("BYD ENVIRO 200EV") === "BYD");
  ok('cleanMake(unknown) → Title Case', cleanMake("SOME NEW MAKER") === "Some New Maker", cleanMake("SOME NEW MAKER"));
  ok('cleanMake(null) → null', cleanMake(null) === null);
  ok('propulsionOf("ELECTRICITY") → electric', propulsionOf("ELECTRICITY") === "electric");
  ok('propulsionOf("DIESEL/ELECTRIC HYBRID") → hybrid', propulsionOf("DIESEL/ELECTRIC HYBRID") === "hybrid");
  ok('propulsionOf("HEAVY OIL") → diesel (DVLA edge case)', propulsionOf("HEAVY OIL") === "diesel");
  ok('propulsionOf("FUEL CELL") → hydrogen', propulsionOf("FUEL CELL") === "hydrogen");
  ok('propulsionOf("") → null', propulsionOf("") === null);
  ok('canonicalOperator strips legal suffixes', !/ltd|limited/i.test(canonicalOperator("Metroline Travel Ltd") || ""), canonicalOperator("Metroline Travel Ltd"));
  ok("reconcilePropulsion: ≥75% electric fleet upgrades stale diesel", reconcilePropulsion("diesel", { electric: 9, diesel: 1 }) === "electric");
  ok("reconcilePropulsion: bare majority does NOT upgrade", reconcilePropulsion("diesel", { electric: 5, diesel: 4 }) === "diesel");
  ok("reconcilePropulsion: tiny sample (<4) does NOT upgrade", reconcilePropulsion("diesel", { electric: 3 }) === "diesel");
  ok("reconcilePropulsion: explicit hydrogen claim kept", reconcilePropulsion("hydrogen", { electric: 10 }) === "hydrogen");
}

console.log(`\n${"=".repeat(48)}\ntest-functions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
