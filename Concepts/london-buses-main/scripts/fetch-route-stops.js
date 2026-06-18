import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-route-stops.js — Per-route stop lists (TfL API)
 *
 * Calls /Line/{id}/StopPoints for every bus route and produces two files:
 *
 *   data/route_stops.json — per-route stop list (ordered as TfL returns):
 *     { generated_at_utc, route_count,
 *       routes: { "1": [{ id: "490000001N", towards: "Hampstead" }, ...] } }
 *
 *   data/stops.json — canonical stop registry + reverse index:
 *     { generated_at_utc, stop_count,
 *       stops: { "490000001N": { name, indicator, lat, lon, routes: ["1","2"] } } }
 *
 * Run: npm run fetch-route-stops
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUTE_STOPS_PATH = path.join(DATA_DIR, 'route_stops.json');
const STOPS_PATH = path.join(DATA_DIR, 'stops.json');
const BASE_URL = 'https://api.tfl.gov.uk';
const SCRIPT = 'route-stops';

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

// ── Concurrency helper with pacing ───────────────────────────────────────────
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

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching bus line list from TfL...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  const routeIds = [...new Set(lines.map(l => String(l.id).toUpperCase()))].sort();
  console.log(`  ${routeIds.length} routes found`);

  /** @type {Record<string, string[]>} */
  const routeStops = {};
  /** @type {Map<string, { name: string, indicator: string|null, lat: number, lon: number, routes: Set<string> }>} */
  const stopRegistry = new Map();
  const failed = [];
  let done = 0;

  await batchRun(routeIds, async (id) => {
    try {
      const data = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/StopPoints`));
      const stops = Array.isArray(data) ? data : (data?.value ?? []);

      const stopsForRoute = [];
      const seen = new Set();
      for (const s of stops) {
        const naptan = String(s?.naptanId ?? '').trim();
        const lat = Number(s?.lat);
        const lon = Number(s?.lon);
        if (!naptan || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (seen.has(naptan)) continue;
        seen.add(naptan);

        const towardsRaw = Array.isArray(s?.additionalProperties)
          ? s.additionalProperties.find(p => p?.key === 'Towards')?.value
          : null;
        const towards = towardsRaw ? String(towardsRaw).trim() : null;
        stopsForRoute.push(towards ? { id: naptan, towards } : { id: naptan });

        let entry = stopRegistry.get(naptan);
        if (!entry) {
          entry = {
            name: String(s?.commonName ?? 'Stop').trim() || 'Stop',
            indicator: s?.indicator ? String(s.indicator).trim() : null,
            lat: round6(lat),
            lon: round6(lon),
            routes: new Set(),
          };
          stopRegistry.set(naptan, entry);
        }
        entry.routes.add(id);
      }

      if (stopsForRoute.length) routeStops[id] = stopsForRoute;
      else failed.push(id);
    } catch (err) {
      failed.push(id);
    }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${routeIds.length}`);
  }, 4, 300);

  // Sort routes + stops for deterministic output
  const sortedRoutes = {};
  for (const k of Object.keys(routeStops).sort()) sortedRoutes[k] = routeStops[k];

  const sortedStops = {};
  for (const k of [...stopRegistry.keys()].sort()) {
    const e = stopRegistry.get(k);
    sortedStops[k] = {
      name: e.name,
      indicator: e.indicator,
      lat: e.lat,
      lon: e.lon,
      routes: [...e.routes].sort(),
    };
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    ROUTE_STOPS_PATH,
    JSON.stringify({
      generated_at_utc: now,
      route_count: Object.keys(sortedRoutes).length,
      routes: sortedRoutes,
    }, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    STOPS_PATH,
    JSON.stringify({
      generated_at_utc: now,
      stop_count: Object.keys(sortedStops).length,
      stops: sortedStops,
    }, null, 2) + '\n',
    'utf8'
  );

  console.log(`Wrote ${Object.keys(sortedRoutes).length} routes → ${ROUTE_STOPS_PATH}`);
  console.log(`Wrote ${Object.keys(sortedStops).length} unique stops → ${STOPS_PATH}`);
  if (failed.length) console.warn(`  ${failed.length} routes returned no stops: ${failed.slice(0, 20).join(', ')}${failed.length > 20 ? '…' : ''}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
