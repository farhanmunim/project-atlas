/**
 * fetch-crowding.js — TfL BUSTO bus crowding (load / capacity / V-over-C).
 *
 * Source: TfL "BUSTO" open data (crowding.data.tfl.gov.uk, an S3 bucket).
 *   bucket  https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk/
 *   file    BUSTO/<YYYY-YYYY>/<YR> MAX DEMAND HOUR BY ROUTE BY TIMEBAND All Routes.csv
 * Cadence: ANNUAL. The CSV is ~98 MB / ~800k stop-rows; we STREAM it and reduce to
 * ONE record per route — the busiest point (max V/C = HourLoad ÷ HourCapacity at the
 * max-demand hour), banded comfortable→crowded, plus the per-day-type peak.
 *
 * Conditional: HEAD the file for Last-Modified and SKIP the (large) download when our
 * cache already covers that version — so the weekly Supabase refresh is cheap between
 * the annual BUSTO releases. On any failure we keep the last-good cache, never empty it.
 *
 * Output: data/source/crowding.json (sticky cache)
 *   { generatedAt, source, year, sourceFile, lastModified, count,
 *     routes: { [route]: { peakVC, band, load, capacity, seats, boardings, dayType,
 *       time, timeband, direction, stopcode, stopname, stopSeq, maxLoad, maxCapacity,
 *       byDay: { Weekday|Saturday|Sunday: { vc } } } } }
 *
 * Run: npm run fetch-crowding
 */

import path from 'path';
import https from 'https';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { userAgentHeaders } from './_lib/http.js';
import { loadJsonCache, atomicWriteJson } from './_lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'crowding.json');

const BUCKET = 'https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk';
const STREAM_TIMEOUT_MS = 180_000;
const MIN_ROUTES = 300;

// crowding bands on peak V/C (kept in lockstep with pipeline/sources/busto.js)
const BANDS = [
  { key: 'comfortable', max: 0.5 },
  { key: 'moderate',    max: 0.65 },
  { key: 'busy',        max: 0.8 },
  { key: 'crowded',     max: Infinity },
];
const bandOf = (vc) => { for (const b of BANDS) if (vc < b.max) return b.key; return 'crowded'; };

function s3Get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: userAgentHeaders('fetch-crowding') }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`S3 HTTP ${res.statusCode}`)); return; }
      let xml = ''; res.setEncoding('utf8');
      res.on('data', (c) => (xml += c)); res.on('end', () => resolve(xml)); res.on('error', reject);
    }).on('error', reject);
  });
}
const matchAll = (re, s) => { const out = []; let m; while ((m = re.exec(s))) out.push(m[1]); return out; };

async function discoverLatest() {
  const yearsXml = await s3Get(`${BUCKET}/?list-type=2&delimiter=/&prefix=${encodeURIComponent('BUSTO/')}`);
  const years = matchAll(/<Prefix>BUSTO\/([0-9]{4}-[0-9]{4})\/<\/Prefix>/g, yearsXml).sort();
  if (!years.length) throw new Error('BUSTO: no year folders');
  const year = years[years.length - 1];
  const filesXml = await s3Get(`${BUCKET}/?list-type=2&delimiter=/&prefix=${encodeURIComponent(`BUSTO/${year}/`)}`);
  const keys = matchAll(/<Key>([^<]+)<\/Key>/g, filesXml).map((k) => k.replace(/&amp;/g, '&'));
  const key = keys.find((k) => /MAX DEMAND HOUR BY ROUTE BY TIMEBAND All Routes\.csv$/i.test(k));
  if (!key) throw new Error(`BUSTO: MAX DEMAND file not found in ${year}`);
  return { year, key, url: `${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}` };
}

