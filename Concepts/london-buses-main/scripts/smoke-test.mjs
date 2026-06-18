// Headless smoke test against the live (or local) site.
// Drives a representative set of scenarios and asserts no console errors /
// no page errors, and that the expected DOM state is reached.
//
// Usage: SMOKE_URL=http://127.0.0.1:5500 node scripts/smoke-test.mjs
// Default: https://london-buses.farhan.app/
import puppeteer from 'puppeteer';

const URL = process.env.SMOKE_URL || 'https://london-buses.farhan.app/';

const browser = await puppeteer.launch({ headless: 'new' });
const page    = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const log = [];
const cerrors = [];
const pageErrors = [];
const reqFails = [];
page.on('console', m => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || t === 'warn') cerrors.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', e => pageErrors.push(`${e.message}`));
page.on('requestfailed', r => {
  const url = r.url();
  // Ignore analytics / tracking blocks — they happen in headless even on a healthy page.
  if (/google-analytics|googletagmanager|doubleclick|gtag/.test(url)) return;
  reqFails.push(`${url} → ${r.failure()?.errorText}`);
});

function assert(name, cond, extra) {
  log.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + JSON.stringify(extra) : ''}`);
}

async function search(id) {
  await page.evaluate(() => {
    const i = document.getElementById('globalInput');
    if (i) { i.value = ''; i.focus(); }
  });
  await page.focus('#globalInput');
  for (const ch of id) await page.keyboard.type(ch, { delay: 30 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1200));
}

async function clearSearch() {
  await page.evaluate(() => document.getElementById('searchClear')?.click());
  await new Promise(r => setTimeout(r, 300));
}

console.log(`→ goto ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });

// ── 1. Initial boot ──────────────────────────────────────────────────────────
await page.waitForFunction(() => {
  const el = document.getElementById('routeCount');
  return el && /\d/.test(el.textContent ?? '');
}, { timeout: 30_000 }).catch(() => {});

const boot = await page.evaluate(() => ({
  routesShownText: document.getElementById('routeCount')?.textContent?.trim(),
  tileCount:       document.querySelectorAll('.leaflet-tile-loaded').length,
  searchInput:     !!document.getElementById('globalInput'),
  routeNoResult:   !!document.getElementById('routeNoResult'),
  tplExists:       !!document.getElementById('tpl-route-card'),
}));
assert('boot — routes shown rendered',         /\d/.test(boot.routesShownText || ''), boot.routesShownText);
assert('boot — map tiles loaded',              boot.tileCount > 0, { tiles: boot.tileCount });
assert('boot — search input present',          boot.searchInput);
assert('boot — route-card template present',   boot.tplExists);

// ── 2. Single-route search (a range — single deck / double deck / night) ────
const ROUTES = ['339', '100', '1', '70', 'N73', '25'];
for (const id of ROUTES) {
  const before = cerrors.length + pageErrors.length;
  await search(id);
  const state = await page.evaluate(() => {
    const results = document.getElementById('routeResults');
    const cards   = results?.querySelectorAll('[data-rc-num]') ?? [];
    const noRes   = document.getElementById('routeNoResult');
    return {
      cardCount:       cards.length,
      firstCardNum:    cards[0]?.textContent?.trim(),
      noResultVisible: noRes && !noRes.hidden,
    };
  });
  assert(`route ${id} — card renders`, state.cardCount >= 1 && !state.noResultVisible, state);
  const newErrs = [...cerrors.slice(before), ...pageErrors.slice(before)];
  assert(`route ${id} — no console errors`, newErrs.length === 0, newErrs);
  await clearSearch();
}

// ── 3. Multi-route mode (two pills) ──────────────────────────────────────────
await search('25');
await search('100');
const multi = await page.evaluate(() => ({
  cards: document.querySelectorAll('#routeResults [data-rc-num]').length,
  pills: document.querySelectorAll('#searchPills .search-pill').length,
}));
assert('multi — two pills', multi.pills >= 2, multi);
assert('multi — two cards stacked', multi.cards >= 2, multi);
await clearSearch();

// ── 4. Sidebar operator filter ───────────────────────────────────────────────
// Click an operator chip and read filtered count.
const opBefore = await page.$eval('#routeCount', el => el.textContent.trim()).catch(() => '');
const opChip = await page.$('button.pill[data-filter="operator"][data-val="Stagecoach London"]');
if (opChip) {
  await opChip.click();
  await new Promise(r => setTimeout(r, 600));
  const opAfter = await page.$eval('#routeCount', el => el.textContent.trim()).catch(() => '');
  assert('filter — Stagecoach reduces route count', opBefore !== opAfter, { before: opBefore, after: opAfter });
  await opChip.click();
  await new Promise(r => setTimeout(r, 400));
} else {
  assert('filter — operator chip found', false, 'no selector matched');
}

// ── 5. Modals open ───────────────────────────────────────────────────────────
const aboutBtn = await page.$('#about-btn, [data-action="open-about"], .footer-link[href*=about]');
if (aboutBtn) {
  await aboutBtn.click();
  await new Promise(r => setTimeout(r, 400));
  const modalOpen = await page.evaluate(() => !!document.querySelector('#about-modal:not([hidden]), .modal.is-open'));
  assert('modal — About opens', modalOpen);
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 200));
} else {
  assert('modal — About button found', false);
}

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = log.filter(l => !l.pass);
console.log('\n=== SMOKE SUMMARY ===');
console.log(`${log.length - failed.length}/${log.length} pass · ${failed.length} fail`);
console.log(`console errors: ${cerrors.length}`);
console.log(`page errors:    ${pageErrors.length}`);
console.log(`request fails:  ${reqFails.length}`);
if (cerrors.length)    console.log('\n--- console errors ---\n' + cerrors.join('\n'));
if (pageErrors.length) console.log('\n--- page errors ---\n'    + pageErrors.join('\n'));
if (reqFails.length)   console.log('\n--- failed requests ---\n' + reqFails.join('\n'));

await browser.close();
process.exit(failed.length === 0 && cerrors.length === 0 && pageErrors.length === 0 ? 0 : 1);
