/**
 * refresh.js — Full data refresh orchestrator
 *
 * Pipeline order:
 *   1. fetch-data.js                — geometry ZIP → per-route GeoJSON
 *   2. fetch-route-destinations.js  — TfL API → data/route_destinations.json
 *   3. fetch-route-stops.js         — TfL API → data/route_stops.json + data/stops.json
 *   4. fetch-garages.js             — londonbusroutes.net CSV + postcodes.io → data/garages.geojson
 *   5. fetch-frequencies.js         — TfL timetables → data/frequencies.json
 *   6. fetch-route-details.js       — garages + details.htm → data/source/route_details.json
 *   7. fetch-vehicle-fleet.js       — iBus + DVLA → data/source/vehicle-fleet.json (sticky cache)
 *   8. fetch-route-vehicles.js      — TfL arrivals → data/source/route-vehicles.json (this run's snapshot)
 *   9. backfill-route-vehicle-sightings.js — Supabase recurrence RPC → enrich route-vehicles.json `days`
 *  10. fetch-route-performance.js   — TfL QSI PDF → data/source/route-performance.json (EWT/OTP)
 *  11. fetch-tenders.js             — TfL tender award form → data/source/tenders.json (sticky cache)
 *  12. fetch-tender-programme.js    — TfL annual programme PDFs → data/source/tender-programme.json
 *  12b. fetch-accidents.js          — DfT STATS19 CSVs → data/source/accidents.json (bus-involved)
 *  13. build-classifications.js     — data/route_classifications.json (master per-route record)
 *  14. build-overview.js            — simplified network overview layer
 *  15. build-garage-locations.js    — geocode garages → data/garage-locations.json (frontend)
 *  16. audit-data.js                — data-quality gate (hard-fails on CRITICAL)
 *  17. push-to-supabase.js          — mirror current state into Supabase (history + analytics)
 *
 * Note: fetch-route-mps.js also runs (per-route MPS) — see STEPS below for the
 * authoritative, numbered order.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STEPS = [
  { label: 'Step 1/19 — Route geometry',                            script: 'fetch-data.js' },
  { label: 'Step 2/19 — Route destinations (TfL API)',              script: 'fetch-route-destinations.js' },
  { label: 'Step 3/19 — Route stops (TfL API)',                     script: 'fetch-route-stops.js' },
  { label: 'Step 4/19 — Garages CSV + geocode',                     script: 'fetch-garages.js' },
  { label: 'Step 5/19 — Frequencies from timetables',               script: 'fetch-frequencies.js' },
  { label: 'Step 6/19 — Route details (vehicle/op/garage)',         script: 'fetch-route-details.js' },
  { label: 'Step 7/19 — Vehicle fleet (iBus + DVLA)',               script: 'fetch-vehicle-fleet.js' },
  { label: 'Step 8/19 — Route → vehicle observations (TfL)',        script: 'fetch-route-vehicles.js' },
  { label: 'Step 9/19 — Backfill fleet recurrence (Supabase)',      script: 'backfill-route-vehicle-sightings.js' },
  { label: 'Step 10/19 — Route performance actuals (EWT/OTP)',      script: 'fetch-route-performance.js' },
  { label: 'Step 11/19 — Per-route MPS (contractual standards)',    script: 'fetch-route-mps.js' },
  { label: 'Step 12/19 — Tender award results (TfL)',               script: 'fetch-tenders.js' },
  { label: 'Step 13/19 — Tender programme PDFs (TfL)',              script: 'fetch-tender-programme.js' },
  { label: 'Step 14/19 — Accidents (DfT STATS19, bus-involved)',    script: 'fetch-accidents.js' },
  { label: 'Step 15/19 — Build classifications',                    script: 'build-classifications.js' },
  { label: 'Step 16/19 — Build overview + snapshot',                script: 'build-overview.js' },
  { label: 'Step 17/19 — Garage locations (frontend JSON)',         script: 'build-garage-locations.js' },
  { label: 'Step 18/19 — Data-quality audit',                       script: 'audit-data.js' },
  { label: 'Step 19/19 — Push history + fleet to Supabase',         script: 'push-to-supabase.js' },
];

// Fetch steps are allowed to fail without aborting the whole pipeline — the
// downstream builders already merge last-known-good data, so one flaky scrape
// shouldn't wipe a week of downstream work. Build steps still hard-fail
// because they're pure transformations and should never crash.
const SOFT_FAIL = new Set([
  'fetch-data.js',
  'fetch-route-destinations.js',
  'fetch-route-stops.js',
  'fetch-garages.js',
  'fetch-frequencies.js',
  'fetch-route-details.js',
  'fetch-vehicle-fleet.js',
  'fetch-route-vehicles.js',
  'backfill-route-vehicle-sightings.js',
  'fetch-route-performance.js',
  'fetch-route-mps.js',
  'fetch-tenders.js',
  'fetch-tender-programme.js',
  'fetch-accidents.js',
  'build-garage-locations.js',
  'push-to-supabase.js',
]);

const started = Date.now();
console.log('=== London Buses — Full Data Refresh ===\n');

const failures = [];
for (const { label, script } of STEPS) {
  console.log(`\n──────────────────────────────────────`);
  console.log(label);
  console.log(`──────────────────────────────────────`);
  const stepStart = Date.now();
  try {
    execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
    console.log(`  Done in ${((Date.now() - stepStart) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (SOFT_FAIL.has(script)) {
      failures.push(script);
      console.warn(`  ⚠ ${script} failed — continuing with last-known-good data.`);
    } else {
      throw err;
    }
  }
}

const totalSec = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n=== Refresh complete in ${totalSec}s ===`);
if (failures.length) console.log(`Soft failures: ${failures.join(', ')}`);