function headLastModified(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', headers: userAgentHeaders('fetch-crowding') }, (res) => {
      res.resume(); resolve(res.headers['last-modified'] || null);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20_000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const r = (n, d = 1) => { const p = 10 ** d; return Math.round(n * p) / p; };

async function streamAggregate(url) {
  const routes = new Map();
  let header = null, parsed = 0, bad = 0;
  await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: userAgentHeaders('fetch-crowding') }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`BUSTO CSV HTTP ${res.statusCode}`)); return; }
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line) return;
        if (header === null) { header = line; return; }
        const c = line.split(',');
        if (c.length < 15) { bad++; return; }
        const len = c.length;
        const vc = num(c[len - 1]), seats = num(c[len - 2]), cap = num(c[len - 3]),
              load = num(c[len - 4]), boardings = num(c[len - 6]), stopSeq = num(c[len - 7]);
        const route = c[4], dayType = c[1], timeband = num(c[2]), time = c[3], direction = c[5], stopcode = c[6];
        const stopname = c.slice(7, len - 7).join(',').trim();
        if (!route || !Number.isFinite(vc)) { bad++; return; }
        parsed++;
        let agg = routes.get(route);
        if (!agg) { agg = { route, peak: null, byDay: {}, maxLoad: 0, maxCapacity: 0 }; routes.set(route, agg); }
        if (load > agg.maxLoad) agg.maxLoad = load;
        if (cap > agg.maxCapacity) agg.maxCapacity = cap;
        const rec = { vc: r(vc, 4), load: r(load), capacity: r(cap), seats: r(seats), boardings: r(boardings),
                      dayType, timeband, time, direction, stopcode, stopname, stopSeq };
        if (!agg.peak || vc > agg.peak.vc) agg.peak = rec;
        const d = agg.byDay[dayType];
        if (!d || vc > d.vc) agg.byDay[dayType] = rec;
      });
      rl.on('close', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(STREAM_TIMEOUT_MS, () => req.destroy(new Error('BUSTO stream timeout')));
  });
  return { routes, parsed, bad };
}

function shape({ year, key, lastModified, routesMap }) {
  const routes = {};
  for (const a of routesMap.values()) {
    const p = a.peak; if (!p) continue;
    const byDay = {};
    for (const k of Object.keys(a.byDay)) byDay[k] = { vc: a.byDay[k].vc };
    routes[a.route] = {
      peakVC: p.vc, band: bandOf(p.vc), load: p.load, capacity: p.capacity, seats: p.seats, boardings: p.boardings,
      dayType: p.dayType, time: p.time, timeband: p.timeband, direction: p.direction, stopcode: p.stopcode,
      stopname: p.stopname, stopSeq: p.stopSeq, maxLoad: r(a.maxLoad), maxCapacity: r(a.maxCapacity), byDay,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    source: `TfL BUSTO ${year} (crowding.data.tfl.gov.uk)`,
    year, sourceFile: key, lastModified: lastModified || null,
    count: Object.keys(routes).length, routes,
  };
}

async function main() {
  const cache = loadJsonCache(OUT_PATH, null);
  let latest;
  try { latest = await discoverLatest(); }
  catch (e) {
    console.warn(`  crowding: discovery failed (${e.message}) — keeping last-good`);
    if (cache?.count >= MIN_ROUTES) return;
    throw e;
  }
  const lastModified = await headLastModified(latest.url);

  // Conditional skip: same version already cached → don't re-pull 98 MB.
  if (cache && cache.year === latest.year && cache.count >= MIN_ROUTES && lastModified && cache.lastModified === lastModified) {
    console.log(`  crowding: unchanged (${latest.year}, ${cache.count} routes) — keeping cache`);
    return;
  }

  let agg;
  try { agg = await streamAggregate(latest.url); }
  catch (e) {
    console.warn(`  crowding: stream failed (${e.message}) — keeping last-good`);
    if (cache?.count >= MIN_ROUTES) return;
    throw e;
  }
  if (agg.routes.size < MIN_ROUTES) {
    console.warn(`  crowding: thin pull (${agg.routes.size} < ${MIN_ROUTES}) — keeping last-good`);
    if (cache?.count >= MIN_ROUTES) return;
    throw new Error(`crowding: only ${agg.routes.size} routes`);
  }
  const out = shape({ year: latest.year, key: latest.key, lastModified, routesMap: agg.routes });
  atomicWriteJson(OUT_PATH, out);
  console.log(`  crowding: ${out.count} routes (${out.year}) · parsed ${agg.parsed} rows (${agg.bad} skipped) → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((e) => { console.error(`fetch-crowding failed: ${e.message}`); process.exit(1); });
