import puppeteer from "puppeteer";
const URL = process.argv[2] || "http://localhost:8137/";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("requestfailed", r => { const u = r.url(); if (/favicon\.svg$/.test(u)) errors.push("favicon request failed: " + u); });

await page.setViewport({ width: 1440, height: 900 });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 45000 });
await new Promise(r => setTimeout(r, 1200));

const checks = {};

// 1. head meta + favicon
checks.head = await page.evaluate(() => ({
  title: document.title,
  desc: !!document.querySelector('meta[name="description"]'),
  favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href") || null,
  og: document.querySelectorAll('meta[property^="og:"]').length,
  tw: document.querySelectorAll('meta[name^="twitter:"]').length,
}));

// 2. colour toggle order (Operator should be first)
checks.toggle = await page.evaluate(() => {
  const seg = document.querySelector('.seg[aria-label="Colour routes by"]');
  return seg ? [...seg.querySelectorAll("button")].map(b => b.textContent.trim()) : null;
});

// 3. operator setting gone
checks.operatorSettingGone = await page.evaluate(() => !document.getElementById("setOperator"));

// 4. settings modal centered
await page.evaluate(() => document.getElementById("settingsBtn").click());
await new Promise(r => setTimeout(r, 300));
checks.modal = await page.evaluate(() => {
  const d = document.getElementById("settings");
  if (!d || !d.open) return { open: false };
  const r = d.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return {
    open: true,
    dxFromCenter: Math.round(cx - innerWidth / 2),
    dyFromCenter: Math.round(cy - innerHeight / 2),
    fields: [...d.querySelectorAll(".dlg-body .field label")].map(l => l.textContent.trim().split("—")[0].trim()),
  };
});
await page.evaluate(() => document.getElementById("settings").close());

// 5. large data SVG not collapsed (favicon-style icons fine; check the live ring)
checks.ringSvg = await page.evaluate(() => {
  const s = document.querySelector("#liveRing svg") || document.querySelector(".livering svg");
  if (!s) return "n/a";
  const r = s.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});

// 6. horizontal overflow at 1440, 1100, 320
const overflow = {};
for (const w of [1440, 1100, 768, 320]) {
  await page.setViewport({ width: w, height: 900 });
  await new Promise(r => setTimeout(r, 250));
  overflow[w] = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
checks.overflowPx = overflow;

console.log(JSON.stringify({ errors, checks }, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);
