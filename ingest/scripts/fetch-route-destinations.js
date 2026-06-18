import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-route-destinations.js — Passenger-facing destination cache (TfL API)
 *
 * For every bus line, finds its origin/destination StopPoints from
 * /Line/{id}/Route, then calls /StopPoint/{stopId}/Route to get the
 * vehicleDestinationText (the blind) and destinationName (stop name
 * qualifier), aggregating by direction.
 *
 * Output shape:
 *   { "routes": { "1": {
 *       "inbound":  { "destination": "...", "qualifier": "...", "full": "..." },
 *       "outbound": { ... },
 *       "service_types": ["Regular"]
 *   } } }
 *
 * Run: npm run fetch-route-destinations
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'route_destinations.json');
const BASE_URL = 'https://api.tfl.gov.uk';
const SCRIPT = 'route-destinations';

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';
if (!API_KEY) console.warn('Warning: BUS_API_KEY not set — requests may be rate-limited');

function apiUrl(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${BASE_URL}${endpoint}${API_KEY ? `${sep}app_key=${API_KEY}` : ''}`;
}

async function fetchJson(url, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 800));
    }
  }
}

function cleanText(v) {
  let t = String(v ?? '').replace(/\u00a0/g, ' ');
  t = t.split(/\s+/).filter(Boolean).join(' ').trim();
  t = t.replace(/^\.+/, '').trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (['unknown', 'unkown', 'n/a', 'na', 'null'].includes(low)) return '';
  return t;
}

function normaliseDirection(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (['outbound', 'out', '1'].includes(t)) return 'outbound';
  if (['inbound',  'in',  '2'].includes(t)) return 'inbound';
  return t || 'unknown';
}

function compareKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildFull(primary, qualifier) {
  const main = cleanText(primary);
  const extra = cleanText(qualifier);
  if (!main) return '';
  if (!extra) return main;
  const mk = compareKey(main), ek = compareKey(extra);
  if (!ek || ek === mk || ek.includes(mk) || mk.includes(ek)) return main;
  return `${main}, ${extra}`;
}

// ── Concurrency helper with pacing ────────────────────────────────────────────
async function batchRun(items, fn, concurrency = 4, ratePerMin = 300) {
  const minInterval = ratePerMin > 0 ? Math.ceil(60_000 / ratePerMin) : 0;
  let idx = 0, nextSlot = Date.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      if (minInterval > 0) {
        const now = Date.now();
        const wait = nextSlot - now;
        nextSlot = Math.max(now, nextSlot) + minInterval;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching bus line list from TfL...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  const routeIds = [...new Set(lines.map(l => String(l.id).toUpperCase()))].sort();
  console.log(`  ${routeIds.length} routes found`);

  const stopRouteCache = new Map();
  const routes = {};
  let done = 0;

  async function getStopRoutes(stopId) {
    if (stopRouteCache.has(stopId)) return stopRouteCache.get(stopId);
    const p = fetchJson(apiUrl(`/StopPoint/${encodeURIComponent(stopId)}/Route`)).catch(() => []);
    stopRouteCache.set(stopId, p);
    return p;
  }

  await batchRun(routeIds, async (id) => {
    try {
      const line = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Route`));
      const lineArr = Array.isArray(line) ? line : [line];
      const stopIds = [];
      const seenStops = new Set();
      const serviceTypes = new Set();
      for (const l of lineArr) {
        for (const sec of (l.routeSections ?? [])) {
          if (sec.serviceType) serviceTypes.add(cleanText(sec.serviceType));
          for (const sid of [sec.originator, sec.destination]) {
            const s = cleanText(sid);
            if (!s || seenStops.has(s)) continue;
            seenStops.add(s);
            stopIds.push(s);
          }
        }
      }
      // Fetch stop route entries concurrently (they're cached across routes)
      const stopPayloads = await Promise.all(stopIds.map(getStopRoutes));

      // Per direction: count (primary, qualifier) pairs
      const dirPairs   = { outbound: new Map(), inbound: new Map(), unknown: new Map() };
      const fallback   = { outbound: new Map(), inbound: new Map(), unknown: new Map() };
      const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

      for (const payload of stopPayloads) {
        for (const e of (payload ?? [])) {
          const lineId = String(e.lineId ?? e.lineName ?? '').toUpperCase();
          if (lineId !== id) continue;
          if (e.isActive === false) continue;
          const dir = normaliseDirection(e.direction);
          if (!(dir in dirPairs)) continue;
          const primary = cleanText(e.vehicleDestinationText);
          let qualifier = cleanText(e.destinationName);
          if (primary) {
            if (compareKey(primary) === compareKey(qualifier)) qualifier = '';
            bump(dirPairs[dir], JSON.stringify([primary, qualifier]));
          } else if (qualifier) {
            bump(fallback[dir], JSON.stringify([qualifier, '']));
          }
        }
      }

      const anyPrimary = Object.values(dirPairs).some(m => m.size);
      const active = anyPrimary ? dirPairs : fallback;
      const entry = { service_types: [...serviceTypes].filter(Boolean).sort() };
      let got = false;
      for (const dir of ['outbound', 'inbound']) {
        const m = active[dir];
        if (!m || !m.size) continue;
        const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const [primary, qualifier] = JSON.parse(sorted[0][0]);
        entry[dir] = { destination: primary, qualifier, full: buildFull(primary, qualifier) };
        got = true;
      }
      if (got) routes[id] = entry;
    } catch (err) {
      // skip route on error
    }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${routeIds.length}`);
  }, 4, 300);

  // ── Fallback pass: scrape londonbusroutes.net/routes.htm for any route still
  //    missing a destination entry. The routes.htm table lists a dashed origin
  //    → ... → destination string per route, which is sufficient for a
  //    passenger-facing "From → To" summary.
  const routesNeedingFallback = routeIds.filter(id => !routes[id]);
  if (routesNeedingFallback.length) {
    console.log(`  ${routesNeedingFallback.length} routes missing destinations — trying londonbusroutes.net fallback`);
    try {
      const htmlRes = await fetchWithTimeout('http://www.londonbusroutes.net/routes.htm', {
        headers: userAgentHeaders(SCRIPT),
      });
      if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
      const html = await htmlRes.text();
      // Rows look like:
      //   <a name="M216" href="times/216.htm">216</a></TD><TD>Staines - ... - Kingston</TD>
      // Night anchors use "NN<id>" on the same pattern.
      const rowRe = /<a\s+name=["']?[MN]([A-Z0-9]+)["']?\s+href=[^>]+>([^<]+)<\/a>[\s\S]*?<TD[^>]*>([\s\S]*?)<\/TD>/gi;
      const scraped = {};
      let mm;
      while ((mm = rowRe.exec(html)) !== null) {
        const rid = (mm[2] || mm[1]).trim().toUpperCase();
        let desc = mm[3]
          .replace(/<br[^>]*>[\s\S]*$/i, '')  // drop everything after a <br> (diversion notices)
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
          if (!desc) continue;
        const parts = desc.split(/\s*-\s*/).map(p => p.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        scraped[rid] = { origin: parts[0], destination: parts[parts.length - 1] };
      }
      let filled = 0;
      for (const id of routesNeedingFallback) {
        const s = scraped[id];
        if (!s) continue;
        routes[id] = {
          service_types: [],
          outbound: { destination: s.destination, qualifier: '', full: s.destination },
          inbound:  { destination: s.origin,      qualifier: '', full: s.origin      },
        };
        filled++;
      }
      console.log(`  routes.htm fallback filled ${filled}/${routesNeedingFallback.length}`);
    } catch (err) {
      console.warn(`  routes.htm fallback skipped (${err.message})`);
    }
  }

  // ── Final hardcoded overrides for routes that neither TfL API nor
  //    routes.htm cover (typically mobility/shopper routes). Keep tiny.
  const HARDCODED = {
    '969': {
      service_types: ['Mobility'],
      outbound: { destination: 'Roehampton Vale', qualifier: 'Asda',                full: 'Roehampton Vale, Asda' },
      inbound:  { destination: 'Whitton',         qualifier: 'Gladstone Avenue',    full: 'Whitton, Gladstone Avenue' },
    },
  };
  for (const [id, entry] of Object.entries(HARDCODED)) {
    if (!routes[id]) routes[id] = entry;
  }

  const sorted = {};
  for (const k of Object.keys(routes).sort()) sorted[k] = routes[k];

  const payload = {
    generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    route_count: Object.keys(sorted).length,
    routes: sorted,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(payload), null, 2) + '\n', 'utf8');
  console.log(`Wrote ${Object.keys(sorted).length} route destinations to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
