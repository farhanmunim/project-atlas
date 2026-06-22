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

  // ── routes-overview.geojson (geometry + direction encoding) ────────────────
  section("routes-overview.geojson");
  const geo = load("routes-overview.geojson");
  const feats = geo.features || [];
  ok("FeatureCollection with features", geo.type === "FeatureCollection" && feats.length > 500, `${feats.length} features`);
  const dirs = [...new Set(feats.map((f) => f.properties?.direction))].sort();
  ok("direction encoded as 1/2 (outbound/inbound)", dirs.includes("1") && dirs.includes("2"), `values: ${dirs.join(",")}`);
  ok("every feature has geometry coords", feats.every((f) => f.geometry?.coordinates?.length), "");

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

  // ── manifest freshness ─────────────────────────────────────────────────────
  section("manifest");
  const man = load("_manifest.json");
  ok("manifest present with datasets", man && Object.keys(man).length > 0, `${Object.keys(man).length} entries`);
} catch (e) {
  fail++; console.log(`\n  ✗ FATAL: ${e.message}`);
}

console.log(`\n${"=".repeat(48)}\nvalidate-atlas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
