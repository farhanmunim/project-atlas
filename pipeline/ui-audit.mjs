/** ui-audit.mjs — exercise every Atlas control and assert input→output. */
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 950 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
const results = [];
const ok = (name, cond, detail="") => results.push({ name, pass: !!cond, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const $txt = (sel) => p.evaluate(s => document.querySelector(s)?.textContent?.trim() || "", sel);
const $n = (sel) => p.evaluate(s => document.querySelectorAll(s).length, sel);

await p.goto("http://localhost:8000/index.html", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.clear());
await p.goto("http://localhost:8000/index.html", { waitUntil: "networkidle2" });
await p.waitForFunction(() => document.querySelectorAll("#routelist .routeitem").length > 0, { timeout: 20000 });
await sleep(2500);

// 1 defaults
ok("first-visit theme light", await p.evaluate(()=>document.documentElement.getAttribute("data-theme"))==="light");
ok("routes listed", await $n("#routelist .routeitem") > 600, `${await $n("#routelist .routeitem")}`);
ok("garages shown by default", await $n("#map .garage-pin") > 0, `${await $n("#map .garage-pin")}`);
ok("network lines drawn", await $n("#map .leaflet-pane path, #map canvas") > 0);

// 2 left tabs
await p.click("#ltab-filters"); await sleep(150);
ok("Filters tab shows filters", !(await p.evaluate(()=>document.getElementById("lpanel-filters").hidden)));
await p.click("#ltab-routes"); await sleep(150);
ok("Routes tab shows list", !(await p.evaluate(()=>document.getElementById("lpanel-routes").hidden)));

// helper: set the search box value and fire input
const setSearch = async (v) => { await p.evaluate((val)=>{ const i=document.getElementById("routeSearch"); i.value=val; i.dispatchEvent(new Event("input",{bubbles:true})); }, v); await sleep(350); };

// routes-here popup (BEFORE catchment, default zoom)
{ const mb=await p.evaluate(()=>{const m=document.getElementById("map").getBoundingClientRect();return{x:m.x+m.width/2,y:m.y+m.height/2}});
  await p.mouse.click(mb.x, mb.y); await sleep(600);
  const pills=await $n(".leaflet-popup .rpill");
  ok("routes-here popup pills", pills>0, `${pills}`);
  if(pills){ await p.click(".leaflet-popup .rpill"); await sleep(1500);
    ok("pill click selects route", (await $txt(".ctx-head h2"))!=="Network" && (await $txt(".ctx-head h2")).length>0);
    await p.click("#clearSel"); await sleep(400); } }

// 3 search filters list
await setSearch("24");
const searchCount = await $n("#routelist .routeitem");
ok("search filters list", searchCount > 0 && searchCount < 200, `${searchCount}`);

// 4 table reflects search filter (REPORTED BUG) — search + chip + while-selected
await p.click('#viewToggle [data-v="table"]'); await sleep(500);
ok("TABLE reflects active search filter", (await $n("#tableView tbody tr")) === searchCount, `table=${await $n("#tableView tbody tr")} vs list=${searchCount}`);
await setSearch("N");
ok("TABLE updates when search changes in table", (await $n("#tableView tbody tr")) === (await $n("#routelist .routeitem")), `table=${await $n("#tableView tbody tr")} vs list=${await $n("#routelist .routeitem")}`);
await setSearch("");
// chip filter while in table
await p.click("#ltab-filters"); await sleep(120);
await p.evaluate(()=>{ const c=[...document.querySelectorAll('#filters [data-g="type"]')].find(x=>/School/.test(x.textContent)); c&&c.click(); }); await sleep(350);
ok("TABLE filters via type chip", (await $n("#tableView tbody tr")) === (await $n("#routelist .routeitem")) && (await $n("#tableView tbody tr"))<200, `table=${await $n("#tableView tbody tr")}`);
await p.click("#clearFilters"); await sleep(300);
await p.click('#viewToggle [data-v="map"]'); await sleep(400);

// 5 type filter
await p.click("#ltab-filters"); await sleep(150);
await p.evaluate(()=>{ const c=[...document.querySelectorAll('#filters [data-g="type"]')].find(x=>/Night/.test(x.textContent)); c&&c.click(); });
await sleep(300);
const nightList = await $n("#routelist .routeitem");
ok("type filter (Night) narrows list", nightList>0 && nightList<200, `${nightList}`);
// clear filters
await p.click("#clearFilters"); await sleep(300);
ok("clear filters restores list", await $n("#routelist .routeitem") > 600);

// 6 select a route
await p.click("#ltab-routes"); await sleep(100);
await p.evaluate(()=>{ const b=[...document.querySelectorAll("#routelist .routeitem")].find(x=>x.querySelector(".badge-no")?.textContent.trim()==="24"); b&&b.click(); });
await sleep(1600);
ok("select route → dossier", (await $txt(".ctx-head h2")).includes("24"));
ok("select route → stops in rail", await p.evaluate(()=>{const v=[...document.querySelectorAll(".mcard")].find(m=>/Stops/.test(m.textContent)); return v?+v.querySelector(".v").textContent>0:false;}));
ok("select route → garage tooltip", await $n(".leaflet-tooltip.gtip") > 0);

// 7 direction toggle
await p.click('#dirToggle [data-v="inbound"]'); await sleep(1200);
ok("direction toggle → sub inbound", (await $txt("#canvasSub")).includes("inbound"));
await p.click('#dirToggle [data-v="outbound"]'); await sleep(1200);

// 8 clear selection
await p.click("#clearSel"); await sleep(500);
ok("clear selection → back to network", (await $txt(".ctx-head h2"))==="Network" || (await $txt("#canvasTitle")).includes("Network"));

// 9 mapctl toggles
await p.click('#mapCtl [data-k="garages"]'); await sleep(400);
ok("toggle garages off", await $n("#map .garage-pin")===0);
await p.click('#mapCtl [data-k="garages"]'); await sleep(400);
ok("toggle garages on", await $n("#map .garage-pin")>0);
await p.click('#mapCtl [data-k="coper"]'); await sleep(500);
ok("colour: operator active", await p.evaluate(()=>document.querySelector('#mapCtl [data-k="coper"]').classList.contains("on")));
await p.click('#mapCtl [data-k="ctype"]'); await sleep(300);

// 9b stop toggle + garage toggle must not refit/zoom while a route is selected
await p.evaluate(()=>{ const b=[...document.querySelectorAll("#routelist .routeitem")].find(x=>x.querySelector(".badge-no")?.textContent.trim()==="24"); b&&b.click(); });
await sleep(1600);
ok("select route → garage highlight (in-place, single layer)", await $n(".leaflet-tooltip.gtip") > 0);
const stopsBefore = await $n("#map .leaflet-marker-pane path, #map canvas") >= 0 && await p.evaluate(()=>document.querySelectorAll('.leaflet-interactive').length);
const z0 = await p.evaluate(()=>map.getCenter().lat+","+map.getCenter().lng+","+map.getZoom());
await p.click('#mapCtl [data-k="garages"]'); await sleep(500);
const z1 = await p.evaluate(()=>map.getCenter().lat+","+map.getCenter().lng+","+map.getZoom());
ok("garage toggle does NOT refit/zoom while route selected", z0===z1, `${z0} vs ${z1}`);
ok("garage toggle hides operating-garage highlight too", await $n(".leaflet-tooltip.gtip") === 0);
await p.click('#mapCtl [data-k="garages"]'); await sleep(300);
ok("garage toggle back on restores highlight", await $n(".leaflet-tooltip.gtip") > 0);
await p.click('#mapCtl [data-k="stops"]'); await sleep(400);
ok("stop toggle hides stops", await p.evaluate(()=>!document.querySelector('#mapCtl [data-k="stops"]').classList.contains("on")));
await p.click('#mapCtl [data-k="stops"]'); await sleep(300);
// 9c quick "Clear all" appears while a lens is engaged; analysis + similar routes present
ok("Clear-all visible while route selected", !(await p.evaluate(()=>document.getElementById("clearAll").hidden)));
ok("Network analysis block present", await p.evaluate(()=>/Network analysis/.test(document.querySelector(".rail-right")?.textContent||"")));
ok("Similar routes section present", await p.evaluate(()=>/Similar routes/.test(document.querySelector(".rail-right")?.textContent||"")));
// 9d garage popup carries capacity stats; operator drill-down works
await p.evaluate(()=>{const g=document.querySelector("#map .garage-pin .gm"); g&&g.click();}); await sleep(500);
ok("garage popup shows capacity stats", await p.evaluate(()=>/capacity/i.test(document.querySelector(".leaflet-popup .gstats")?.textContent||"")));
await p.keyboard.press("Escape");
await p.click("#clearSel"); await sleep(400);
ok("Clear-all hidden after clearing", await p.evaluate(()=>document.getElementById("clearAll").hidden));
// operator drill-down (network operators table → operator detail → back)
await p.evaluate(()=>{const o=document.querySelector('.oprow[data-operator]'); o&&o.click();}); await sleep(500);
ok("operator drill-down opens detail", await p.evaluate(()=>!!document.querySelector('.drill[data-garage]')));
await p.click(".ctx-back"); await sleep(300);
ok("Back returns to network", (await $txt(".ctx-head h2"))==="Network");

// 10 Magnify (catchment)
await p.click("#tab-catch"); await sleep(400);
ok("Magnify shows controls", !(await p.evaluate(()=>document.getElementById("catchControls").hidden)));
const mb=await p.evaluate(()=>{const m=document.getElementById("map").getBoundingClientRect();return{x:m.x+m.width/2,y:m.y+m.height/2}});
await p.mouse.click(mb.x, mb.y); await sleep(1500);
ok("Magnify pin → zone readout in rail", await p.evaluate(()=>/In this zone|Tender cost|Routes in zone/.test(document.querySelector(".rail-right")?.textContent||"")));
await p.click("#tab-route"); await sleep(400);

// 11b numeric sort + a11y + layout
const firstNames = await p.evaluate(()=>[...document.querySelectorAll("#routelist .routeitem .badge-no")].slice(0,4).map(b=>b.textContent.trim()));
ok("route list numeric sort", parseInt(firstNames[0])<=parseInt(firstNames[1]) && parseInt(firstNames[1])<=parseInt(firstNames[2]), firstNames.join(","));
ok("icon buttons have aria-labels", (await p.evaluate(()=>[...document.querySelectorAll('#tab-route,#tab-catch,#viewToggle button,#mapCtl [data-k="routes"],#mapCtl [data-k="garages"],#exportBtn,#refresh,#themeBtn,#settingsBtn')].filter(b=>!b.getAttribute("aria-label")).length))===0);
ok("no horizontal overflow", (await p.evaluate(()=>document.documentElement.scrollWidth - window.innerWidth))<=2);

// 11c multi-select compare
await p.click('#selToggle [data-v="multi"]'); await sleep(200);
await p.evaluate(()=>{const i=[...document.querySelectorAll("#routelist .routeitem")]; i[0].click(); i[1].click();});
await sleep(1600);
ok("multi-select compares routes", /2 route/.test(await $txt(".ctx-head h2")), await $txt(".ctx-head h2"));
await p.click("#clearSel"); await sleep(300); await p.click('#selToggle [data-v="single"]'); await sleep(200);

// 12 theme + settings + units
await p.click("#themeBtn"); await sleep(400);
ok("theme toggle → dark", await p.evaluate(()=>document.documentElement.getAttribute("data-theme"))==="dark");
await p.click("#settingsBtn"); await sleep(200);
ok("settings dialog opens", await p.evaluate(()=>document.getElementById("settings").open));
await p.evaluate(()=>{const x=[...document.querySelectorAll('#setUnits button')].find(b=>b.dataset.v==="mi"); x&&x.click();}); await sleep(300);
ok("units setting (mi) applies to figures", await p.evaluate(()=>[...document.querySelectorAll(".mcard .v")].some(v=>/mi\b/.test(v.textContent))));
await p.evaluate(()=>{const x=[...document.querySelectorAll('#setUnits button')].find(b=>b.dataset.v==="km"); x&&x.click(); document.getElementById("settings").close();}); await sleep(200);

ok("NO page errors", errs.length===0, errs.join("; "));

const pass=results.filter(r=>r.pass).length;
console.log(`\n=== UI AUDIT: ${pass}/${results.length} passed ===`);
results.forEach(r=>console.log(`${r.pass?"✓":"✗"} ${r.name}${r.detail?` [${r.detail}]`:""}`));
await b.close();
process.exit(pass===results.length?0:1);
