/**
 * audit-vehicle-data.js — Cross-source audit of per-route vehicle data.
 *
 * **On-demand audit tool — NOT part of the weekly pipeline.** Kept in `scripts/`
 * for future audits whenever someone suspects vehicle data drift; surfaces
 * issues like DVLA misclassification on hybrid chassis or routes mid-fleet
 * transition. Re-run with `npm run audit-vehicle-data` followed by
 * `npm run audit-summary`. The bustimes.org per-operator scrape is the only
 * live network call — the other four sources reuse data already collected by
 * the weekly pipeline (no extra TfL or DVLA calls).
 *
 * Generates 5 CSVs in data/audit/, one per source. Each row is the raw fact
 * the source reports — no inference, no enrichment. The point is to compare
 * sources head-to-head and find where they disagree.
 *
 *   01-tfl-arrivals.csv   route_id, registration             (TfL /Line/<id>/Arrivals)
 *   02-ibus-vehicles.csv  registration, bonnet_no, operator   (iBus Vehicle.xml)
 *   03-lbr-routes.csv     route_id, vehicle_string, garage_code, pvr  (LBR details.htm)
 *   04-bustimes.csv       registration, operator, fleet_no, vehicle_type, last_route
 *                                                            (bustimes.org per-operator pages)
 *   05-our-aggregate.csv  route_id, make, vehicleType, propulsion, deck, vehicleAgeYears
 *                                                            (data/route_classifications.json)
 *
 * Plus 00-comparison.csv that joins the sources per route and flags mismatches.
 *
 * Run: node scripts/audit-vehicle-data.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const OUT_DIR   = path.join(DATA_DIR, 'audit');
const SCRIPT    = 'audit-vehicle-data';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── CSV helpers ─────────────────────────────────────────────────────────────
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(filename, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  fs.writeFileSync(path.join(OUT_DIR, filename), lines.join('\n') + '\n', 'utf8');
  console.log(`  ${filename}: ${rows.length} rows`);
}

function readJsonOrEmpty(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── Source 1: TfL arrivals → per-route registrations ────────────────────────
function buildTflCsv() {
  const file = readJsonOrEmpty(path.join(DATA_DIR, 'source', 'route-vehicles.json'));
  const rows = [];
  for (const [routeId, list] of Object.entries(file?.routes ?? {})) {
    for (const entry of (list ?? [])) {
      if (entry?.reg) rows.push({ route_id: routeId, registration: entry.reg, last_seen_at: entry.lastSeenAt });
    }
  }
  writeCsv('01-tfl-arrivals.csv', ['route_id', 'registration', 'last_seen_at'], rows);
  return rows;
}

// ── Source 2: iBus → registration → operator + bonnet ───────────────────────
function buildIbusCsv() {
  const file = readJsonOrEmpty(path.join(DATA_DIR, 'source', 'vehicle-fleet.json'));
  const rows = [];
  for (const [reg, v] of Object.entries(file?.vehicles ?? {})) {
    if (!v?.operator && !v?.bonnetNo) continue;   // iBus fields, skip DVLA-only entries
    rows.push({
      registration: reg,
      bonnet_no:    v.bonnetNo ?? '',
      operator:     v.operator ?? '',
    });
  }
  rows.sort((a, b) => a.registration.localeCompare(b.registration));
  writeCsv('02-ibus-vehicles.csv', ['registration', 'bonnet_no', 'operator'], rows);
  return rows;
}

// ── Source 3: LBR details.htm → per-route vehicle string + garage + PVR ────
function buildLbrCsv() {
  const file = readJsonOrEmpty(path.join(DATA_DIR, 'source', 'route_details.json'));
  const rows = [];
  for (const [routeId, r] of Object.entries(file?.routes ?? {})) {
    rows.push({
      route_id:       routeId,
      vehicle_string: r.vehicleType ?? '',
      garage_code:    r.garageCode ?? '',
      pvr:            r.pvr ?? '',
    });
  }
  rows.sort((a, b) => a.route_id.localeCompare(b.route_id));
  writeCsv('03-lbr-routes.csv', ['route_id', 'vehicle_string', 'garage_code', 'pvr'], rows);
  return rows;
}

// ── Source 4: bustimes.org per-operator vehicles pages ──────────────────────
// Each operator page lists every vehicle with fleet_no, registration, last
// route worked, vehicle type, livery. We harvest the table by parsing <tr>
// blocks then lifting individual <td> values.
const BUSTIMES_OPERATOR_SLUGS = [
  // Canonical list discovered from bustimes.org/regions/L (London region).
  // Go-Ahead's London operations are split across four sub-companies on the
  // site (london-central, london-general, metrobus-, docklands-buses) — all
  // included so we capture the full Go-Ahead fleet.
  'stagecoach-london',
  'arriva-london',
  'metroline-travel',
  'go-ahead-london',
  'london-central',
  'london-general',
  'metrobus-operated-by-go-ahead-london',
  'docklands-buses',
  'abellio-london',
  'uno',
  'sullivan-buses',
  'first-in-london',
  'blue-triangle',
];

async function fetchOperatorVehicles(slug) {
  const url = `https://bustimes.org/operators/${slug}/vehicles`;
  const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
  if (!res.ok) return null;
  return await res.text();
}

// Parse one <tr> block. The page uses one <tr> per vehicle with cells in
// stable order: fleet_no, branding/feature flag, registration, last_route,
// last_seen, livery, vehicle_type, ...
function parseVehicleRow(trHtml) {
  // Pull each <td> contents — strip nested tags to plain text.
  const cells = [];
  const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tdRe.exec(trHtml)) !== null) {
    const text = m[1]
      .replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    cells.push(text);
  }
  return cells;
}

function looksLikeReg(s) {
  if (!s) return false;
  const t = s.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z]{3}$|^[A-Z]\d{1,3}[A-Z]{3}$|^[A-Z]{3}\d{1,3}[A-Z]?$/.test(t);
}

async function buildBustimesCsv() {
  const rows = [];
  for (const slug of BUSTIMES_OPERATOR_SLUGS) {
    process.stdout.write(`  bustimes.org/${slug} ... `);
    let html;
    try {
      html = await fetchOperatorVehicles(slug);
    } catch (err) {
      console.log(`fetch failed (${err.message})`);
      continue;
    }
    if (!html) { console.log('404'); continue; }

    const trMatches = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    let parsed = 0;
    for (const tr of trMatches) {
      const cells = parseVehicleRow(tr);
      if (cells.length < 4) continue;
      // Find which cell looks like a registration — the rest fall into place.
      const regIdx = cells.findIndex(looksLikeReg);
      if (regIdx === -1) continue;
      const reg = cells[regIdx].replace(/\s+/g, '').toUpperCase();
      const fleetNo = regIdx > 0 ? cells[0] : '';
      // Vehicle type tends to live a few cells past the reg, after last-seen
      // and livery columns. Look for a cell containing words common to bus
      // type strings: ADL, Enviro, Volvo, BYD, Streetdeck, Wright, etc.
      let vehicleType = '';
      let lastRoute = '';
      const typeRe = /(ADL|Alexander Dennis|Enviro|Volvo|BYD|Wright|Streetdeck|Optare|Yutong|MCV|Switch|Mercedes|Iveco|Solo|Streetlite|VDL|Scania|Borismaster|New Bus for London|NB4L|Citaro|Trident|Plaxton|Caetano|Higer|FCEV)/i;
      for (let i = regIdx + 1; i < cells.length; i++) {
        const c = cells[i];
        if (!c) continue;
        if (!vehicleType && typeRe.test(c)) vehicleType = c;
        // Last route is often a short numeric/letter id between the reg and the time.
        if (!lastRoute && /^[A-Z]?\d{1,3}[A-Z]?$/i.test(c) && c.length <= 5) lastRoute = c;
      }
      rows.push({
        registration:  reg,
        operator_slug: slug,
        fleet_no:      fleetNo,
        last_route:    lastRoute,
        vehicle_type:  vehicleType,
      });
      parsed++;
    }
    console.log(`${parsed} vehicles parsed`);
    // Polite pacing.
    await new Promise(r => setTimeout(r, 800));
  }
  writeCsv('04-bustimes.csv', ['registration', 'operator_slug', 'fleet_no', 'last_route', 'vehicle_type'], rows);
  return rows;
}

// ── Source 5: our route_classifications.json (DVLA-derived per route) ──────
function buildOurCsv() {
  const file = readJsonOrEmpty(path.join(DATA_DIR, 'route_classifications.json'));
  const rows = [];
  for (const [routeId, r] of Object.entries(file?.routes ?? {})) {
    rows.push({
      route_id:           routeId,
      make:               r.make ?? '',
      vehicle_type:       r.vehicleType ?? '',
      propulsion:         r.propulsion ?? '',
      deck:               r.deck ?? '',
      vehicle_age_years:  r.vehicleAgeYears ?? '',
      operator:           r.operator ?? '',
      pvr:                r.pvr ?? '',
    });
  }
  rows.sort((a, b) => a.route_id.localeCompare(b.route_id));
  writeCsv('05-our-aggregate.csv',
    ['route_id', 'make', 'vehicle_type', 'propulsion', 'deck', 'vehicle_age_years', 'operator', 'pvr'],
    rows);
  return rows;
}

// ── 00 — cross-source comparison per route ─────────────────────────────────
function buildComparison({ tflRows, ibusRows, lbrRows, bustimesRows, ourRows }) {
  const ibusByReg = new Map();
  for (const r of ibusRows) ibusByReg.set(r.registration, r);
  const bustimesByReg = new Map();
  for (const r of bustimesRows) bustimesByReg.set(r.registration, r);

  const ourByRoute = new Map();
  for (const r of ourRows) ourByRoute.set(r.route_id, r);
  const lbrByRoute = new Map();
  for (const r of lbrRows) lbrByRoute.set(r.route_id, r);

  // Group TfL arrivals by route → set of regs
  const tflByRoute = new Map();
  for (const r of tflRows) {
    if (!tflByRoute.has(r.route_id)) tflByRoute.set(r.route_id, new Set());
    tflByRoute.get(r.route_id).add(r.registration);
  }

  const allRoutes = new Set([
    ...lbrByRoute.keys(),
    ...ourByRoute.keys(),
    ...tflByRoute.keys(),
  ]);

  const rows = [];
  for (const routeId of [...allRoutes].sort()) {
    const our = ourByRoute.get(routeId) ?? {};
    const lbr = lbrByRoute.get(routeId) ?? {};
    const regs = tflByRoute.get(routeId) ?? new Set();

    // Bustimes vehicle types observed on this route (via reg join)
    const bustimesTypes = new Set();
    let bustimesObservedRegs = 0;
    for (const reg of regs) {
      const bt = bustimesByReg.get(reg);
      if (bt?.vehicle_type) {
        bustimesTypes.add(bt.vehicle_type);
        bustimesObservedRegs++;
      }
    }

    rows.push({
      route_id:                  routeId,
      // Per source values:
      lbr_vehicle_string:        lbr.vehicle_string ?? '',
      bustimes_types:            [...bustimesTypes].join(' | '),
      bustimes_observed_regs:    bustimesObservedRegs,
      our_make:                  our.make ?? '',
      our_vehicle_type:          our.vehicle_type ?? '',
      our_propulsion:            our.propulsion ?? '',
      our_deck:                  our.deck ?? '',
      tfl_observed_reg_count:    regs.size,
    });
  }

  writeCsv('00-comparison.csv', [
    'route_id',
    'lbr_vehicle_string',
    'bustimes_types',
    'bustimes_observed_regs',
    'our_make',
    'our_vehicle_type',
    'our_propulsion',
    'our_deck',
    'tfl_observed_reg_count',
  ], rows);
  return rows;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Audit output: ${OUT_DIR}\n`);

  console.log('Source 1: TfL /Line/<id>/Arrivals  (from data/source/route-vehicles.json)');
  const tflRows = buildTflCsv();

  console.log('\nSource 2: iBus Vehicle.xml         (from data/source/vehicle-fleet.json)');
  const ibusRows = buildIbusCsv();

  console.log('\nSource 3: LBR details.htm          (from data/source/route_details.json)');
  const lbrRows = buildLbrCsv();

  console.log('\nSource 4: bustimes.org operator pages (live scrape)');
  const bustimesRows = await buildBustimesCsv();

  console.log('\nSource 5: our aggregate            (from data/route_classifications.json)');
  const ourRows = buildOurCsv();

  console.log('\nCross-source comparison...');
  const cmp = buildComparison({ tflRows, ibusRows, lbrRows, bustimesRows, ourRows });
  console.log(`  00-comparison.csv: ${cmp.length} routes`);

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
