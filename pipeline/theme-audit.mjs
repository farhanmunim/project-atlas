/**
 * theme-audit.mjs — render Atlas in dark + light, screenshot, and scan for
 * low-contrast (odd) colourings. Verification per the audit framework.
 *   node pipeline/theme-audit.mjs   (server must be running on :8000)
 */
import puppeteer from "puppeteer";

const URL = "http://localhost:8000/index.html";
const KEY = "transit-instruments:settings";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

for (const theme of ["dark", "light"]) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((k, t) => localStorage.setItem(k, JSON.stringify({ theme: t })), KEY, theme);
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelectorAll("#routelist .routeitem").length > 0, { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `theme-${theme}-network.png` });
  await page.evaluate(() => { const b = document.querySelector("#routelist .routeitem"); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `theme-${theme}-route.png` });

  const findings = await page.evaluate(() => {
    const parse = (c) => { if (!c) return null; const m = c.match(/[\d.]+/g); if (!m) return null; let v = m.map(Number); if (c.includes("srgb")) v = v.map((x, i) => (i < 3 ? Math.round(x * 255) : x)); return v; };
    const rl = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = (r) => 0.2126 * rl(r[0]) + 0.7152 * rl(r[1]) + 0.0722 * rl(r[2]);
    const effBg = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && (c.length < 4 || c[3] > 0)) return c; e = e.parentElement; } return [255, 255, 255]; };
    const sels = ".badge .txt,.mcard .v,.mcard .k,.pill,.mapctl button,.kv .v,.kv .k,.selstat,.routeitem .rtype,.routeitem .badge-no,.chip,.chip2,.metric-h,.fil-h,.plegend span,.ctx-head h2,.ctx-head .domain,.ltabs button,.tab,.btn,.cnt,.rail-head h2,.res,.maplegend .lr,.mapnote";
    const out = [];
    for (const el of document.querySelectorAll(sels)) {
      if (!el.offsetParent) continue;
      const st = getComputedStyle(el); const fg = parse(st.color); if (!fg) continue;
      const bg = effBg(el);
      const ratio = (Math.max(L(fg), L(bg)) + 0.05) / (Math.min(L(fg), L(bg)) + 0.05);
      if (ratio < 3) out.push({ sel: el.className || el.tagName, txt: (el.textContent || "").trim().slice(0, 22), fg: st.color, bg: `rgb(${bg.slice(0, 3).join(",")})`, ratio: +ratio.toFixed(2) });
    }
    return out;
  });
  console.log(`\n=== ${theme}: ${findings.length} low-contrast element(s) (<3:1) ===`);
  findings.sort((a, b) => a.ratio - b.ratio).slice(0, 40).forEach((f) => console.log(`  ${f.ratio}  ${f.sel}  | "${f.txt}" | ${f.fg} on ${f.bg}`));
}
await browser.close();
console.log("\nscreenshots: theme-{dark,light}-{network,route}.png");
