/**
 * audit-data.js — Systematic data-quality audit.
 *
 * Runs as the final step in the weekly pipeline. Walks every record in
 * route_classifications.json, vehicle-fleet.json, garages.geojson, and the
 * source/ caches, and checks every field against plausibility constraints.
 * Emits a structured report and exits non-zero when CRITICAL issues are
 * found — that's the lever that flags a regression in CI.
 *
 * Severities:
 *   CRITICAL — invariant broken (counts don't sum, schema field missing,
 *              date in distant future). Hard-fails the pipeline.
 *   WARN     — plausible anomaly that needs human eyes (age >25y on a
 *              real fleet, MPS outside the published 0-100 range, etc.)
 *              Logged but never fails the build.
 *   INFO     — coverage notes (how many ghost routes, % null per field).
 *
 * Output:
 *   data/audit/data-quality.json (full report, committed weekly)
 *   stdout summary (CI logs)
 *
 * Run:  node scripts/audit-data.js
 *       node scripts/audit-data.js --strict    # fail on WARN too
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const OUT_PATH  = path.join(AUDIT_DIR, 'data-quality.json');

const strictMode = process.argv.includes('--strict');

// ── Helpers ─────────────────────────────────────────────────────────────────
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const tryRead  = p => fs.existsSync(p) ? readJson(p) : null;

const KNOWN_OPERATORS = new Set([
  'Go-Ahead', 'Arriva', 'First', 'Metroline', 'Stagecoach London',
  'Transport UK', 'Uno', 'Sullivan Buses',
]);
const KNOWN_PROPULSIONS  = new Set(['diesel', 'hybrid', 'electric', 'hydrogen', 'gas', 'petrol']);
const KNOWN_DECKS        = new Set(['single', 'double', 'articulated']);
const KNOWN_TYPES        = new Set(['regular', 'twentyfour', 'night', 'school']);
const KNOWN_LENGTH_BANDS = new Set(['short', 'medium', 'long']);
const KNOWN_FREQUENCIES  = new Set(['high', 'low']);
const KNOWN_SERVICE_CLS  = new Set(['high-frequency', 'low-frequency']);

// 13 confirmed non-passenger "ghost" routes — TfL Line API returns 404 for
// all of these. They show in the geometry ZIP but aren't scheduled services,
// so they're allowed to have null operator/garage/etc. Anything *outside*
// this set with null fields is a real anomaly.
const GHOST_ROUTES = new Set([
  '108D', '281N', '281R', '481D',
  'T1', 'T2', 'T3',
  'UL13', 'UL19', 'UL26', 'UL30', 'UL40', 'UL61',
]);

// make ↔ model consistency. `make` is the DVLA-registered manufacturer of the
// route's observed fleet; `vehicleType` is a "chassis/body" model string. These
// come from different sources, so they can disagree when the fleet aggregator
// gets contaminated by a vehicle that doesn't belong to the route (see data.md
// §2). We only assert on models a SINGLE manufacturer builds complete (chassis
// + body): for those the make must be that manufacturer. Chassis/body products
// (Enviro, Gemini, EvoSeti, Streetdeck…) are deliberately excluded — their make
// is the chassis maker while the model names the body, so they legitimately
// differ (e.g. make VOLVO + "B5LH/Gemini 3", make BYD + "D8UR/Enviro200").
const COMPLETE_VEHICLE_MAKERS = [
  { re: /\b(metrocity|metrodecker|solo|versa)\b/i, makers: ['SWITCH', 'OPTARE'] },
  { re: /\bcitaro\b/i,                              makers: ['MERCEDES', 'EVOBUS'] },
  { re: /\byutong\b/i,                              makers: ['YUTONG'] },
];
function makeModelMismatch(make, vehicleType) {
  if (!make || !vehicleType) return null;
  const M = String(make).toUpperCase();
  for (const { re, makers } of COMPLETE_VEHICLE_MAKERS) {
    if (re.test(vehicleType) && !makers.some(k => M.includes(k))) return makers[0];
  }
  return null;
}

const NOW = Date.now();
const YEAR_MS = 365.25 * 86_400_000;
const CURRENT_YEAR = new Date().getUTCFullYear();

class Issue {
  constructor(severity, scope, id, field, expected, actual, note = '') {
    this.severity = severity;
    this.scope = scope;
    this.id = id;
    this.field = field;
    this.expected = expected;
    this.actual = actual;
    this.note = note;
  }
}

const issues = [];
const stats = { critical: 0, warn: 0, info: 0 };

function add(sev, scope, id, field, expected, actual, note = '') {
  const issue = new Issue(sev, scope, id, field, expected, actual, note);
  issues.push(issue);
  if (sev === 'CRITICAL') stats.critical++;
  else if (sev === 'WARN') stats.warn++;
  else stats.info++;
}

function isPlausibleDate(s, { minYear = 1990, maxYear = CURRENT_YEAR + 15 } = {}) {
  if (s == null) return true;            // null is allowed; only check shape
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < minYear || y > maxYear) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  return true;
}

function inRange(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

// ── Audit: route_classifications.json ───────────────────────────────────────
function auditClassifications(rc, vf, ov, gar) {
  if (!rc?.routes) { add('CRITICAL', 'rc', '-', '_root', 'object with routes', typeof rc); return; }

  // 1. typeCounts must sum to count
  const sum = Object.values(rc.typeCounts ?? {}).reduce((a, b) => a + b, 0);
  if (sum !== rc.count) {
    add('CRITICAL', 'rc', '-', 'typeCounts.sum', rc.count, sum,
        `typeCounts must partition routes`);
  }

  // 2. Geometry index alignment
  const ovIds = new Set((ov?.features ?? []).map(f => f.properties?.routeId));
  for (const id of Object.keys(rc.routes)) {
    if (!ovIds.has(id)) add('CRITICAL', 'rc', id, 'geometry', 'present in overview', 'absent');
  }

  // 3. Per-route field audits
  const garageCodes = new Set();
  for (const f of (gar?.features ?? [])) {
    const c = String(f.properties?.['TfL garage code'] ?? f.properties?.['LBR garage code'] ?? '').trim().toUpperCase();
    if (c) garageCodes.add(c);
  }

  for (const [id, r] of Object.entries(rc.routes)) {
    const ghost = GHOST_ROUTES.has(id);

    // Enums
    if (r.type && !KNOWN_TYPES.has(r.type))
      add('CRITICAL', 'rc', id, 'type', [...KNOWN_TYPES].join('|'), r.type);
    if (r.propulsion && !KNOWN_PROPULSIONS.has(r.propulsion))
      add('CRITICAL', 'rc', id, 'propulsion', [...KNOWN_PROPULSIONS].join('|'), r.propulsion);
    if (r.deck && !KNOWN_DECKS.has(r.deck))
      add('CRITICAL', 'rc', id, 'deck', [...KNOWN_DECKS].join('|'), r.deck);
    if (r.lengthBand && !KNOWN_LENGTH_BANDS.has(r.lengthBand))
      add('CRITICAL', 'rc', id, 'lengthBand', [...KNOWN_LENGTH_BANDS].join('|'), r.lengthBand);
    if (r.frequency && !KNOWN_FREQUENCIES.has(r.frequency))
      add('CRITICAL', 'rc', id, 'frequency', 'high|low', r.frequency);
    if (r.serviceClass && !KNOWN_SERVICE_CLS.has(r.serviceClass))
      add('CRITICAL', 'rc', id, 'serviceClass', 'high-frequency|low-frequency', r.serviceClass);
    if (r.operator && !KNOWN_OPERATORS.has(r.operator))
      add('WARN', 'rc', id, 'operator', 'normalised brand', r.operator);

    // Coverage on non-ghost routes
    if (!ghost) {
      if (!r.operator)   add('WARN', 'rc', id, 'operator',   'present', null);
      if (!r.garageCode) add('WARN', 'rc', id, 'garageCode', 'present', null);
      if (!r.propulsion) add('WARN', 'rc', id, 'propulsion', 'present', null);
    }

    // Garage cross-reference
    if (r.garageCode && !garageCodes.has(String(r.garageCode).toUpperCase()))
      add('WARN', 'rc', id, 'garageCode', 'in garages.geojson', r.garageCode);

    // PVR / fleetSize sanity
    if (r.pvr != null && !inRange(r.pvr, 1, 100))
      add('WARN', 'rc', id, 'pvr', '1..100', r.pvr);
    if (r.fleetSize != null && !inRange(r.fleetSize, 1, 200))
      add('WARN', 'rc', id, 'fleetSize', '1..200', r.fleetSize);
    if (r.pvr != null && r.fleetSize != null) {
      // fleetSize from observations vs PVR. Only flag when BOTH are large
      // enough for the ratio to be meaningful — TfL's /Arrivals API only
      // samples buses that happened to be in-service during the run, so
      // sparse coverage (fleetSize<5) is an observability artefact, not a
      // data bug. Beyond that, fleetSize > 3x PVR is suspicious
      // (over-counting reserves), and < 0.2x PVR on a route with PVR>=10
      // suggests broken arrivals coverage.
      const ratio = r.fleetSize / r.pvr;
      if (r.fleetSize >= 5 && r.pvr >= 10 && (ratio < 0.2 || ratio > 3))
        add('WARN', 'rc', id, 'fleetSize/pvr ratio', '0.2..3', ratio.toFixed(2),
            `fleetSize=${r.fleetSize} pvr=${r.pvr}`);
    }

    // Age: must be 0..25 for active fleet
    if (r.vehicleAgeYears != null) {
      if (!inRange(r.vehicleAgeYears, 0, 25))
        add('WARN', 'rc', id, 'vehicleAgeYears', '0..25', r.vehicleAgeYears);
      // Electric routes can't be older than London's first big electric
      // fleet rollout (~2015). Anything claiming an electric fleet with
      // >12y avg age is a propulsion/age mismatch.
      if (r.propulsion === 'electric' && r.vehicleAgeYears > 12)
        add('WARN', 'rc', id, 'vehicleAgeYears', '<=12 for electric',
            r.vehicleAgeYears, 'electric London fleets are post-2015');
    }

    // make ↔ model consistency. The make is built from observed vehicles; when
    // it names a manufacturer that cannot have built a manufacturer-complete
    // model the route shows (e.g. ADL make on a Switch "Metrocity EV"), the
    // fleet make was contaminated by a vehicle that doesn't belong to the route.
    // WARN for now while the core-fleet filter (build-classifications.js) drains
    // these forward over weekly cycles; promote to CRITICAL once they're gone so
    // a contradiction can never reach the app. data.md §5a tracks the standing.
    const expMaker = makeModelMismatch(r.make, r.vehicleType);
    if (expMaker)
      add('WARN', 'rc', id, 'make↔model', `${expMaker} for "${r.vehicleType}"`, r.make,
          'make contradicts a manufacturer-complete model — fleet make likely contaminated');

    // Performance values
    if (r.ewtMinutes != null && !inRange(r.ewtMinutes, 0, 20))
      add('WARN', 'rc', id, 'ewtMinutes', '0..20', r.ewtMinutes);
    if (r.onTimePercent != null && !inRange(r.onTimePercent, 30, 100))
      add('WARN', 'rc', id, 'onTimePercent', '30..100', r.onTimePercent);
    if (r.ewtMps != null && !inRange(r.ewtMps, 0.5, 10))
      add('WARN', 'rc', id, 'ewtMps', '0.5..10', r.ewtMps);
    if (r.otpMps != null && !inRange(r.otpMps, 50, 100))
      add('WARN', 'rc', id, 'otpMps', '50..100', r.otpMps);
    if (r.mileageMps != null && !inRange(r.mileageMps, 80, 100))
      add('WARN', 'rc', id, 'mileageMps', '80..100', r.mileageMps);

    // serviceClass / MPS coherence
    if (r.serviceClass === 'high-frequency' && r.ewtMps == null && !ghost)
      add('WARN', 'rc', id, 'ewtMps', 'present for high-frequency', null);
    if (r.serviceClass === 'low-frequency' && r.otpMps == null && !ghost)
      add('WARN', 'rc', id, 'otpMps', 'present for low-frequency', null);

    // Dates
    for (const f of ['previousAwardDate', 'lastAwardDate', 'contractStartDate']) {
      if (r[f] != null && !isPlausibleDate(r[f]))
        add('CRITICAL', 'rc', id, f, 'YYYY-MM-DD plausible', r[f]);
    }
    if (r.previousAwardDate && r.lastAwardDate && r.previousAwardDate > r.lastAwardDate)
      add('CRITICAL', 'rc', id, 'date ordering', 'previousAwardDate < lastAwardDate',
          `prev=${r.previousAwardDate} last=${r.lastAwardDate}`);

    // Contract term sanity (TfL bus contracts: 5y + optional 2y extension)
    if (r.contractTermYears != null && !inRange(r.contractTermYears, 1, 12))
      add('WARN', 'rc', id, 'contractTermYears', '1..12', r.contractTermYears);
    if (r.previousContractTermYears != null && !inRange(r.previousContractTermYears, 1, 12))
      add('WARN', 'rc', id, 'previousContractTermYears', '1..12', r.previousContractTermYears);

    // Cost per mile. Regular passenger routes run £3-15/mile but Superloop
    // and other limited-stop premium services can hit £40+. School routes
    // are uncapped on the high side because they're low-utilisation by
    // design (one trip per school day across a long route) — TfL has
    // historically awarded them at £20-£100/mile. The £200 ceiling matches
    // the parser clamp in fetch-tenders.js — anything higher is a TfL form
    // input error (full annual bid pasted into the per-mile cell).
    if (r.lastCostPerMile != null) {
      const lo = 3;
      const hi = r.type === 'school' ? 200 : 60;
      if (!inRange(r.lastCostPerMile, lo, hi))
        add('WARN', 'rc', id, 'lastCostPerMile', `£${lo}..${hi}`, r.lastCostPerMile);
    }
    // Previous-operator mirror fields. Lower floor than the current contract
    // (£2 vs £3): a "previous" tender can be 15+ years old, and pre-2010
    // awards were genuinely cheaper per mile before inflation.
    if (r.previousCostPerMile != null) {
      const lo = 2;
      const hi = r.type === 'school' ? 200 : 60;
      if (!inRange(r.previousCostPerMile, lo, hi))
        add('WARN', 'rc', id, 'previousCostPerMile', `£${lo}..${hi}`, r.previousCostPerMile);
    }
    if (r.previousNumberOfTenderers != null && !inRange(r.previousNumberOfTenderers, 1, 12))
      add('WARN', 'rc', id, 'previousNumberOfTenderers', '1..12', r.previousNumberOfTenderers);
    if (r.previousContractedAnnualMiles != null && !inRange(r.previousContractedAnnualMiles, 0, 10_000_000))
      add('WARN', 'rc', id, 'previousContractedAnnualMiles', '0..10M', r.previousContractedAnnualMiles);

    // Contracted annual miles (derived bid ÷ £/mile) and the bid itself.
    // Sanity-only check — both are derived from upstream tender data and
    // any per-input weirdness already gets caught by the lastCostPerMile
    // audit above. Real-world spread:
    //   • School routes: 1k-100k miles, £40k-£12M bids (some bundled tenders
    //     attribute the full bundle figure to each route in the bundle)
    //   • Regular passenger: 16k-3M miles, £250k-£20M bids
    // Hard-fail boundaries are an order of magnitude beyond the observed
    // tail in either direction.
    if (r.contractedAnnualMiles != null && !inRange(r.contractedAnnualMiles, 0, 10_000_000))
      add('WARN', 'rc', id, 'contractedAnnualMiles', '0..10M', r.contractedAnnualMiles);
    if (r.lastAcceptedBid != null && !inRange(r.lastAcceptedBid, 0, 100_000_000))
      add('WARN', 'rc', id, 'lastAcceptedBid', '£0..100M', r.lastAcceptedBid);

    // numberOfTenderers
    if (r.numberOfTenderers != null && !inRange(r.numberOfTenderers, 1, 12))
      add('WARN', 'rc', id, 'numberOfTenderers', '1..12', r.numberOfTenderers);

    // tenderAwardCount sanity
    if (r.tenderAwardCount != null && !inRange(r.tenderAwardCount, 0, 30))
      add('WARN', 'rc', id, 'tenderAwardCount', '0..30', r.tenderAwardCount);
  }

  // 4. Coverage info
  const total = Object.keys(rc.routes).length;
  const counts = { operator: 0, garage: 0, pvr: 0, vt: 0, prop: 0, deck: 0, ewtOrOtp: 0, mileageMps: 0, age: 0 };
  for (const r of Object.values(rc.routes)) {
    if (r.operator) counts.operator++;
    if (r.garageCode) counts.garage++;
    if (r.pvr != null) counts.pvr++;
    if (r.vehicleType) counts.vt++;
    if (r.propulsion) counts.prop++;
    if (r.deck) counts.deck++;
    if (r.ewtMinutes != null || r.onTimePercent != null) counts.ewtOrOtp++;
    if (r.mileageMps != null) counts.mileageMps++;
    if (r.vehicleAgeYears != null) counts.age++;
  }
  add('INFO', 'rc', '-', 'coverage', '—', counts, `of ${total}`);
}

// ── Audit: vehicle-fleet.json ───────────────────────────────────────────────
function auditFleet(vf) {
  if (!vf?.vehicles) { add('CRITICAL', 'fleet', '-', '_root', 'object with vehicles', typeof vf); return; }
  const v = vf.vehicles;
  const total = Object.keys(v).length;

  let dvla200 = 0, dvla404 = 0, dvla400 = 0, dvlaOther = 0, neverChecked = 0;
  let validVrm = 0, invalidVrm = 0;
  let ageOK = 0, ageMissing = 0, ageImplausible = 0;
  let propByFuel = {};

  // Per-vehicle field checks
  for (const [vrm, rec] of Object.entries(v)) {
    // Sanity on the key itself
    if (!/^[A-Z0-9]{5,7}$/.test(vrm) || !/[A-Z]/.test(vrm) || !/[0-9]/.test(vrm)) {
      add('CRITICAL', 'fleet', vrm, '_key', 'UK-shaped VRM', vrm);
      invalidVrm++;
    } else {
      validVrm++;
    }

    // Status
    if (rec.dvlaStatus == null) neverChecked++;
    else if (rec.dvlaStatus === 200) dvla200++;
    else if (rec.dvlaStatus === 404) dvla404++;
    else if (rec.dvlaStatus === 400) { dvla400++; add('WARN', 'fleet', vrm, 'dvlaStatus', '200|404|null', 400); }
    else dvlaOther++;

    // fuelType normalisation
    if (rec.fuelType) {
      if (!KNOWN_PROPULSIONS.has(rec.fuelType))
        add('CRITICAL', 'fleet', vrm, 'fuelType', [...KNOWN_PROPULSIONS].join('|'), rec.fuelType);
      propByFuel[rec.fuelType] = (propByFuel[rec.fuelType] ?? 0) + 1;
    }

    // Year of manufacture
    if (rec.yearOfManufacture != null) {
      const y = Number(rec.yearOfManufacture);
      if (!Number.isInteger(y) || y < 1990 || y > CURRENT_YEAR + 1)
        add('WARN', 'fleet', vrm, 'yearOfManufacture', `1990..${CURRENT_YEAR+1}`, rec.yearOfManufacture);
    }

    // monthOfFirstRegistration
    if (rec.monthOfFirstRegistration != null) {
      const m = /^(\d{4})-(\d{2})$/.exec(rec.monthOfFirstRegistration);
      if (!m) {
        add('WARN', 'fleet', vrm, 'monthOfFirstRegistration', 'YYYY-MM', rec.monthOfFirstRegistration);
        ageImplausible++;
      } else {
        const y = +m[1], mo = +m[2];
        if (y < 1990 || y > CURRENT_YEAR + 1 || mo < 1 || mo > 12) {
          add('WARN', 'fleet', vrm, 'monthOfFirstRegistration', 'plausible', rec.monthOfFirstRegistration);
          ageImplausible++;
        } else ageOK++;
      }
    } else {
      ageMissing++;
    }
  }

  add('INFO', 'fleet', '-', 'coverage', '—', {
    total, validVrm, invalidVrm,
    dvla200, dvla404, dvla400, dvlaOther, neverChecked,
    ageOK, ageMissing, ageImplausible,
    propByFuel,
  });
}

// ── Audit: garages.geojson ──────────────────────────────────────────────────
function auditGarages(gar) {
  if (!gar?.features) { add('CRITICAL', 'gar', '-', '_root', 'FeatureCollection', typeof gar); return; }
  const seenCodes = new Set();
  for (const f of gar.features) {
    const p = f.properties ?? {};
    // `||` not `??`: upstream CSV uses '' for missing-but-known-empty,
    // which `??` doesn't fall through.
    const code = String(p['TfL garage code'] || p['LBR garage code'] || '').trim().toUpperCase();
    if (!code) add('WARN', 'gar', JSON.stringify(p['Garage name']), 'code', 'present', null);
    if (code && seenCodes.has(code))
      add('CRITICAL', 'gar', code, 'unique', 'unique garage code', 'duplicate');
    seenCodes.add(code);

    // Geometry: lat 51..52, lon -0.6..0.4 covers Greater London + a margin
    // for Hatfield (Uno) and Tilbury / Sullivan depots.
    const coords = f.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length === 2) {
      const [lon, lat] = coords;
      if (!inRange(lon, -1, 1)) add('WARN', 'gar', code, 'lon', '-1..1', lon);
      if (!inRange(lat, 51, 52)) add('WARN', 'gar', code, 'lat', '51..52', lat);
    } else {
      add('CRITICAL', 'gar', code, 'geometry', '[lon,lat]', coords);
    }

    // PVR sanity. Garage PVR=0 is legitimate (reserve/training depots,
    // newly-opened sites awaiting allocation, recently-closed contracts) so
    // we only flag the high tail. Upper bound 800 covers the largest TfL
    // garage rosters with a wide margin.
    const pvr = parseInt(p['PVR'], 10);
    if (Number.isFinite(pvr) && pvr > 800)
      add('WARN', 'gar', code, 'pvr', '0..800', p['PVR']);
  }
  add('INFO', 'gar', '-', 'coverage', '—', { count: gar.features.length });
}

// ── Audit: route-vehicles ↔ vehicle-fleet cross-reference ──────────────────
function auditObservations(rv, vf) {
  if (!rv?.routes || !vf?.vehicles) return;
  let totalObs = 0, missingFleet = 0;
  for (const [rid, list] of Object.entries(rv.routes)) {
    for (const entry of (list ?? [])) {
      totalObs++;
      const reg = (typeof entry === 'string' ? entry : entry?.reg)?.toUpperCase();
      if (!reg) continue;
      if (!vf.vehicles[reg]) {
        add('WARN', 'obs', `${rid}/${reg}`, 'fleet ref', 'in vehicle-fleet', 'absent');
        missingFleet++;
      }
    }
  }
  add('INFO', 'obs', '-', 'coverage', '—', { totalObs, missingFleet });
}

// ── Audit: MPS service-class vs classification serviceClass ────────────────
function auditMps(rc, mps) {
  if (!rc?.routes || !mps?.routes) return;
  let coherent = 0, mismatch = 0;
  for (const [id, r] of Object.entries(rc.routes)) {
    if (!r.serviceClass) continue;
    const m = mps.routes[id];
    if (!m || m.status !== 200) continue;
    if (m.service_class !== r.serviceClass) {
      add('WARN', 'mps', id, 'service_class', r.serviceClass, m.service_class);
      mismatch++;
    } else coherent++;
  }
  add('INFO', 'mps', '-', 'coherence', '—', { coherent, mismatch });
}

// ── Audit: freshness ────────────────────────────────────────────────────────
function auditFreshness() {
  const checks = [
    ['data/geometry-source.json',           'generatedAt', 8],
    ['data/route_destinations.json',        'generated_at_utc', 8],
    ['data/route_stops.json',               'generated_at_utc', 8],
    ['data/source/vehicle-fleet.json',      'generatedAt', 8],
    ['data/source/route-vehicles.json',     'generatedAt', 8],
    ['data/source/route-mps.json',          'generatedAt', 14],
    ['data/source/tender-programme.json',   'generatedAt', 14],
    ['data/route_classifications.json',     'generatedAt', 8],
  ];
  for (const [rel, key, maxDays] of checks) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { add('WARN', 'fresh', rel, 'exists', 'true', 'false'); continue; }
    try {
      const j = readJson(p);
      const ts = j[key];
      if (!ts) { add('WARN', 'fresh', rel, key, 'present', null); continue; }
      const ageDays = (NOW - new Date(ts).getTime()) / 86_400_000;
      if (!Number.isFinite(ageDays)) {
        add('WARN', 'fresh', rel, key, 'parseable date', ts);
      } else if (ageDays > maxDays) {
        add('WARN', 'fresh', rel, key, `<=${maxDays}d old`, `${ageDays.toFixed(1)}d`);
      }
    } catch (e) { add('WARN', 'fresh', rel, 'json', 'parseable', e.message); }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  console.log('=== Data Quality Audit ===\n');

  const rc  = tryRead(path.join(DATA_DIR, 'route_classifications.json'));
  const vf  = tryRead(path.join(DATA_DIR, 'source', 'vehicle-fleet.json'));
  const rv  = tryRead(path.join(DATA_DIR, 'source', 'route-vehicles.json'));
  const mps = tryRead(path.join(DATA_DIR, 'source', 'route-mps.json'));
  const ov  = tryRead(path.join(DATA_DIR, 'routes-overview.geojson'));
  const gar = tryRead(path.join(DATA_DIR, 'garages.geojson'));

  if (rc)  auditClassifications(rc, vf, ov, gar);
  if (vf)  auditFleet(vf);
  if (gar) auditGarages(gar);
  if (rv && vf) auditObservations(rv, vf);
  if (rc && mps) auditMps(rc, mps);
  auditFreshness();

  // Summarise
  console.log(`CRITICAL: ${stats.critical}`);
  console.log(`WARN:     ${stats.warn}`);
  console.log(`INFO:     ${stats.info}\n`);

  // Print first 20 issues of each non-info severity
  for (const sev of ['CRITICAL', 'WARN']) {
    const subset = issues.filter(i => i.severity === sev);
    if (!subset.length) continue;
    console.log(`── ${sev} (${subset.length}) — first 30:`);
    for (const i of subset.slice(0, 30)) {
      const exp = typeof i.expected === 'object' ? JSON.stringify(i.expected) : i.expected;
      const act = typeof i.actual   === 'object' ? JSON.stringify(i.actual)   : i.actual;
      console.log(`  [${i.scope}] ${i.id} ${i.field}: expected=${exp} actual=${act} ${i.note ? '— ' + i.note : ''}`);
    }
    console.log('');
  }

  // Write structured report
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    summary:     stats,
    issues,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Wrote ${OUT_PATH}`);

  const failOn = strictMode ? (stats.critical + stats.warn) : stats.critical;
  if (failOn > 0) {
    console.error(`\nAudit failed: ${stats.critical} critical${strictMode ? ` + ${stats.warn} warn` : ''} issues.`);
    process.exit(1);
  }
  console.log('\nAudit passed (no critical issues).');
}

main();
