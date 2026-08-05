/**
 * verify-diversions.mjs — reproducible rendered↔source cross-check for the route-
 * diversions feature (per CLAUDE.md "Validation (always)"). Drives both apps headless
 * against a running dev server and asserts the UI agrees with route-diversions.json:
 *
 *   /    — store loads the dataset; a route with missed stops shows the dossier
 *          diversion panel listing exactly those stops, red missed-stop + amber
 *          temporary-stop markers on the map, the table's Diverted column, and the
 *          legend entries; a published-geometry route draws the dashed amber path.
 *   /v2  — the same route draws the diversion overlay (canvas pixel test — the v2
 *          map is preferCanvas) and the Route card carries the Diversion section.
 *
 * Routes are picked FROM the dataset (whatever is diverted today), so the script
 * stays valid as episodes come and go. Zero JS errors is asserted throughout.
 *
 *   node pipeline/serve.js &          # dev server on :8000
 *   node pipeline/verify-diversions.mjs [baseUrl]
 */
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://localhost:8000";
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-diversions.json"), "utf8"));

// pick test subjects from the live dataset
const names = Object.keys(data.routes);
const withMissed = names.find((n) => Object.values(data.routes[n].missedStops || {}).some((l) => l.length));
const withGeom = names.find((n) => data.routes[n].geometryStatus === "published");
if (!names.length) { console.log("no active diversions in the dataset — nothing to verify (OK)"); process.exit(0); }

let pass = 0, fail = 0;
const ok = (l, c, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${l}${d ? " — " + d : ""}`); };
const errors = [];

// Offline fallback: if the Leaflet CDN is unreachable but a local npm copy exists,
// serve it via request interception (hash-identical to unpkg, so SRI still passes).
const LOCAL = [
  ["leaflet@1.9.4/dist/leaflet.js", "leaflet/dist/leaflet.js", "text/javascript"],
  ["leaflet@1.9.4/dist/leaflet.css", "leaflet/dist/leaflet.css", "text/css"],
  ["leaflet.heat@0.2.0/dist/leaflet-heat.js", "leaflet.heat/dist/leaflet-heat.js", "text/javascript"],
].map(([frag, rel, type]) => [frag, path.join(ROOT, "node_modules", rel), type]).filter(([, f]) => fs.existsSync(f));
async function wire(page) {
  if (!LOCAL.length) return;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    for (const [frag, file, type] of LOCAL)
      if (u.includes(frag)) return req.respond({ status: 200, contentType: type, headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(file, "utf8") });
    req.continue().catch(() => {});
  });
}
const launchOpts = { args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launchOpts.executablePath = "/opt/pw-browsers/chromium";
const browser = await puppeteer.launch(launchOpts);
const watch = (page, tag) => { page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/net::|Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the main app (/) ─────────────────────────────────────────────────────── */
const page = await browser.newPage();
await wire(page); watch(page, "/");
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
await sleep(3000);

const loaded = await page.evaluate(() => ({ has: !!store.diversions, n: store.diversions ? Object.keys(store.diversions).length : 0 }));
ok("/ store loads route-diversions via the seam", loaded.has && loaded.n === data.count, `app=${loaded.n} file=${data.count}`);

if (withMissed) {
  const dv = data.routes[withMissed];
  await page.evaluate(async (nm) => { const r = routes.find((x) => x.name === nm); if (r) await toggleRoute(r); }, withMissed);
  await sleep(4500);
  const ui = await page.evaluate(() => {
    const panel = document.querySelector(".dvn-panel");
    let red = 0, amber = 0;
    divLayer.eachLayer((l) => { if (l instanceof L.CircleMarker) { if (l.options.color === "#ff5470") red++; if (l.options.color === "#f5a524") amber++; } });
    return { hasPanel: !!panel, lis: panel ? [...panel.querySelectorAll(".stoplist li .nm")].map((n) => n.textContent) : [], red, amber };
  });
  const missedNames = [...new Set(Object.values(dv.missedStops).flat().map((s) => s.name))];
  const addedN = new Set(Object.values(dv.addedStops || {}).flat().map((s) => s.id)).size;
  ok(`/ ${withMissed}: dossier diversion panel renders`, ui.hasPanel);
  ok(`/ ${withMissed}: panel lists the dataset's missed stops`, missedNames.every((n) => ui.lis.includes(n)), missedNames.slice(0, 3).join("|"));
  ok(`/ ${withMissed}: missed-stop markers on map`, ui.red >= new Set(Object.values(dv.missedStops).flat().map((s) => s.id)).size, `${ui.red} red`);
  if (addedN) ok(`/ ${withMissed}: temporary-stop markers on map`, ui.amber >= addedN, `${ui.amber} amber vs ${addedN}`);
  await page.evaluate(() => setCanvasView("table"));
  await sleep(1200);
  const tbl = await page.evaluate((nm) => {
    const row = [...document.querySelectorAll("tbody tr")].find((tr) => tr.querySelector(".rno")?.textContent === nm);
    return { ths: [...document.querySelectorAll("thead th")].map((t) => t.textContent.trim()).slice(0, 4), cell: row ? row.children[2].textContent.trim() : null };
  }, withMissed);
  ok("/ table has Diverted column", tbl.ths.includes("Diverted"), tbl.ths.join(","));
  ok(`/ ${withMissed} table row flags the diversion`, !!tbl.cell && /until|active/.test(tbl.cell), tbl.cell || "");
  await page.evaluate(async (nm) => { setCanvasView("map"); const r = routes.find((x) => x.name === nm); if (r && selected.includes(r)) await toggleRoute(r); }, withMissed);
}

