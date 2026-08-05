/**
 * check-sources.mjs — reproducible health sweep of every upstream source Atlas
 * consumes (per CLAUDE.md "Document the source per tool" + "don't assume").
 * Probes each endpoint the pipeline/app reads and reports reachability + a
 * shape sanity check, so a broken upstream is caught by a script, not a hunch.
 *
 *   node pipeline/check-sources.mjs           # fast probes only
 *   node pipeline/check-sources.mjs --deep    # + iBus geometry cross-check vs the store (~7 MB)
 *
 * Exit 0 = all healthy (or known-blocked); exit 1 = an unexpected failure.
 */
import "./lib/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEEP = process.argv.includes("--deep");
let pass = 0, fail = 0, warn = 0;
const ok = (l, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? " — " + d : ""}`); };
const note = (l, d = "") => { warn++; console.log(`  ~ ${l}${d ? " — " + d : ""}`); };

async function probe(url, { method = "GET", headers = {}, timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try { const r = await fetch(url, { method, headers, signal: ctrl.signal }); return r; }
  catch (e) { return { status: 0, err: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
const j = async (r) => { try { return await r.json(); } catch { return null; } };

console.log("\n── TfL Unified API (primary) ──");
{
  const key = process.env.TFL_APP_KEY ? `?app_key=${process.env.TFL_APP_KEY}` : "";
  let r = await probe(`https://api.tfl.gov.uk/Line/Mode/bus${key}`);
  ok("GET /Line/Mode/bus", r.status === 200, `${r.status}; ${((await j(r)) || []).length} lines`);
  r = await probe(`https://api.tfl.gov.uk/Line/Mode/bus/Status${key}`);
  const st = (await j(r)) || [];
  const disrupted = st.filter((l) => (l.lineStatuses || []).some((s) => s.statusSeverity !== 10)).length;
  ok("GET /Line/Mode/bus/Status", r.status === 200, `${r.status}; ${st.length} lines, ${disrupted} with non-good statuses`);
  if (r.status === 200 && disrupted === 0) note("bulk status reports ZERO disruptions — the known degraded-snapshot mode (per-line calls still carry them); builders gate on this");
  r = await probe(`https://api.tfl.gov.uk/Line/w12/Route/Sequence/outbound${key}`);
  const seq = await j(r);
  ok("GET /Line/{id}/Route/Sequence", r.status === 200 && !!seq?.lineStrings?.length, `${r.status}; lineStrings=${seq?.lineStrings?.length}`);
  r = await probe(`https://api.tfl.gov.uk/Line/Mode/bus/Disruption${key}`);
  ok("GET /Line/Mode/bus/Disruption", r.status === 200, `${r.status}; ${((await j(r)) || []).length} records`);
  r = await probe(`https://api.tfl.gov.uk/Road/all/Disruption${key}`);
  ok("GET /Road/all/Disruption", r.status === 200, `${r.status}; ${((await j(r)) || []).length} incidents`);
}

