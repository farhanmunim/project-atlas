/**
 * build-overview.js
 *
 * Reads all per-route GeoJSON files and produces a single
 * data/routes-overview.geojson with aggressively simplified geometry.
 *
 * Used to render the full London bus network as a faint background layer.
 *
 * Run: node scripts/build-overview.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeRecord } from './_lib/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, '../data/routes');
const OUT_FILE   = path.resolve(__dirname, '../data/routes-overview.geojson');

// Aggressive simplification for overview — ~50m tolerance
const TOLERANCE  = 0.0005;
const PRECISION  = 4; // decimal places — ~11m precision at London latitudes

// ── Douglas-Peucker ──────────────────────────────────────────────────────────

function ptSegDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(coords, tol) {
  if (coords.length <= 2) return coords;
  let maxD = 0, idx = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const d = ptSegDist(coords[i], coords[0], coords[coords.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    return [...simplify(coords.slice(0, idx + 1), tol).slice(0, -1), ...simplify(coords.slice(idx), tol)];
  }
  return [coords[0], coords[coords.length - 1]];
}

function roundCoords(coords) {
  return coords.map(([lon, lat]) => [
    parseFloat(lon.toFixed(PRECISION)),
    parseFloat(lat.toFixed(PRECISION)),
  ]);
}

function flattenGeometry(geometry) {
  if (geometry.type === 'LineString') {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates;
  }
  return [];
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Load classifications for embedding into features
const CLASSIFICATIONS_PATH = path.resolve(__dirname, '../data/route_classifications.json');
let classifications = {};
try {
  classifications = JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, 'utf8')).routes ?? {};
} catch {
  console.warn('  Warning: route_classifications.json not found — run build-classifications.js first');
}

const files = fs.readdirSync(ROUTES_DIR)
  .filter(f => f.endsWith('.geojson') && f !== 'index.json')
  .sort();

console.log(`Processing ${files.length} route files…`);

const features = [];
let skipped = 0;

for (const file of files) {
  const routeId = file.replace('.geojson', '');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8'));
  } catch {
    skipped++;
    continue;
  }

  const cls      = classifications[routeId] ?? {};
  const routeType = cls.type     ?? 'regular';
  const isPrefix  = cls.isPrefix ?? /^[A-Z]/i.test(routeId);

  for (const feature of (data.features ?? [])) {
    const direction = String(feature.properties?.direction ?? '1');
    const segments  = flattenGeometry(feature.geometry);

    for (const segment of segments) {
      const simplified = simplify(segment, TOLERANCE);
      if (simplified.length < 2) continue;
      const rounded = roundCoords(simplified);

      features.push({
        type: 'Feature',
        properties: {
          routeId,
          direction,
          routeType,
          isPrefix,
          lengthBand:  cls.lengthBand  ?? null,
          deck:        cls.deck        ?? null,
          frequency:   cls.frequency   ?? null,
          operator:    cls.operator    ?? null,
          propulsion:  cls.propulsion  ?? null,
        },
        geometry: { type: 'LineString', coordinates: rounded },
      });
    }
  }
}

const output = {
  type: 'FeatureCollection',
  metadata: {
    generatedAt: new Date().toISOString(),
    routeCount: files.length - skipped,
    featureCount: features.length,
    simplificationTolerance: TOLERANCE,
    coordinatePrecision: PRECISION,
  },
  features,
};

// Defence-in-depth: sanitise every string property in the GeoJSON feature
// collection before writing the public artefact (operator names, route IDs,
// any future feature-property additions).
fs.writeFileSync(OUT_FILE, JSON.stringify(sanitizeRecord(output)), 'utf8');

const DATA_DIR = path.resolve(__dirname, '../data');
const buildAt  = new Date().toISOString();

// ── Build metadata ────────────────────────────────────────────────────────────
const META_FILE    = path.join(DATA_DIR, 'build-meta.json');
const metaExisting = (() => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } })();
fs.writeFileSync(META_FILE, JSON.stringify({
  ...metaExisting,
  routeGeometry:        { label: 'Route geometry',    source: 'bus route data API', updatedAt: buildAt },
  routeOverview:        { label: 'Route overview',     source: 'build-overview.js',  updatedAt: buildAt },
  routeClassifications: { label: 'Classifications',    source: 'api + geometry',     updatedAt: buildAt },
}), 'utf8');

const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
console.log(`Written: ${OUT_FILE}`);
console.log(`  Features: ${features.length} | File size: ${sizeMB} MB | Skipped: ${skipped}`);
