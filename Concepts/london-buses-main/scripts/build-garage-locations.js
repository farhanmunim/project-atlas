/**
 * build-garage-locations.js
 *
 * Derives the legacy `data/garage-locations.json` consumed by the frontend
 * (api.js → fetchGarageLocations) from the authoritative `data/garages.geojson`
 * produced by fetch-garages.js (Step 4 — postcodes.io geocoded).
 *
 * Why this rewrite: the previous implementation scraped garages.htm and
 * geocoded via Photon with a London-only bounding-box filter. Out-of-London
 * garages (Grays, Slough, Crawley, Hatfield) failed that filter and silently
 * fell back to central London, mis-plotting four pins. postcodes.io handles
 * every UK postcode correctly, so we just project its output into the legacy
 * shape instead of re-geocoding.
 *
 * Legacy shape preserved (plus `pvr` and `capacity`) so api.js and the map
 * don't need to change:
 *   { generatedAt, count, garages: { <code>: { code, name, operator, address,
 *                                              lat, lon, pvr, capacity } } }
 *
 * `capacity` (operating-centre authorised vehicles, DVSA operator licence) is
 * joined in from the hand-maintained data/garage-capacity.json by garage code.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeRecord } from './_lib/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');
const IN_PATH   = path.join(DATA_DIR, 'garages.geojson');
const OUT_PATH  = path.join(DATA_DIR, 'garage-locations.json');

if (!fs.existsSync(IN_PATH)) {
  // Soft-handle cold starts + transient fetch-garages failures: leave the
  // previously-committed garage-locations.json untouched so the frontend
  // keeps working, and exit cleanly so the orchestrator continues.
  console.warn(`  ${IN_PATH} not found — keeping existing garage-locations.json.`);
  process.exit(0);
}

const fc = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));

// Hand-maintained per-garage operating-centre capacity (authorised vehicles)
// from the DVSA operator-licensing service. Not available via any bulk/API
// export, so curated in data/garage-capacity.json. Joined here by garage code.
const CAP_PATH = path.join(DATA_DIR, 'garage-capacity.json');
let capByCode = {};
if (fs.existsSync(CAP_PATH)) {
  try {
    const cap = JSON.parse(fs.readFileSync(CAP_PATH, 'utf8'));
    capByCode = cap.garages ?? {};
  } catch (e) {
    console.warn(`  Could not parse garage-capacity.json: ${e.message}`);
  }
}

const garages = {};
let skipped = 0;

for (const f of fc.features ?? []) {
  const p = f.properties ?? {};
  // Key by TfL code (what route_classifications uses) with fallback to LBR code.
  // e.g. Uxbridge Industrial Estate has LBR=UE, TfL=UX — classifications say UX.
  const code = p['TfL garage code'] || p['LBR garage code'];
  if (!code) { skipped++; continue; }
  if (garages[code]) continue; // dedupe rows that appear twice in the CSV

  // Skip garages with no current TfL routes — this is a London bus map, and
  // the CSV includes out-of-scope operators (Sullivan, Diamond, Falcon, ...)
  // whose depots would otherwise render as empty pins.
  const hasRoutes =
       (p['TfL main network routes']    || '').trim()
    || (p['TfL night routes']           || '').trim()
    || (p['TfL school/mobility routes'] || '').trim();
  if (!hasRoutes) { skipped++; continue; }

  const coords = f.geometry?.coordinates;
  const [lon, lat] = Array.isArray(coords) ? coords : [null, null];

  const pvrNum = parseInt(p['PVR'], 10);
  const capRaw = capByCode[code]?.capacity;
  const capacity = Number.isFinite(capRaw) ? capRaw : null;

  garages[code] = {
    code,
    name:     p['Garage name'] || '',
    operator: p['Group name']  || '',
    address:  p['Garage address'] || '',
    lat:      Number.isFinite(lat) ? lat : null,
    lon:      Number.isFinite(lon) ? lon : null,
    pvr:      Number.isFinite(pvrNum) ? pvrNum : null,
    // Authorised-vehicle capacity of the garage's operating centre (DVSA
    // operator licence). null until hand-filled in garage-capacity.json.
    capacity,
  };
}

const output = {
  generatedAt: new Date().toISOString(),
  count:       Object.keys(garages).length,
  garages,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(output), null, 2) + '\n', 'utf8');
console.log(`Wrote ${output.count} garages → ${path.relative(process.cwd(), OUT_PATH)}`);
if (skipped) console.log(`  (skipped ${skipped} features without a garage code)`);

const missingCoords = Object.values(garages).filter(g => g.lat == null).length;
if (missingCoords) console.log(`  (${missingCoords} garages have no coordinates — will be hidden on map)`);
