/**
 * fetch-accidents.js — DfT STATS19 road-safety data (bus/coach-involved collisions).
 *
 * Source: DfT "Road accidents and safety statistics" open data (data.dft.gov.uk).
 *   collision table  https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-{YEAR}.csv
 *   vehicle table    https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-vehicle-{YEAR}.csv
 * Cadence: ANNUAL (DfT publishes the prior year's STATS19 the following autumn),
 *   so the newest available year ~= currentYear-2. The weekly pipeline re-pulls
 *   it cheaply because it's a sticky cache — unchanged years just re-confirm.
 *
 * We keep BUS/COACH-involved collisions in Greater London. The collision table
 * carries geometry + severity; the vehicle table carries vehicle_type. We join
 * on collision_index and keep collisions where any vehicle is a bus/coach
 * (vehicle_type 10 = minibus 8-16, 11 = bus/coach 17+). collision_severity
 * 1/2/3 -> fatal/serious/slight; date is DD/MM/YYYY; borough is the ONS
 * local-authority district code. London filter: M25-ish bbox.
 *
 * These CSVs are large (~100k+ rows/year, several MB). We STREAM the response
 * and parse line-by-line, keeping only matching rows — never buffering a whole
 * file. Robust: per-request timeout; soft per-year failure (a failed year is
 * skipped, the rest still land); if the whole pull degrades we keep the last
 * good cache rather than overwriting it with nothing.
 *
 * Output: data/source/accidents.json (sticky cache, force-committed across runs)
 *   { generatedAt, source, sample, years, bbox, count, accidents: [
 *       { id, lat, lng, severity, date(YYYY-MM-DD), borough, vehicles,
 *         roadType, speedLimit, junction, light, weather, roadSurface } ] }
 *   The trailing six are decoded STATS19 collision-context attributes (clean labels).
 *
 * Run: npm run fetch-accidents
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { userAgentHeaders } from './_lib/http.js';
import { loadJsonCache, atomicWriteJson } from './_lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'accidents.json');

const BASE = 'https://data.dft.gov.uk/road-accidents-safety-data';
const collisionUrl = (y) => `${BASE}/dft-road-casualty-statistics-collision-${y}.csv`;
const vehicleUrl   = (y) => `${BASE}/dft-road-casualty-statistics-vehicle-${y}.csv`;
const SCRIPT = 'accidents';

// Greater London (M25-ish) bounding box. [minLng, minLat, maxLng, maxLat]
const LONDON_BBOX = [-0.55, 51.25, 0.30, 51.71];
const BUS_TYPES   = new Set(['10', '11']);              // 10 = minibus, 11 = bus/coach
const SEVERITY    = { '1': 'fatal', '2': 'serious', '3': 'slight' };

// STATS19 lookup-code -> clean label (DfT Road-Safety Open Dataset guide). Decoded at
// the boundary so the warehouse lands human-readable values. Missing/unknown -> null.
// Mirrors pipeline/sources/stats19.js — keep the two in sync.
const ROAD_TYPE = { '1': 'Roundabout', '2': 'One-way street', '3': 'Dual carriageway', '6': 'Single carriageway', '7': 'Slip road', '12': 'One-way/slip' };
const JUNCTION  = { '0': 'Not at junction', '1': 'Roundabout', '2': 'Mini-roundabout', '3': 'T/staggered', '5': 'Slip road', '6': 'Crossroads', '7': 'Multi-arm', '8': 'Private drive', '9': 'Other junction' };
const LIGHT     = { '1': 'Daylight', '4': 'Dark — lit', '5': 'Dark — unlit', '6': 'Dark — no lighting', '7': 'Dark — unknown' };
const WEATHER   = { '1': 'Fine', '2': 'Raining', '3': 'Snowing', '4': 'Fine + winds', '5': 'Raining + winds', '6': 'Snowing + winds', '7': 'Fog/mist', '8': 'Other' };
const SURFACE   = { '1': 'Dry', '2': 'Wet/damp', '3': 'Snow', '4': 'Frost/ice', '5': 'Flood', '6': 'Oil/diesel', '7': 'Mud' };
const decode = (map, v) => map[(v == null ? '' : String(v)).trim()] || null;
const speedLimit = (v) => { const n = parseInt(v, 10); return n >= 20 && n <= 70 ? `${n} mph` : null; };

// Most recent three published years (newest first). currentYear-2 is the
// newest DfT normally has; we ask for a small window so a single late-publishing
// year doesn't sink the pull.
const YEARS = [2023, 2022, 2021];

const DEFAULT_TIMEOUT_MS = 120_000;                     // multi-MB streams; allow slow

/* ── minimal CSV field splitter (handles quoted fields with commas) ── */
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Stream a CSV URL line-by-line, calling onRow(fieldsArray, headerIndexMap) per data row. */
async function streamCsv(url, onRow, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: userAgentHeaders(SCRIPT, { Accept: 'text/csv' }), signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', header = null, idx = null;
    const handleLine = (line) => {
      if (line === '') return;
      const fields = splitCsv(line);
      if (!header) {
        header = fields;
        idx = {};
        header.forEach((h, i) => { idx[h.trim()] = i; });
        return;
      }
      onRow(fields, idx);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf.length) { let line = buf; if (line.endsWith('\r')) line = line.slice(0, -1); handleLine(line); }
  } finally {
    clearTimeout(timer);
  }
}