if (withGeom) {
  await page.evaluate(async (nm) => { const r = routes.find((x) => x.name === nm); if (r && !selected.includes(r)) await toggleRoute(r); }, withGeom);
  await sleep(4500);
  const ui = await page.evaluate(() => {
    let dashedAmber = 0;
    divLayer.eachLayer((l) => { if (l instanceof L.Polyline && !(l instanceof L.CircleMarker) && l.options.color === "#f5a524") dashedAmber++; });
    return { dashedAmber, legend: document.getElementById("mapLegend").textContent };
  });
  ok(`/ ${withGeom}: dashed diverted path drawn (published geometry)`, ui.dashedAmber >= 1, `${ui.dashedAmber} amber polyline(s)`);
  ok("/ legend explains the diversion symbols", /Diversion — current path/.test(ui.legend));
}

/* ── /v2 ──────────────────────────────────────────────────────────────────── */
if (withGeom) {
  const p2 = await browser.newPage();
  await wire(p2); watch(p2, "/v2");
  await p2.setViewport({ width: 1280, height: 800 });
  await p2.goto(BASE + "/v2", { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2500);
  await p2.click("#routeSearch");
  await p2.type("#routeSearch", withGeom, { delay: 40 });
  await sleep(900);
  await p2.keyboard.press("Enter");
  await sleep(7000);
  const v2ui = await p2.evaluate(() => {
    let amber = 0, red = 0;   // v2 map is preferCanvas — verify by pixel
    for (const c of document.querySelectorAll("#map canvas")) {
      const ctx = c.getContext("2d"); if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b2 = d[i + 2], a = d[i + 3];
        if (a > 100 && r > 220 && g > 140 && g < 190 && b2 < 60) amber++;
        if (a > 100 && r > 220 && g < 110 && b2 > 90 && b2 < 140) red++;
      }
    }
    const cardText = document.getElementById("dossierCards")?.textContent || "";
    return { amber, red, hasCard: /Diversion/.test(cardText) };
  });
  // threshold is deliberately low: a short diversion segment at whole-route zoom rasterises
  // to only tens of pixels (sampled every 4th) — >=8 proves the dashed path drew, 0 = missing.
  ok(`/v2 ${withGeom}: diversion overlay rendered (canvas pixels)`, v2ui.amber >= 8, `amber px ${v2ui.amber}, red px ${v2ui.red}`);
  ok(`/v2 ${withGeom}: Route card carries Diversion section`, v2ui.hasCard);
}

ok("zero JS errors across both apps", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n===== verify-diversions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
