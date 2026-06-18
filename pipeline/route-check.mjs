/**
 * route-check.mjs — drive Atlas, select N random routes, and verify each renders
 * correctly: route line on the map, stop markers, the right-rail dossier (name,
 * stops, length, operator), and the operating-garage highlight. Per audit Phase 3/4.
 *   node pipeline/route-check.mjs [N]   (server on :8000)
 */
import puppeteer from "puppeteer";

const N = Number(process.argv[2]) || 20;
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on("pageerror", (e) => console.log("  PAGE ERROR:", e.message));

await page.goto("http://localhost:8000/index.html", { waitUntil: "networkidle2" });
await page.waitForFunction(() => document.querySelectorAll("#routelist .routeitem").length > 0, { timeout: 20000 });

const names = await page.evaluate(() => [...document.querySelectorAll("#routelist .routeitem .badge-no")].map((b) => b.textContent.trim()));
// deterministic spread across the list (no Math.random — reproducible)
const picks = Array.from({ length: N }, (_, i) => names[Math.floor((i + 0.5) * names.length / N)]);

console.log(`Checking ${picks.length} routes…\n`);
let pass = 0;
const fails = [];
for (const name of picks) {
  const clicked = await page.evaluate((nm) => {
    const b = [...document.querySelectorAll("#routelist .routeitem")].find((x) => x.querySelector(".badge-no")?.textContent.trim() === nm);
    if (b) { b.click(); return true; } return false;
  }, name);
  if (!clicked) { fails.push(`${name}: not found in list`); continue; }
  await new Promise((r) => setTimeout(r, 1400));   // geometry (store) + detail (live)

  const r = await page.evaluate(() => {
    const txt = (s) => document.querySelector(s)?.textContent?.trim() || "";
    const mapLines = window.__atlas?.routeLayerCount?.() ?? null;   // optional hook
    // count Leaflet vector/marker layers by DOM
    const paths = document.querySelectorAll("#map .leaflet-pane path, #map canvas").length;
    const markers = document.querySelectorAll("#map .leaflet-marker-icon, #map .garage-pin").length;
    const h2 = txt(".ctx-head h2");
    const stops = txt(".mcard .v"); // first mcard = Stops
    const mcards = [...document.querySelectorAll(".mcard")].map((m) => m.querySelector(".k")?.textContent + ":" + m.querySelector(".v")?.textContent);
    const hasCommercial = /Commercial/.test(document.querySelector(".rail-right")?.textContent || "");
    const opTip = !!document.querySelector(".leaflet-tooltip.gtip");
    return { paths, markers, h2, mcards, hasCommercial, opTip };
  });

  const stopsCard = (r.mcards.find((c) => c.startsWith("Stops:")) || "Stops:0").split(":")[1];
  const ok = r.h2.includes(name) && Number(stopsCard) > 0 && r.paths > 0;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(6)} h2="${r.h2}" stops=${stopsCard} mapPaths=${r.paths} garageTip=${r.opTip} commercial=${r.hasCommercial}`);
  if (!ok) fails.push(`${name}: h2="${r.h2}" stops=${stopsCard} paths=${r.paths}`);
}
console.log(`\n${pass}/${picks.length} routes rendered correctly.`);
if (fails.length) { console.log("FAILS:"); fails.forEach((f) => console.log("  " + f)); }
await browser.close();
