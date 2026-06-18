/**
 * fetch-data.js — Route data refresh
 *
 * Downloads the latest route geometry ZIP and converts XML to per-route
 * GeoJSON. Destinations and stops are fetched by separate pipeline steps.
 *
 * Output (written to data/):
 *   routes/<id>.geojson        – LineString/MultiLineString per direction
 *   routes/index.json          – flat list of known route IDs
 *   geometry-source.json       – upstream ZIP date (for change detection)
 *
 * Usage:
 *   npm run fetch-data
 *
 * Requires Node 18+. No API keys needed — geometry is fetched from a public
 * TfL S3 bucket.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

loadEnv();
const SCRIPT = 'fetch-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUTES_DIR = path.join(DATA_DIR, 'routes');

const S3_BASE   = 'https://s3-eu-west-1.amazonaws.com/bus.data.tfl.gov.uk';
const S3_PUBLIC = 'https://bus.data.tfl.gov.uk';

const ROUTE_XML_RE = /Route_Geometry_([A-Za-z0-9]+)_(\d{8})\.xml$/i;
const SIMPLIFY_TOLERANCE = 0.00005; // Douglas-Peucker tolerance in degrees
const COORD_PRECISION = 6;

// --- Utilities ---------------------------------------------------------------

async function fetchBuffer(url) {
  const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) }, 60_000);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

// --- Geometry: Douglas-Peucker simplification --------------------------------

function ptSegDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(points, tol) {
  if (tol <= 0 || points.length <= 2) return points;
  let maxDist = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = ptSegDist(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > tol) {
    const L = simplify(points.slice(0, idx + 1), tol);
    const R = simplify(points.slice(idx), tol);
    return [...L.slice(0, -1), ...R];
  }
  return [points[0], points[points.length - 1]];
}

function roundCoord(v, precision) {
  const r = parseFloat(v.toFixed(precision));
  return r === -0 ? 0 : r;
}

// --- Step 1: Find and download the latest geometry ZIP -----------------------

async function findLatestZipKey() {
  console.log('Listing S3 bucket for latest Route_Geometry ZIP...');
  const url = `${S3_BASE}/?list-type=2&prefix=bus-geometry/`;
  const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
  if (!res.ok) throw new Error(`S3 listing failed: HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser();
  const doc = parser.parse(xml);
  const contents = doc?.ListBucketResult?.Contents;
  const keys = (Array.isArray(contents) ? contents : [contents])
    .map(c => c?.Key)
    .filter(k => typeof k === 'string' && k.endsWith('.zip'));

  const candidates = keys
    .map(k => {
      const m = k.match(/Route_Geometry_(\d{8})\.zip$/i);
      return m ? { date: m[1], key: k } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!candidates.length) throw new Error('No Route_Geometry ZIPs found in bucket');
  const latest = candidates[0];
  console.log(`  Latest ZIP: ${latest.key} (${latest.date})`);
  return latest;
}

async function downloadZip(key) {
  const url = `${S3_PUBLIC}/${key}`;
  console.log(`Downloading ${url}...`);
  const buf = await fetchBuffer(url);
  console.log(`  Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return buf;
}

// --- Step 2: Parse XML files and write GeoJSON -------------------------------

function parseRouteXml(xmlContent, routeId, dateToken) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let doc;
  try {
    doc = parser.parse(xmlContent);
  } catch {
    return null;
  }

  const nodes = doc?.TransXChange?.Route_Geometry ?? doc?.Route_Geometry;
  const rawNodes = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];

  if (!rawNodes.length) return null;

  // Group by direction → run → sorted sequence
  const groups = {};
  for (const node of rawNodes) {
    const seq = parseInt(node['@_aSequence_No'] ?? node.aSequence_No ?? '0', 10);
    const run = String(node['@_aLBSL_Run_No'] ?? node.aLBSL_Run_No ?? '0').trim();
    const direction = String(node.Direction ?? '').trim();
    const lat = parseFloat(node.Location_Latitude);
    const lon = parseFloat(node.Location_Longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    groups[direction] ??= {};
    groups[direction][run] ??= [];
    groups[direction][run].push([seq, lon, lat]);
  }

  const features = [];
  for (const direction of Object.keys(groups).sort()) {
    const segments = [];
    for (const pts of Object.values(groups[direction])) {
      pts.sort((a, b) => a[0] - b[0]);
      const coords = pts.map(([, lon, lat]) => [lon, lat]);
      if (coords.length < 2) continue;
      const simplified = simplify(coords, SIMPLIFY_TOLERANCE);
      const rounded = simplified.map(([lon, lat]) => [
        roundCoord(lon, COORD_PRECISION),
        roundCoord(lat, COORD_PRECISION),
      ]);
      if (rounded.length >= 2) segments.push(rounded);
    }
    if (!segments.length) continue;

    const geometry = segments.length === 1
      ? { type: 'LineString', coordinates: segments[0] }
      : { type: 'MultiLineString', coordinates: segments };

    features.push({
      type: 'Feature',
      properties: { routeId, direction, sourceDate: dateToken },
      geometry,
    });
  }

  if (!features.length) return null;
  return {
    type: 'FeatureCollection',
    metadata: { routeId, sourceDate: dateToken, source: `${S3_PUBLIC}/bus-geometry/` },
    features,
  };
}

function processZip(zipBuffer, dateToken) {
  console.log('\nProcessing ZIP entries...');
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  let written = 0, skipped = 0;

  for (const entry of entries) {
    const m = entry.entryName.match(ROUTE_XML_RE);
    if (!m) continue;

    const rawId = m[1];
    const routeId = rawId.toUpperCase();

    // Skip 700-series (coaching routes, not bus)
    if (/^\d+$/.test(routeId) && +routeId >= 700 && +routeId <= 799) {
      skipped++;
      continue;
    }

    const xmlContent = entry.getData().toString('utf8');
    const geojson = parseRouteXml(xmlContent, routeId, dateToken);
    if (!geojson) { skipped++; continue; }

    writeJson(path.join(ROUTES_DIR, `${routeId}.geojson`), geojson);
    written++;
  }

  console.log(`  Written: ${written} routes, skipped: ${skipped}`);

  // Write index
  const routeIds = fs.readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.geojson'))
    .map(f => f.replace('.geojson', ''))
    .sort();
  writeJson(path.join(ROUTES_DIR, 'index.json'), { date: dateToken, routes: routeIds });
  console.log(`  Index written (${routeIds.length} routes)`);
}

// --- Main --------------------------------------------------------------------
// NOTE: Route destinations now live in `fetch-route-destinations.js` (produces
// reference-shape { destination, qualifier, full } records). This script only
// handles geometry.

async function main() {
  console.log('=== London Buses – Geometry Refresh ===\n');
  fs.mkdirSync(ROUTES_DIR, { recursive: true });

  const { date: dateToken, key: zipKey } = await findLatestZipKey();

  // Skip-if-unchanged short-circuit: TfL only republishes the geometry ZIP
  // when there's a network change (~quarterly), but this script runs weekly.
  // Comparing the bucket-listed date against the date we already processed
  // avoids a ~10 MB download + ~700 file rewrites on the ~95% of weeks where
  // nothing changed. The `--force` flag bypasses for manual re-runs.
  const sourceMetaPath = path.join(DATA_DIR, 'geometry-source.json');
  const force = process.argv.includes('--force');
  if (!force && fs.existsSync(sourceMetaPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(sourceMetaPath, 'utf8'));
      if (prev.zipDate === dateToken) {
        console.log(`  ZIP date unchanged (${dateToken}) — skipping download + extract. Use --force to override.`);
        // Refresh the timestamp so downstream "how stale is this?" checks see
        // we did look upstream this run, even if the data itself didn't move.
        writeJson(sourceMetaPath, { zipDate: dateToken, generatedAt: new Date().toISOString() });
        console.log('\n=== Done (cache hit) ===');
        return;
      }
    } catch { /* fall through to a full refresh */ }
  }

  const zipBuffer = await downloadZip(zipKey);
  processZip(zipBuffer, dateToken);

  writeJson(sourceMetaPath, {
    zipDate: dateToken,
    generatedAt: new Date().toISOString(),
  });

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
