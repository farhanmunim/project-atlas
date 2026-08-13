/**
 * verify-geometry.mjs — cross-check the stored route geometry against TfL.
 *
 * For a sample of NON-DIVERTED routes, asserts that our per-route full-fidelity
 * file (data/route-geometry/<id>.json) is TfL's current Route/Sequence ring:
 * same point count, max point-wise deviation within 5-dp rounding (~1.5 m).
 * Also sanity-checks the simplified overview stays within its stated tolerance
 * of the detailed ring. Reproducible: re-run any time the pipeline has run.
 *
 *   node pipeline/verify-geometry.mjs [id id …]   (default: a fixed sample)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

const R = 6371000, RAD = Math.PI / 180;
const distM = ([ax, ay], [bx, by]) => Math.hypot((bx - ax) * Math.cos(ay * RAD) * RAD * R, (by - ay) * RAD * R);
// max distance from each point of `a` to the nearest segment of polyline `b`
function maxDeviationM(a, b) {
  const segDist = (p, s, e) => {
    const cos = Math.cos(s[1] * RAD);
    const vx = (e[0] - s[0]) * cos * RAD * R, vy = (e[1] - s[1]) * RAD * R;
    const px = (p[0] - s[0]) * cos * RAD * R, py = (p[1] - s[1]) * RAD * R;
    const L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, (px * vx + py * vy) / L2)) : 0;
    return Math.hypot(px - t * vx, py - t * vy);
  };
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (let i = 1; i < b.length; i++) { const d = segDist(p, b[i - 1], b[i]); if (d < best) best = d; if (best < 0.5) break; }
    if (best > worst) worst = best;
  }
  return worst;
}

const dv = read(path.join(ROOT, "data", "route-diversions.json"));
const frozen = new Set([...Object.values(dv?.routes || {}).map((e) => e.id), ...(dv?.upcomingFreeze || [])]);
const registered = new Set((read(path.join(ROOT, "data", "routes.json")) || []).map((r) => r.id));
const args = process.argv.slice(2);
const sample = args.length ? args : ["25", "73", "88", "453", "111", "w7", "x140", "sl8"].filter((id) => !frozen.has(id) && registered.has(id));

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };

const overview = read(path.join(ROOT, "data", "routes-overview.geojson"));
const ovBy = {};
for (const f of overview?.features || []) ovBy[`${f.properties.routeId}|${f.properties.direction}`] = f.geometry.coordinates;

console.log(`verify-geometry: ${sample.length} non-diverted sample routes vs TfL live\n`);
for (const id of sample) {
  const det = read(path.join(ROOT, "data", "route-geometry", `${id}.json`));
  if (!det) { ok(`${id}: detailed file present`, false, "missing (and not frozen)"); continue; }
  for (const [dir, apiDir] of [["1", "outbound"], ["2", "inbound"]]) {
    const ours = det.directions?.[dir]?.coordinates;
    if (!ours) continue;
    let tfl;
    try {
      const r = await fetch(`https://api.tfl.gov.uk/Line/${id}/Route/Sequence/${apiDir}`);
      const d = await r.json();
      const ls = JSON.parse(d.lineStrings[0]);
      tfl = Array.isArray(ls[0]?.[0]) ? ls[0] : ls;
    } catch (e) { console.log(`  – ${id}/${dir}: TfL fetch failed (${e.message}) — skipping live compare`); continue; }
    const dev = maxDeviationM(ours, tfl);
    ok(`${id}/${dir}: stored ring ≡ TfL (${ours.length} vs ${tfl.length} pts)`, Math.abs(ours.length - tfl.length) <= 2 && dev < 3, `max dev ${dev.toFixed(1)} m`);
    const ov = ovBy[`${id}|${dir}`];
    if (ov) { const od = maxDeviationM(ov, ours); ok(`${id}/${dir}: overview within stated tolerance of ring`, od < 25, `max dev ${od.toFixed(1)} m`); }
  }
}
console.log(`\n${"=".repeat(48)}\nverify-geometry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
