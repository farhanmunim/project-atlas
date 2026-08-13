#!/usr/bin/env node
/**
 * validate-atlas.js — reproducible validation of the Atlas data layer (the prod read
 * layer that /api/v1/* serves). Per CLAUDE.md "Validation (always)": schema / row-count /
 * sanity / reconciliation checks so what the API serves provably matches the source shape,
 * not just "it loads". Runs WITHOUT a server (validates committed data/*.json).
 *
 *   node pipeline/validate-atlas.js          # validate ./data
 *   npm run validate:atlas
 *
 * Exit 0 = all checks pass; exit 1 = one or more failed. CI-friendly.
 *
 * (Rendered ↔ source cross-checks that need a running app live in route-check.mjs /
 * test-export.mjs; this script is the dependency-free data-integrity gate.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const section = (t) => console.log(`\n${t}`);
const arr = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : Object.values(d || {}));
const nullRate = (rows, k) => rows.filter((r) => r[k] == null || r[k] === "").length / Math.max(1, rows.length);

try {
  // ── routes ────────────────────────────────────────────────────────────────
  section("routes.json");
  const routes = arr(load("routes.json"), "routes");
  ok("non-empty list of {id,name}", routes.length > 100 && routes.every((r) => r.id && r.name), `${routes.length} routes`);

  // ── route-meta / classifications / stops / performance (presence + shape) ──
  section("reference datasets present & shaped");
  for (const [f, key] of [["route-meta.json", "routes"], ["route-classifications.json", "routes"],
    ["route-stops.json", "routes"], ["garages.json", "garages"], ["fleet.json", "routes"],
    ["vehicles.json", "vehicles"], ["tenders.json", "tenders"], ["route-performance.json", "routes"],
    ["bridges.json", "bridges"], ["line-status.json", "routes"]]) {
    let d; try { d = load(f); } catch (e) { ok(f, false, "missing/unparseable"); continue; }
    ok(f, d && typeof d === "object", Array.isArray(d?.[key]) ? `${d[key].length} ${key}` : "object");
  }

  // ── propulsion ↔ fleet reconciliation (guards the stale-electrification fix) ──
  // route-meta.propulsion is upgraded from the DVLA fleet when a route is clearly zero-emission
  // (build/route-meta.js → reconcilePropulsion). This guard catches a *regression* of that fix
  // (the original bug: ~37 routes read diesel while battery-electric, contradicting our own fleet).
  //
  // It must NOT be a strict per-route gate, because the two datasets refresh on different cadences:
  // route-meta.propulsion is reconciled only at route-meta BUILD time (weekly TTL), whereas this
  // validator (and the fleet builder) see a fresh, independent, per-MINUTE live arrivals snapshot
  // (build/fleet.js samples vehicleIds on the road this minute — not an accumulated roster). So a
  // small route mid-electrification (e.g. R1, ~5 buses) legitimately crosses the 75% line in the
  // live snapshot between weekly route-meta rebuilds, and self-heals at the next rebuild. That lag
  // is expected — failing the whole refresh on it would let one volatile sample abort the deploy.
  // A *large* disagreement, by contrast, means the reconciliation genuinely regressed. So gate on
  // the systemic case only: a handful of lagging routes passes (with a visible note); a flood fails.
  section("propulsion ↔ fleet consistency");
  try {
    const rm = (load("route-meta.json").routes) || {};
    const fl = (load("fleet.json").byRoute) || {};
    const stale = [];
    for (const r of Object.keys(rm)) {
      const f = fl[r]; if (!f || !f.propulsion) continue;
      const p = f.propulsion, tot = (p.electric || 0) + (p.hydrogen || 0) + (p.hybrid || 0) + (p.diesel || 0);
      if (tot >= 4 && (p.electric || 0) / tot >= 0.75 && rm[r].propulsion !== "electric") stale.push(r);
    }
    // Threshold sits well above the normal weekly cross-cadence lag (a few borderline routes) and
    // well below a reconciliation regression (~50+ upgraded routes would all revert at once).
    const SYSTEMIC = 20;
    const detail = stale.length
      ? `${stale.length} lagging${stale.length > SYSTEMIC ? " — REGRESSION" : " (within expected weekly cross-cadence lag)"}: ${stale.slice(0, 12).join(",")}`
      : "all reconciled";
    ok("propulsion reconciliation not systemically stale (fleet ≥75% electric ⇒ route-meta electric)", stale.length <= SYSTEMIC, detail);
  } catch (e) { ok("propulsion↔fleet check ran", false, e.message); }

  // ── routes-overview.geojson (geometry + direction encoding) ────────────────
  section("routes-overview.geojson");
  const geo = load("routes-overview.geojson");
  const feats = geo.features || [];
  ok("FeatureCollection with features", geo.type === "FeatureCollection" && feats.length > 500, `${feats.length} features`);
  const dirs = [...new Set(feats.map((f) => f.properties?.direction))].sort();
  ok("direction encoded as 1/2 (outbound/inbound)", dirs.includes("1") && dirs.includes("2"), `values: ${dirs.join(",")}`);
  ok("every feature has geometry coords", feats.every((f) => f.geometry?.coordinates?.length), "");

  // ── route-geometry/<id>.json — per-route FULL-FIDELITY rings ───────────────
  section("route-geometry/ (per-route full fidelity)");
  const geoDir = path.join(DIR, "route-geometry");
  const geoFiles = fs.existsSync(geoDir) ? fs.readdirSync(geoDir).filter((f) => f.endsWith(".json")) : [];
  ok("detailed files for most of the network (frozen-diverted may be absent)", geoFiles.length >= 400, `${geoFiles.length} files`);
  {
    const featPts = {};
    for (const f of feats) { const k = `${f.properties.routeId}|${f.properties.direction}`; featPts[k] = f.geometry.coordinates.length; }
    let denser = 0, checked = 0, badShape = 0, outOfBbox = 0;
    for (const fn of geoFiles.slice(0, 50)) {
      const d = JSON.parse(fs.readFileSync(path.join(geoDir, fn), "utf8"));
      const id = fn.replace(/\.json$/, "");
      if (!d.directions || d.routeId !== id) { badShape++; continue; }
      for (const [dir, g] of Object.entries(d.directions)) {
        checked++;
        if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) { badShape++; continue; }
        if (!g.coordinates.every(([x, y]) => x > -1.2 && x < 0.9 && y > 51 && y < 52)) outOfBbox++;
        if (g.coordinates.length >= (featPts[`${id}|${dir}`] || 0)) denser++;
      }
    }
    ok("sampled files well-formed ({routeId, directions.{1,2}.coordinates})", badShape === 0, `${badShape} malformed`);
    ok("sampled rings inside Greater London bbox", outOfBbox === 0, `${outOfBbox} out of bbox`);
    ok("full-fidelity ≥ overview point count (sampled)", checked > 0 && denser === checked, `${denser}/${checked}`);
  }

  // ── accidents.json — the enriched STATS19 layer (deep checks) ──────────────
  section("accidents.json (STATS19 — enriched)");
  const acc = load("accidents.json");
  const rows = acc.accidents || [];
  ok("count field reconciles with rows", acc.count === rows.length, `count=${acc.count} rows=${rows.length}`);
  ok("has rows (>1000 live, or labelled sample)", rows.length > 1000 || acc.sample === true, `${rows.length} rows, sample=${!!acc.sample}`);

  // every row carries the core + 8 decoded context fields
  const CTX = ["roadType", "speedLimit", "junction", "light", "weather", "roadSurface", "day", "timeBand"];
  const CORE = ["id", "lat", "lng", "severity", "date"];
  ok("every row has core fields", rows.every((r) => CORE.every((k) => r[k] != null)), "");
  ok("every row carries all 8 context keys", rows.every((r) => CTX.every((k) => k in r)), CTX.join("/"));

  // value vocabularies are clean (no raw codes / out-of-vocabulary leaks)
  const sevVocab = new Set(rows.map((r) => r.severity));
  ok("severity vocab = {fatal,serious,slight}", [...sevVocab].every((s) => ["fatal", "serious", "slight"].includes(s)), [...sevVocab].join(","));
  const spdBad = rows.filter((r) => r.speedLimit && !/^\d+ mph$/.test(r.speedLimit)).length;
  ok("speedLimit format clean (\\d+ mph | null)", spdBad === 0, `${spdBad} malformed`);
  const dayVocab = new Set(rows.map((r) => r.day).filter(Boolean));
  ok("day vocab ⊆ Mon..Sun", [...dayVocab].every((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(d)), [...dayVocab].join(","));
  const bandVocab = new Set(rows.map((r) => r.timeBand).filter(Boolean));
  ok("timeBand vocab clean", [...bandVocab].every((b) => ["AM peak", "Inter-peak", "PM peak", "Evening", "Night"].includes(b)), [...bandVocab].join(","));
  // a categorical label never leaks a bare number (would mean an undecoded raw code).
  // speedLimit is exempt — it's a formatted numeric ("20 mph"), checked above.
  const labelCols = CTX.filter((k) => k !== "speedLimit");
  const numLeak = labelCols.filter((k) => rows.some((r) => r[k] != null && r[k] !== "" && /^-?\d+$/.test(String(r[k]))));
  ok("no undecoded raw codes leak into context labels", numLeak.length === 0, numLeak.join(",") || "clean");
  // null rates are plausible (context is sometimes missing in STATS19, but not mostly-null)
  const highNull = CTX.filter((k) => nullRate(rows, k) > 0.6);
  ok("context null rates < 60% (fields are populated)", highNull.length === 0, highNull.map((k) => `${k}=${(nullRate(rows, k) * 100) | 0}%`).join(" ") || "all healthy");

  // geometry within Greater London bbox; severity parts present
  const inBbox = rows.every((r) => r.lat > 51.2 && r.lat < 51.8 && r.lng > -0.6 && r.lng < 0.4);
  ok("all coords within Greater London bbox", inBbox, "");
  const sev = rows.reduce((a, r) => (a[r.severity] = (a[r.severity] || 0) + 1, a), {});
  ok("severity parts sum to total", (sev.fatal || 0) + (sev.serious || 0) + (sev.slight || 0) === rows.length, JSON.stringify(sev));
  // casualties: positive integer where present, ≥1 (a collision with casualties has ≥1 injured)
  const casBad = rows.filter((r) => r.casualties != null && !(Number.isInteger(r.casualties) && r.casualties >= 1)).length;
  ok("casualties are positive integers (or null)", casBad === 0, `${casBad} invalid`);

  // ── crowding.json — TfL BUSTO bus crowding (deep checks) ───────────────────
  section("crowding.json (TfL BUSTO)");
  const cw = load("crowding.json");
  const cwRoutes = cw.routes || {};
  const cwKeys = Object.keys(cwRoutes);
  ok("count reconciles with routes", cw.count === cwKeys.length, `count=${cw.count} routes=${cwKeys.length}`);
  ok("has routes (>300)", cwKeys.length > 300, `${cwKeys.length} routes`);
  const cwVals = cwKeys.map((k) => cwRoutes[k]);
  ok("every route has numeric peakVC in (0,2]", cwVals.every((r) => typeof r.peakVC === "number" && r.peakVC > 0 && r.peakVC <= 2), "");
  const BANDS = ["comfortable", "moderate", "busy", "crowded"];
  const cwBandVocab = new Set(cwVals.map((r) => r.band));
  ok("band vocab ⊆ {comfortable,moderate,busy,crowded}", [...cwBandVocab].every((b) => BANDS.includes(b)), [...cwBandVocab].join(","));
  // band must agree with peakVC against the published thresholds (0.5/0.65/0.8)
  const bandFor = (v) => v < 0.5 ? "comfortable" : v < 0.65 ? "moderate" : v < 0.8 ? "busy" : "crowded";
  const bandBad = cwVals.filter((r) => r.band !== bandFor(r.peakVC)).length;
  ok("band matches peakVC thresholds", bandBad === 0, `${bandBad} mismatched`);
  // V/C reconciles with load÷capacity (within rounding)
  const vcBad = cwVals.filter((r) => r.capacity > 0 && Math.abs(r.peakVC - r.load / r.capacity) > 0.02).length;
  ok("peakVC ≈ load ÷ capacity", vcBad === 0, `${vcBad} off`);
  ok("every route has a busiest stop + day type", cwVals.every((r) => r.stopname && r.dayType), "");
  ok("summary stays light (no profiles leaked in)", cwVals.every((r) => !("loadProfile" in r)), "summary keeps band-only");

  // ── crowding-profile.json — the per-route detail (load-along-route + time-of-day) ──
  section("crowding-profile.json (TfL BUSTO detail)");
  const cwp = load("crowding-profile.json");
  const cwpRoutes = cwp.routes || {};
  ok("profile present for (nearly) all summary routes", Object.keys(cwpRoutes).length >= cwKeys.length * 0.95, `${Object.keys(cwpRoutes).length} / ${cwKeys.length}`);
  const cwpVals = Object.values(cwpRoutes);
  ok("every profile has a load-along-route array", cwpVals.every((p) => Array.isArray(p.loadProfile) && p.loadProfile.length >= 2), "");
  ok("load profile V/C all in [0,2]", cwpVals.every((p) => p.loadProfile.every((s) => typeof s.vc === "number" && s.vc >= 0 && s.vc <= 2)), "0 = empty terminus");
  ok("every profile has a time-of-day curve", cwpVals.every((p) => p.timeOfDay && Object.keys(p.timeOfDay).length >= 1), "");
  // time curves are chronologically ordered (the fix)
  const ooo = cwpVals.filter((p) => { const w = (p.timeOfDay && p.timeOfDay.Weekday) || []; for (let i = 1; i < w.length; i++) if (w[i].t < w[i - 1].t) return true; return false; }).length;
  ok("time-of-day curves are time-ordered", ooo === 0, `${ooo} out of order`);
  // a profile's peak V/C reconciles with the summary's peak (same source, same number)
  const r25p = cwpRoutes["25"], r25s = cwRoutes["25"];
  if (r25p && r25s) ok("route 25 profile peak ≈ summary peak", Math.abs(Math.max(...r25p.loadProfile.map((s) => s.vc)) - r25s.peakVC) < 0.01, `profile ${Math.max(...r25p.loadProfile.map((s) => s.vc))} vs summary ${r25s.peakVC}`);

  // ── vehicles.json — per-vehicle enrichment (DVLA → bustimes chain) ────────
  section("vehicles.json (enrichment chain)");
  try {
    const vv = Object.values(load("vehicles.json").byReg || {});
    ok("roster present (>100 regs)", vv.length > 100, `${vv.length} regs`);
    const withBody = vv.filter((v) => v.body);
    ok("body enrichment accruing (some regs carry body)", withBody.length > 0, `${withBody.length} with body`);
    ok("deck vocab ⊆ {double,single}", vv.every((v) => v.deck == null || ["double", "single"].includes(v.deck)), "");
    ok("propulsionSource only 'bustimes' and only with propulsion set", vv.every((v) => v.propulsionSource == null || (v.propulsionSource === "bustimes" && v.propulsion)), "");
    ok("DVLA priority: every reg with DVLA fuel keeps make/year", vv.filter((v) => v.fuel).every((v) => v.make !== undefined && v.year !== undefined), "");
  } catch (e) { ok("vehicles.json checks ran", false, e.message); }

  // ── route-diversions.json — active diversion episodes (status + sequence diff) ──
  section("route-diversions.json (diversions)");
  try {
    const dv = load("route-diversions.json");
    const dvRoutes = dv.routes || {};
    const dvNames = Object.keys(dvRoutes);
    ok("count reconciles with routes", dv.count === dvNames.length, `count=${dv.count} routes=${dvNames.length}`);
    ok("plausible episode count (≤400)", dvNames.length <= 400, `${dvNames.length} active`);
    ok("every entry has id/status/disruptions/detectedAt", dvNames.every((n) => { const e = dvRoutes[n];
      return e.id && e.status && Array.isArray(e.disruptions) && e.disruptions.length && e.detectedAt; }), "");
    ok("geometryStatus vocab", dvNames.every((n) => ["published", "unpublished"].includes(dvRoutes[n].geometryStatus)), "");
    ok("published ⇒ non-empty diversionSegments", dvNames.every((n) => { const e = dvRoutes[n];
      return e.geometryStatus !== "published" || Object.values(e.diversionSegments || {}).some((ss) => ss.length); }), "");
    const badCoord = dvNames.some((n) => Object.values(dvRoutes[n].diversionSegments || {}).some((ss) =>
      ss.some((seg) => seg.some(([lng, lat]) => !(lng > -1.2 && lng < 1.2 && lat > 50.8 && lat < 52.2)))));
    ok("all segment coords within Greater London", !badCoord, "");
    ok("missed/added stops carry id+name+coords", dvNames.every((n) => ["missedStops", "addedStops"].every((k) =>
      Object.values(dvRoutes[n][k] || {}).every((list) => list.every((s) => s.id && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng))))), "");
  } catch (e) { ok("route-diversions.json", false, "missing/unparseable — " + e.message); }

  // ── manifest freshness ─────────────────────────────────────────────────────
  section("manifest");
  const man = load("_manifest.json");
  ok("manifest present with datasets", man && Object.keys(man).length > 0, `${Object.keys(man).length} entries`);
} catch (e) {
  fail++; console.log(`\n  ✗ FATAL: ${e.message}`);
}

console.log(`\n${"=".repeat(48)}\nvalidate-atlas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
