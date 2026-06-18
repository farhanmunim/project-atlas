import puppeteer from "puppeteer";
const URL = process.argv[2] || "http://localhost:8143/";
const OUT = process.argv[3] || "panel.png";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1320, height: 1500, deviceScaleFactor: 2 });
await p.goto(URL, { waitUntil: "networkidle2", timeout: 45000 });
await new Promise(r => setTimeout(r, 1500));
// switch to Routes tab, click route "5"
await p.evaluate(() => document.getElementById("ltab-routes")?.click());
await new Promise(r => setTimeout(r, 600));
const clicked = await p.evaluate(() => {
  const btns = [...document.querySelectorAll("#routelist .routeitem")];
  const t = btns.find(b => b.querySelector(".badge-no")?.textContent.trim() === "5") || btns[0];
  if (t) { t.click(); return t.querySelector(".badge-no")?.textContent.trim(); }
  return null;
});
await new Promise(r => setTimeout(r, 2500));
// expand every collapsible group so the full dossier is visible
await p.evaluate(() => {
  document.querySelectorAll('#ctx .grp-h, #ctx [aria-expanded="false"]').forEach(h => h.click());
});
await new Promise(r => setTimeout(r, 1200));
const ctx = await p.$("#ctx");
await ctx.screenshot({ path: OUT });
console.log("selected route:", clicked, "→", OUT);
await b.close();
