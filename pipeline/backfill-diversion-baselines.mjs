/**
 * backfill-diversion-baselines.mjs — one-time recovery of pre-diversion canonical
 * baselines from git history.
 *
 * Why: TfL redraws a route's Route/Sequence IN ADVANCE of a planned closure
 * (measured on W12/Selborne Road: line redrawn ~10 days before the closure
 * started), so diversions that began before the baseline-freeze existed were
 * silently absorbed into the store — the stored "canonical" line IS the diverted
 * one, and build/diversions.js finds no geometry diff (missedStops fire, since
 * the stop list lagged the redraw, but diversionSegments come back empty).
 *
 * The daily data commits are a dated archive, so the true baseline is
 * recoverable — and SELF-VALIDATING: the genuine pre-diversion line must pass
 * through the episode's missed stops (they were served). For every flagged
 * route with missed stops but no geometry diff, walk the data commits newest→
 * oldest and restore the first snapshot whose line passes every missed stop
 * within TOLERANCE_M; then re-run `node pipeline/run.js --only=diversions --force`
 * so the diffs recompute against the recovered baselines.
 *
 * Needs git history (run where the repo is a full clone). Idempotent: routes
 * already recovered stop matching the "missed stops but no segments" signature
 * on the rebuilt dataset, so a re-run finds nothing to do. The standing freeze
 * in build/routes.js (active + upcoming windows) prevents re-pollution.
 *
 *   node pipeline/backfill-diversion-baselines.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { distToLineM } from "./build/diversions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const TOLERANCE_M = 60;    // a served stop sits on the line (median 8 m; simplification ≤55 m)
const MAX_COMMITS = 60;    // how far back to walk the data-commit history

const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const git = (cmd) => execSync(cmd, { cwd: ROOT, maxBuffer: 1e9 }).toString();

const dv = load("route-diversions.json");
const overview = load("routes-overview.geojson");
const routeStops = load("route-stops.json");

// signature of a polluted baseline: the stop diff fired but the geometry diff didn't
const pending = new Map();   // routeId → { name, missed: [{dirCode, lng, lat, name}] }
for (const [name, e] of Object.entries(dv.routes || {})) {
  const hasMissed = Object.values(e.missedStops || {}).some((l) => l.length);
  const hasSegs = Object.values(e.diversionSegments || {}).some((l) => l.length);
  if (!hasMissed || hasSegs) continue;
  const missed = [];
  for (const [dir, code] of [["outbound", "1"], ["inbound", "2"]])
    (e.missedStops[dir] || []).forEach((s) => missed.push({ code, lng: s.lng, lat: s.lat, name: s.name }));
  pending.set(e.id, { name, missed });
}
console.log(`routes with the polluted-baseline signature (missed stops, no geometry diff): ${pending.size}`);
if (!pending.size) process.exit(0);

const commits = git(`git log --format="%H|%ad" --date=short -n ${MAX_COMMITS} -- data/routes-overview.geojson`)
  .trim().split("\n").map((l) => { const [h, d] = l.split("|"); return { h, d }; });

const geomFor = (features, id) => {
  const out = {};
  for (const f of features) if (f.properties?.routeId === id) out[String(f.properties.direction)] = f;
  return out;
};

const recovered = new Map();   // routeId → { commit, date, features, stops }
for (const { h, d } of commits) {
  if (!pending.size) break;
  let snapGeo, snapStops;
  try {
    snapGeo = JSON.parse(git(`git show ${h}:data/routes-overview.geojson`));
    snapStops = JSON.parse(git(`git show ${h}:data/route-stops.json`));
  } catch { continue; }
  for (const [id, info] of [...pending]) {
    const byDir = geomFor(snapGeo.features || [], id);
    if (!Object.keys(byDir).length) continue;
    // every missed stop must sit on this snapshot's line for its direction
    const allOn = info.missed.every((s) => {
      const f = byDir[s.code]; if (!f) return false;
      return distToLineM([s.lng, s.lat], f.geometry.coordinates) <= TOLERANCE_M;
    });
    if (!allOn) continue;
    recovered.set(id, { commit: h, date: d, features: Object.values(byDir), stops: snapStops.routes?.[id] || null });
    pending.delete(id);
    console.log(`  ✓ ${info.name}: baseline recovered from ${h.slice(0, 7)} (${d}) — all ${info.missed.length} missed stops within ${TOLERANCE_M} m of that line`);
  }
}
for (const [, info] of pending) console.log(`  – ${info.name}: no snapshot in the last ${MAX_COMMITS} data commits passes its missed stops — left as-is`);
if (!recovered.size) { console.log("nothing recovered"); process.exit(0); }
if (DRY) { console.log(`dry-run: would restore ${recovered.size} routes`); process.exit(0); }

// restore into the store: replace the route's features + stop sequences with the recovered ones
for (const [id, rec] of recovered) {
  overview.features = overview.features.filter((f) => f.properties?.routeId !== id).concat(rec.features);
  if (rec.stops) routeStops.routes[id] = rec.stops;
}
const write = (f, data) => { const p = path.join(ROOT, "data", f); fs.writeFileSync(p + ".tmp", JSON.stringify(data)); fs.renameSync(p + ".tmp", p); };
write("routes-overview.geojson", overview);
write("route-stops.json", routeStops);
console.log(`restored ${recovered.size} pre-diversion baselines into routes-overview.geojson + route-stops.json`);
console.log("now re-run:  node pipeline/run.js --only=diversions --force");
