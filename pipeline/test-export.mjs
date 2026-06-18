import puppeteer from "puppeteer";
const URL = process.argv[2] || "http://localhost:8146/";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto(URL, { waitUntil: "networkidle2", timeout: 45000 });
await new Promise(r => setTimeout(r, 1800));
// capture the CSV blob without actually downloading
await p.evaluate(() => {
  const o = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { window.__lastBlob = blob; return o(blob); };
  HTMLAnchorElement.prototype.click = function () {};   // suppress the download
});
const grab = async () => p.evaluate(async () => window.__lastBlob ? await window.__lastBlob.text() : null);

// 1) filtered VIEW export (no selection)
await p.evaluate(() => exportCurrent());
const viewCsv = await grab();

// 2) SELECTION export — pick route 5
await p.evaluate(() => { document.getElementById("ltab-routes").click(); });
await new Promise(r => setTimeout(r, 400));
await p.evaluate(() => {
  const t = [...document.querySelectorAll("#routelist .routeitem")].find(x => x.querySelector(".badge-no")?.textContent.trim() === "5");
  (t || document.querySelector("#routelist .routeitem")).click();
});
await new Promise(r => setTimeout(r, 2500));
await p.evaluate(() => exportCurrent());
const selCsv = await grab();

const summarise = (csv) => {
  if (!csv) return { ok: false };
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  return { ok: true, header: lines[0], rows: lines.length - 1, sample: lines[1] };
};
console.log(JSON.stringify({ view: summarise(viewCsv), selection: summarise(selCsv) }, null, 2));
await b.close();
