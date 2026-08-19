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
import { windowActiveNow, windowBounds, windowStartsWithin, routesNamedIn } from "./lib/tfl-status.js";
import { distToLineM, deviatingSegments } from "./build/diversions.js";
import { lengthKm, simplify, round } from "./lib/geo.js";
import { cleanMake, propulsionOf, canonicalOperator, reconcilePropulsion } from "./lib/normalize.js";
import { zipEntries, parseRouteGeometry } from "./sources/ibus.js";
import { normaliseVehicle } from "./sources/bustimes.js";
import { deflateRawSync, crc32 } from "node:zlib";

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
  // advance-freeze lookahead (TfL redraws ~10 days before a planned closure)
  ok("windowStartsWithin: opens in 10 days ⇒ true (14d lookahead)",
    windowStartsWithin([{ fromDate: "2026-08-15T08:00:00Z" }], 14, now));
  ok("windowStartsWithin: opens in 20 days ⇒ false", !windowStartsWithin([{ fromDate: "2026-08-25T08:00:00Z" }], 14, now));
  ok("windowStartsWithin: already open ⇒ false (that is windowActiveNow's job)",
    !windowStartsWithin([{ fromDate: "2026-08-01T00:00:00Z" }], 14, now));
  ok("windowStartsWithin: no dates ⇒ false", !windowStartsWithin([{}], 14, now) && !windowStartsWithin([], 14, now));
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
  // downgrade path — an over-claiming ZEV spec vs street reality (audit 2026-08-19)
  ok("reconcilePropulsion: electric claim vs 6 observed diesel → diesel (H20)", reconcilePropulsion("electric", { diesel: 6 }) === "diesel");
  ok("reconcilePropulsion: hydrogen claim vs 6 observed hybrid → hybrid (N7)", reconcilePropulsion("hydrogen", { hybrid: 6 }) === "hybrid");
  ok("reconcilePropulsion: electric claim, 4e/7hb/8d (21% ZEV) → diesel (200)", reconcilePropulsion("electric", { electric: 4, hybrid: 7, diesel: 8 }) === "diesel");
  ok("reconcilePropulsion: hydrogen claim, 10e/8other (56% ZEV) NOT downgraded (route 7 FCEV-as-electric)", reconcilePropulsion("hydrogen", { electric: 10, diesel: 6, hybrid: 2 }) === "hydrogen");
  ok("reconcilePropulsion: electric claim, only 5 observed → kept (sample too small)", reconcilePropulsion("electric", { diesel: 5 }) === "electric");
  ok("reconcilePropulsion: hybrid ties beat diesel on downgrade", reconcilePropulsion("electric", { hybrid: 4, diesel: 4 }) === "hybrid");
}

console.log("\nsources/ibus.js — zip reader & Route_Geometry parser");
{
  // build a real single-entry zip in memory (deflate method) and read it back
  const makeZip = (name, content) => {
    const body = Buffer.from(content), data = deflateRawSync(body), nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(body), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(body), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(0, 42);
    const cdStart = 30 + nameB.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + nameB.length, 12); eocd.writeUInt32LE(cdStart, 16);
    return Buffer.concat([lh, nameB, data, cd, nameB, eocd]);
  };
  const entries = [...zipEntries(makeZip("hello.xml", "<a>route data</a>"))];
  ok("zip reader: entry name + inflated content round-trip", entries.length === 1 && entries[0].name === "hello.xml" && entries[0].data().toString() === "<a>route data</a>");

  const RG = (run, seq, dir, lng, lat) => `<Route_Geometry aContract_Line_No="X" aLBSL_Run_No="${run}" aSequence_No="${seq}"><Direction>${dir}</Direction><Location_Easting>1</Location_Easting><Location_Northing>1</Location_Northing><Location_Longitude>${lng}</Location_Longitude><Location_Latitude>${lat}</Location_Latitude></Route_Geometry>`;
  // out-of-order sequences, a run-3 variant that must lose to run-1, both directions
  const xml = RG(1, 2, 1, -0.2, 51.6) + RG(1, 1, 1, -0.1, 51.5) + RG(3, 1, 1, -9, 9) + RG(2, 1, 2, -0.3, 51.7) + RG(2, 2, 2, -0.4, 51.8);
  const g = parseRouteGeometry(xml);
  ok("parser: sequences sorted", g["1"][0][0] === -0.1 && g["1"][1][0] === -0.2, JSON.stringify(g["1"]));
  ok("parser: lowest run wins per direction (variant run 3 ignored)", !g["1"].some((p) => p[0] === -9));
  ok("parser: both directions extracted", g["2"]?.length === 2, JSON.stringify(g["2"]));
}