console.log("\n── iBus static drops (dated geometry archive) ──");
{
  const r = await probe("https://s3-eu-west-1.amazonaws.com/ibus.data.tfl.gov.uk/?list-type=2&delimiter=/");
  const xml = r.status === 200 ? await r.text() : "";
  const versions = [...xml.matchAll(/<Prefix>Base_Version_(\d{8})\/<\/Prefix>/g)].map((m) => m[1]).sort().reverse();
  ok("S3 bucket listing", r.status === 200 && versions.length >= 3, `${versions.length} dated versions, newest ${versions[0]}`);
  if (versions[0]) {
    const ageDays = (Date.now() - Date.parse(`${versions[0].slice(0, 4)}-${versions[0].slice(4, 6)}-${versions[0].slice(6, 8)}`)) / 86400000;
    ok("newest version is fresh (fortnightly cadence)", ageDays <= 21, `${Math.round(ageDays)} days old`);
    const h = await probe(`https://s3-eu-west-1.amazonaws.com/ibus.data.tfl.gov.uk/Base_Version_${versions[0]}/Route_Geometry_${versions[0]}.zip`, { method: "HEAD" });
    ok("Route_Geometry zip present", h.status === 200, `${h.status}`);
    if (DEEP) {
      const { fetchRouteGeometry } = await import("./sources/ibus.js");
      const { distToLineM } = await import("./build/diversions.js");
      const geo = await fetchRouteGeometry(versions[0]);
      ok("deep: zip parses", Object.keys(geo).length >= 500, `${Object.keys(geo).length} routes`);
      // cross-check: our stored geometry should agree with iBus for non-diverted sample routes
      const ov = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "routes-overview.geojson"), "utf8"));
      const dv = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-diversions.json"), "utf8"));
      const sample = ["25", "88", "133", "205", "390"].filter((n) => !dv.routes[n]);
      let agree = 0;
      for (const name of sample) {
        const ours = ov.features.find((f) => f.properties.routeId === name.toLowerCase() && f.properties.direction === "1")?.geometry.coordinates;
        const theirs = geo[name]?.["1"];
        if (!ours || !theirs) continue;
        let worst = 0; for (const p of theirs) worst = Math.max(worst, distToLineM(p, ours));
        if (worst < 120) agree++;   // simplified store vs detailed iBus — allow corner-cut headroom
      }
      ok("deep: store geometry agrees with iBus (sample, non-diverted)", agree >= Math.max(1, sample.length - 1), `${agree}/${sample.length} within 120 m`);
    }
  }
}

console.log("\n── other consumed sources ──");
{
  let r = await probe("https://data.bus-data.dft.gov.uk/api/v1/datafeed/?" + new URLSearchParams({ api_key: process.env.BODS_API_KEY || "", boundingBox: "-0.1,51.5,-0.09,51.51" }));
  ok("BODS SIRI-VM datafeed", process.env.BODS_API_KEY ? r.status === 200 : r.status !== 0, process.env.BODS_API_KEY ? `${r.status} (keyed)` : "no key locally — reachability only");
  r = await probe("http://www.londonbusroutes.net/garages.csv");
  ok("londonbusroutes.net garages.csv", r.status === 200, `${r.status}`);
  r = await probe("https://api.postcodes.io/postcodes/SW1A1AA");
  ok("postcodes.io", r.status === 200, `${r.status}`);
  r = await probe("https://roads.data.tfl.gov.uk/BridgesRestrictions/height-restrictions-in-london.xlsx", { method: "HEAD" });
  ok("TfL roads host (EPOWR bridges xlsx)", r.status === 200, `${r.status}`);
  r = await probe("https://data.london.gov.uk/api/action/package_search?q=bus&rows=1");
  ok("London Datastore CKAN API", r.status === 200 && (await j(r))?.success === true, `${r.status}`);
  // host is GET-only (HEAD → 405); a 100-byte ranged GET is the cheap health probe
  r = await probe("https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-last-5-years.csv", { headers: { Range: "bytes=0-99" } });
  ok("DfT STATS19 host", r.status === 200 || r.status === 206, `${r.status} (ranged GET)`);
  r = await probe("https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk?list-type=2&max-keys=1");
  ok("TfL BUSTO crowding host", r.status === 200, `${r.status}`);
  // Overpass 406s requests without a User-Agent
  r = await probe("https://overpass-api.de/api/status", { headers: { "User-Agent": "Atlas/1.0" } });
  ok("OSM Overpass", r.status === 200, `${r.status}`);
  r = await probe("http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf", { method: "HEAD" });
  ok("TfL QSI PDF host", r.status === 200, `${r.status}`);
  r = await probe("https://tfl.gov.uk/forms/13923.aspx");
  if (r.status === 403 || r.status === 200) note("TfL tender pages", `${r.status} — JS-rendered/WAF-gated; pipeline is incremental-cached by design`);
  else ok("TfL tender pages", false, `${r.status}`);
  ok("DVLA VES key configured (no probe — quota'd POST API)", !!process.env.DVLA_API_KEY);
}

console.log(`\n${"=".repeat(48)}\ncheck-sources: ${pass} passed, ${fail} failed, ${warn} notes`);
process.exit(fail ? 1 : 0);