function inBbox(lng, lat, [minLng, minLat, maxLng, maxLat]) {
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

/** DD/MM/YYYY -> YYYY-MM-DD (STATS19 date format). */
function isoDate(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((d || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Fetch + filter one STATS19 year into bus-involved Greater-London collisions.
 * Pass 1 streams the vehicle table -> set of collision_index that include a bus/coach.
 * Pass 2 streams the collision table -> keep matching, in-bbox rows with valid coords.
 * Returns the accidents array for that year. Throws on a hard fetch failure.
 */
async function fetchYear(year, timeoutMs) {
  const busCollisions = new Set();
  await streamCsv(vehicleUrl(year), (f, idx) => {
    const vt = (f[idx.vehicle_type] || '').trim();
    if (BUS_TYPES.has(vt)) busCollisions.add((f[idx.collision_index] || '').trim());
  }, { timeoutMs });

  if (busCollisions.size === 0) return [];

  const accidents = [];
  await streamCsv(collisionUrl(year), (f, idx) => {
    const id = (f[idx.collision_index] || '').trim();
    if (!busCollisions.has(id)) return;
    const lng = Number(f[idx.longitude]);
    const lat = Number(f[idx.latitude]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (!inBbox(lng, lat, LONDON_BBOX)) return;
    const sev = SEVERITY[(f[idx.collision_severity] || '').trim()];
    if (!sev) return;
    const nv = parseInt(f[idx.number_of_vehicles], 10);
    const lad = idx.local_authority_ons_district != null
      ? (f[idx.local_authority_ons_district] || '').trim() : '';
    const at = (col) => (idx[col] != null ? f[idx[col]] : '');
    accidents.push({
      id,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      severity: sev,
      date: isoDate(f[idx.date]),
      borough: lad && lad !== '-1' ? lad : null,
      vehicles: Number.isFinite(nv) && nv > 0 ? nv : null,
      // decoded collision-context attributes (clean labels; missing/unknown -> null)
      roadType: decode(ROAD_TYPE, at('road_type')),
      speedLimit: speedLimit(at('speed_limit')),
      junction: decode(JUNCTION, at('junction_detail_historic')),  // classic 0–9 lookup
      light: decode(LIGHT, at('light_conditions')),
      weather: decode(WEATHER, at('weather_conditions')),
      roadSurface: decode(SURFACE, at('road_surface_conditions')),
    });
  }, { timeoutMs });

  return accidents;
}

async function main() {
  // Last-good cache: if the whole pull degrades we re-emit this rather than
  // overwriting good data with nothing (graceful degradation).
  const prev = loadJsonCache(OUT_PATH, null);

  const all = [];
  const seen = new Set();
  const landed = [];
  const errors = [];

  for (const y of YEARS) {
    try {
      const rows = await fetchYear(y, DEFAULT_TIMEOUT_MS);
      let added = 0;
      for (const a of rows) {
        if (a.id && seen.has(a.id)) continue;         // de-dup across years (defensive)
        if (a.id) seen.add(a.id);
        all.push(a);
        added++;
      }
      if (added) landed.push(y);
      console.log(`  stats19 ${y}: ${added} bus-involved London collisions`);
    } catch (e) {
      errors.push({ year: y, error: e.message });
      console.warn(`  stats19 ${y}: failed (${e.message}) — skipping that year`);
    }
  }

  if (!all.length) {
    // Nothing landed. Keep last-good if we have it; otherwise fail soft-empty.
    if (prev && Array.isArray(prev.accidents) && prev.accidents.length) {
      console.warn('  No fresh STATS19 data — keeping last-good accidents cache.');
      return;
    }
    throw new Error(`no STATS19 data fetched and no cache to fall back on (errors: ${errors.length})`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'DfT STATS19 road safety data (collision + vehicle tables, bus/coach-involved)',
    sample: false,
    years: landed,
    bbox: LONDON_BBOX,
    count: all.length,
    accidents: all,
  };
  atomicWriteJson(OUT_PATH, out);
  console.log(`  Wrote ${all.length} collisions across years [${landed.join(', ')}] -> ${path.relative(ROOT, OUT_PATH)}`);
  if (errors.length) console.log(`  ${errors.length} year(s) soft-failed.`);
}

main().catch((err) => {
  // Soft-fail: keep last-known-good (already on disk) and let the pipeline
  // continue — the push step reads whatever cache is present.
  console.warn(`fetch-accidents failed (soft): ${err.message}`);
  process.exit(1);
});