console.log("\nlib/tfl-status.js — routesNamedIn (misattribution filter)");
{
  const eq = (a, b) => JSON.stringify(a.sort()) === JSON.stringify(b.sort());
  ok('"Route 379 will be on diversion…" → [379] (the live 376/379 case)',
    eq(routesNamedIn("YARDLEY LANE, E4: Route 379 will be on on diversion due to a parked vehicle"), ["379"]));
  ok('"ROUTES 238 and 376 will be diverted" → [238, 376]',
    eq(routesNamedIn("Road closure… ROUTES 238 and 376 will be diverted in both directions"), ["238", "376"]));
  ok('"Routes 304 & 376:" → [304, 376]',
    eq(routesNamedIn("Boundary Lane E13 - Routes 304 & 376: Road will be closed"), ["304", "376"]));
  ok('"ROUTES 212 W12 W19 and 675 will…" → all four incl. lettered',
    eq(routesNamedIn("ROUTES 212 W12 W19 and 675 will be diverted and will miss stop"), ["212", "W12", "W19", "675"]));
  ok("road-only prose (no routes named) → []", routesNamedIn("Selborne Road will be closed from 08:00 due to water works").length === 0);
  ok('"to line of route" (bare word) → []', routesNamedIn("diverted via Sewardstone Road to line of route, missing stops").length === 0);
  ok("years never parsed as routes", routesNamedIn("Routes 2026 subject to change").length === 0);
  ok("null/empty safe", routesNamedIn(null).length === 0 && routesNamedIn("").length === 0);
}

console.log("\nsources/bustimes.js — vehicle record normalisation");
{
  const rec = normaliseVehicle({ reg: "LK67ENF", fleet_code: "VWH2399", vehicle_type: { name: "Volvo B5LH Wright Eclipse Gemini 3", style: "double decker", fuel: "hybrid", double_decker: true }, operator: { name: "Metroline Travel" }, withdrawn: false });
  ok("full record → body/deck/fuel/fleetCode", rec.body === "Volvo B5LH Wright Eclipse Gemini 3" && rec.deck === "double" && rec.fuel === "hybrid" && rec.fleetCode === "VWH2399", JSON.stringify(rec));
  ok("single decker style → deck single", normaliseVehicle({ vehicle_type: { style: "single decker", double_decker: false } }).deck === "single");
  ok("no vehicle_type → nulls, no crash", normaliseVehicle({ reg: "X" }).body === null && normaliseVehicle({ reg: "X" }).deck === null);
  ok("null input → null", normaliseVehicle(null) === null);
  ok("fleet_number fallback when fleet_code absent", normaliseVehicle({ fleet_number: 123, vehicle_type: {} }).fleetCode === 123);
}

console.log("\nbuild/route-meta.js — fleet-string propulsion classifier");
{
  const { propFromVehicle } = await import("./build/route-meta.js");
  ok("E400EV reads electric (the SL3 case)", propFromVehicle("E400EV 10.5m") === "electric");
  ok("Volvo BZL reads electric (the 314 case)", propFromVehicle("BZL (sd) 10.4m/MCV 2D") === "electric");
  ok("Electroliner reads electric", propFromVehicle("Streetdeck Electroliner 10.5m") === "electric");
  ok("E40H stays hybrid", propFromVehicle("E40H 10.2m/Enviro400H MMC 2D") === "hybrid");
  ok("old Tridents stay diesel", propFromVehicle("Trident 10.5m/Enviro400 2D") === "diesel");
  const { canonicalOperator } = await import("./lib/normalize.js");
  ok("RATP-era names roll to Transport UK London Bus (no RATP suffix)",
    canonicalOperator("RATP Dev Transit London") === "Transport UK London Bus" && canonicalOperator("London United") === "Transport UK London Bus",
    canonicalOperator("RATP Dev Transit London"));
}

console.log("\nsources/dvsa-vol.js — postcode extraction & licence selection");
{
  const { extractPostcodes, pickLicence } = await import("./sources/dvsa-vol.js");
  const pcs = extractPostcodes("ASH GROVE ASH GROVE BUS DEPOT   LONDON  GB E8 4RH; UNIT 5, THE YARD, DAGENHAM GB RM109QQ");
  ok("extracts + normalises postcodes from ;-joined OC blob", pcs.includes("E8 4RH") && pcs.includes("RM10 9QQ"), pcs.join(" | "));
  ok("no false postcode from plain words", extractPostcodes("BUS DEPOT LONDON").length === 0);
  const picked = pickLicence([
    { number: "PK1", status: "Valid", authorisedVehicles: 12 },
    { number: "PK2", status: "Valid", authorisedVehicles: 930 },
    { number: "PK3", status: "Surrendered", authorisedVehicles: 2000 },
  ]);
  ok("picks the largest VALID licence (930 beats surrendered 2000)", picked.number === "PK2", picked.number);
  ok("empty candidates → null", pickLicence([]) === null && pickLicence(null) === null);
}

console.log(`\n${"=".repeat(48)}\ntest-functions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
