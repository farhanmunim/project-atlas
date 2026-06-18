/**
 * update-vehicle-lookup.js
 *
 * Scans data/source/route_details.json for unique vehicleType strings and
 * merges any new ones into data/vehicle-lookup.json with { deck: null,
 * propulsion: null } placeholders for the user to fill in manually.
 *
 * Never overwrites existing entries — edits made to vehicle-lookup.json
 * are preserved.
 *
 * Run: npm run update-vehicle-lookup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DETAILS     = path.resolve(__dirname, '../data/source/route_details.json');
const LOOKUP_PATH = path.resolve(__dirname, '../data/vehicle-lookup.json');

if (!fs.existsSync(DETAILS)) {
  console.error('Error: data/source/route_details.json not found. Run fetch-route-details first.');
  process.exit(1);
}

const details = JSON.parse(fs.readFileSync(DETAILS, 'utf8'));
const unique  = new Set();
for (const r of Object.values(details.routes ?? {})) {
  if (r.vehicleType) unique.add(r.vehicleType);
}

let lookup = { description: '', vehicles: {} };
if (fs.existsSync(LOOKUP_PATH)) {
  lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf8'));
  lookup.vehicles ??= {};
}

let added = 0;
for (const vt of unique) {
  if (!(vt in lookup.vehicles)) {
    lookup.vehicles[vt] = { deck: null, propulsion: null };
    added++;
    console.log(`  + ${vt}`);
  }
}

// Sort alphabetically for easier manual editing
const sorted = Object.keys(lookup.vehicles).sort();
const newVehicles = {};
for (const k of sorted) newVehicles[k] = lookup.vehicles[k];
lookup.vehicles = newVehicles;

fs.writeFileSync(LOOKUP_PATH, JSON.stringify(lookup, null, 2), 'utf8');
console.log(`\n${added} new vehicle type(s) added; ${unique.size} total in data, ${sorted.length} in lookup`);
if (added > 0) {
  console.log(`\nEdit ${LOOKUP_PATH} to fill in deck + propulsion for the new entries.`);
}
