/**
 * push-to-supabase.js — Mirror the static data files into the Supabase store.
 *
 * Runs at the end of the weekly pipeline. Reads three files produced by
 * earlier steps and upserts the contents into Supabase Postgres:
 *
 *   data/source/vehicle-fleet.json   → public.vehicles               (upsert by registration)
 *   data/route_classifications.json  → public.route_snapshots        (upsert per (route_id, snapshot_date))
 *     + data/route_stops.json        → adds stop_count per snapshot row
 *   data/source/route-vehicles.json  → public.route_vehicle_observations (insert this run's fresh observations)
 *   data/garages.geojson             → public.garage_snapshots       (upsert per (garage_code, snapshot_date))
 *     + summed PVR / route count derived from route_classifications
 *   data/source/route-performance.json → public.route_performance    (upsert per (route_id, period_label))
 *   data/source/tenders.json         → public.tenders                (upsert per tfl_tender_id, append-only)
 *   data/source/tender-programme.json → public.tender_programme      (upsert per (programme_year, tranche, route_id))
 *   data/source/accidents.json       → public.accidents             (upsert per collision_id)
 *
 * The static-JSON read path that powers the public map is unaffected — Supabase
 * is a *write* destination only, used to build the historical record that
 * powers the analytics page.
 *
 * Soft-fail by design: if Supabase is unreachable or the env vars aren't set,
 * the script logs and exits 0 so the rest of the pipeline (which has already
 * succeeded by this point) isn't penalised.
 *
 * Run: npm run push-to-supabase
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const BATCH     = 500;        // Supabase recommends ≤1000 rows per upsert; 500 is safely under

loadEnv();
const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Supabase env not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — skipping push.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Service-role key bypasses RLS so we can write freely.
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`  Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

async function upsertInBatches(table, rows, conflictKey) {
  if (!rows.length) {
    console.log(`  ${table}: nothing to write`);
    return;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict: conflictKey, ignoreDuplicates: false });
    if (error) {
      throw new Error(`${table} upsert failed at row ${i}: ${error.message}`);
    }
    written += chunk.length;
  }
  console.log(`  ${table}: wrote ${written} rows`);
}

async function insertInBatches(table, rows) {
  if (!rows.length) {
    console.log(`  ${table}: nothing to insert`);
    return;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    // Use upsert with ignoreDuplicates so a manual re-run of the pipeline on
    // the same Monday doesn't error on duplicate primary keys.
    const { error } = await supabase
      .from(table)
      .upsert(chunk, {
        onConflict: 'route_id,registration,observed_at',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`${table} insert failed at row ${i}: ${error.message}`);
    written += chunk.length;
  }
  console.log(`  ${table}: inserted up to ${written} rows (duplicates ignored)`);
}

// ── 1. vehicles ─────────────────────────────────────────────────────────────
async function pushVehicles() {
  const path_ = path.join(DATA_DIR, 'source', 'vehicle-fleet.json');
  const fleet = readJsonOrNull(path_);
  if (!fleet) {
    console.log('  vehicles: no vehicle-fleet.json — skipping');
    return;
  }
  const now = new Date().toISOString();
  const rows = Object.entries(fleet.vehicles ?? {}).map(([reg, v]) => ({
    registration:                reg,
    make:                        v.make ?? null,
    fuel_type:                   v.fuelType ?? null,
    fuel_type_raw:               v.fuelTypeRaw ?? null,
    year_of_manufacture:         Number.isFinite(v.yearOfManufacture) ? v.yearOfManufacture : null,
    month_of_first_registration: v.monthOfFirstRegistration ?? null,
    bonnet_no:                   v.bonnetNo ?? null,
    operator:                    v.operator ?? null,
    dvla_status:                 Number.isFinite(v.dvlaStatus) ? v.dvlaStatus : null,
    last_checked_at:             v.lastCheckedAt ?? null,
    data_as_of:                  v.lastCheckedAt ?? null,   // explicit data_as_of per the dual-timestamp convention
    updated_at:                  now,
  }));
  await upsertInBatches('vehicles', rows, 'registration');
}

// Snapshot date used by every per-week table this run. Driven by the
// classifications generatedAt so all tables agree on which Monday they
// belong to. Falls back to today (UTC) for ad-hoc local runs.
function snapshotDateFor(cls) {
  return (cls?.generatedAt ? new Date(cls.generatedAt) : new Date())
    .toISOString().slice(0, 10);
}

// Per-route stop count from route_stops.json. Used as a column on
// route_snapshots so weekly trends in route length / coverage are visible
// without storing the full stop list weekly.
function loadStopCounts() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'route_stops.json'));
  const map = {};
  for (const [routeId, list] of Object.entries(file?.routes ?? {})) {
    if (Array.isArray(list)) map[routeId] = list.length;
  }
  return map;
}

// ── 2. route_snapshots ──────────────────────────────────────────────────────
async function pushRouteSnapshots() {
  const cls = readJsonOrNull(path.join(DATA_DIR, 'route_classifications.json'));
  if (!cls?.routes) {
    console.log('  route_snapshots: no classifications — skipping');
    return;
  }
  const snapshotDate = snapshotDateFor(cls);
  const stopCounts = loadStopCounts();

  const rows = Object.entries(cls.routes).map(([routeId, r]) => ({
    route_id:          routeId,
    snapshot_date:     snapshotDate,
    type:              r.type ?? null,
    is_prefix:         r.isPrefix ?? null,
    length_band:       r.lengthBand ?? null,
    deck:              r.deck ?? null,
    vehicle_type:      r.vehicleType ?? null,
    propulsion:        r.propulsion ?? null,
    make:              r.make ?? null,
    vehicle_age_years: Number.isFinite(r.vehicleAgeYears) ? r.vehicleAgeYears : null,
    fleet_size:        Number.isFinite(r.fleetSize) ? r.fleetSize : null,
    operator:          r.operator ?? null,
    garage_name:       r.garageName ?? null,
    garage_code:       r.garageCode ?? null,
    pvr:               Number.isFinite(r.pvr) ? r.pvr : null,
    frequency:         r.frequency ?? null,
    stop_count:        Number.isFinite(stopCounts[routeId]) ? stopCounts[routeId] : null,
    // Contractual Minimum Performance Standards (per route, from the
    // per-route TfL QSI PDFs — vary route-by-route within a service class).
    ewt_mps_minutes:     Number.isFinite(r.ewtMps)     ? r.ewtMps     : null,
    otp_mps_percent:     Number.isFinite(r.otpMps)     ? r.otpMps     : null,
    mileage_mps_percent: Number.isFinite(r.mileageMps) ? r.mileageMps : null,
    // Reliability snapshot (denormalised from route_performance for clean
    // per-week trend queries). Source-of-truth for the period history is
    // still the route_performance table.
    service_class:     r.serviceClass   ?? null,
    ewt_minutes:       Number.isFinite(r.ewtMinutes)    ? r.ewtMinutes    : null,
    on_time_percent:   Number.isFinite(r.onTimePercent) ? r.onTimePercent : null,
    perf_period:       r.perfPeriod ?? null,
    // Last (current) tender derivations — denormalised from tenders
    // history so a snapshot row carries the full tender story without a
    // multi-table JOIN at query time.
    previous_operator:        r.previousOperator ?? null,
    last_award_date:          r.lastAwardDate ?? null,
    contract_start_date:      r.contractStartDate ?? null,
    last_cost_per_mile:       Number.isFinite(r.lastCostPerMile)  ? r.lastCostPerMile : null,
    tender_award_count:       Number.isFinite(r.tenderAwardCount) ? r.tenderAwardCount : null,
    number_of_tenderers:      Number.isFinite(r.numberOfTenderers) ? r.numberOfTenderers : null,
    was_joint_bid:            (typeof r.wasJointBid === 'boolean') ? r.wasJointBid : null,
    contract_term_years:      Number.isFinite(r.contractTermYears) ? r.contractTermYears : null,
    awarded_propulsion:       r.awardedPropulsion ?? null,
    awarded_deck:             r.awardedDeck ?? null,
    prev_awarded_propulsion:  r.prevAwardedPropulsion ?? null,
    prev_awarded_deck:        r.prevAwardedDeck ?? null,
    // Next (upcoming) tender derivations — denormalised from tender_programme.
    next_tender_start:        r.nextTenderStart ?? null,
    next_tender_year:         r.nextTenderYear ?? null,
    extension_eligible:       (typeof r.extensionEligible === 'boolean') ? r.extensionEligible : null,
    next_award_propulsion:    r.nextAwardPropulsion ?? null,
    next_award_deck:          r.nextAwardDeck ?? null,
    next_tender_tranche:      r.nextTenderTranche != null && String(r.nextTenderTranche).trim() !== '' ? String(r.nextTenderTranche) : null,
    // Current active contract — the originating award, distinct from the
    // latest tender. Distinguished from `last_*` so a snapshot row carries
    // both 'what's running today' (current_*) and 'what's most recently
    // been awarded' (last_*) without a multi-table JOIN at query time.
    current_contract_award_date:           r.currentContractAwardDate ?? null,
    current_contract_cost_per_mile:        Number.isFinite(r.currentContractCostPerMile)        ? r.currentContractCostPerMile        : null,
    current_contract_accepted_bid:         Number.isFinite(r.currentContractAcceptedBid)        ? r.currentContractAcceptedBid        : null,
    current_contracted_annual_miles:       Number.isFinite(r.currentContractedAnnualMiles)      ? r.currentContractedAnnualMiles      : null,
    current_contract_number_of_tenderers:  Number.isFinite(r.currentContractNumberOfTenderers)  ? r.currentContractNumberOfTenderers  : null,
    current_contract_was_joint_bid:        (typeof r.currentContractWasJointBid === 'boolean')  ? r.currentContractWasJointBid        : null,
    current_contract_awarded_propulsion:   r.currentContractAwardedPropulsion ?? null,
    current_contract_awarded_deck:         r.currentContractAwardedDeck ?? null,
    current_contract_awarded_operator:     r.currentContractAwardedOperator ?? null,
    // Latest-tender operator — companion to last_award_date. Distinct from
    // previous_operator (which is the predecessor, not the latest awardee).
    last_awarded_operator:                 r.lastAwardedOperator ?? null,
    // Previous-operator contract detail — full like-for-like row with the
    // current and latest blocks. previous_operator + previous_award_date
    // already existed; the rest of the row is new in 0012.
    previous_award_date:                   r.previousAwardDate ?? null,
    previous_cost_per_mile:                Number.isFinite(r.previousCostPerMile)               ? r.previousCostPerMile               : null,
    previous_accepted_bid:                 Number.isFinite(r.previousAcceptedBid)               ? r.previousAcceptedBid               : null,
    previous_contracted_annual_miles:      Number.isFinite(r.previousContractedAnnualMiles)     ? r.previousContractedAnnualMiles     : null,
    previous_contract_term_years:          Number.isFinite(r.previousContractTermYears)         ? r.previousContractTermYears         : null,
    previous_number_of_tenderers:          Number.isFinite(r.previousNumberOfTenderers)         ? r.previousNumberOfTenderers         : null,
    previous_was_joint_bid:                (typeof r.previousWasJointBid === 'boolean')         ? r.previousWasJointBid               : null,
  }));
  await upsertInBatches('route_snapshots', rows, 'route_id,snapshot_date');
}

// ── 4. garage_snapshots ─────────────────────────────────────────────────────
// Per-garage weekly row. Static-ish fields (name, operator, address, location)
// come from data/garages.geojson; the aggregate fields (total_pvr,
// route_count) are summed from this run's route_classifications so the
// figures match the route-level snapshot for the same week.
async function pushGarageSnapshots() {
  const cls     = readJsonOrNull(path.join(DATA_DIR, 'route_classifications.json'));
  const garages = readJsonOrNull(path.join(DATA_DIR, 'garages.geojson'));
  if (!cls?.routes) {
    console.log('  garage_snapshots: no classifications — skipping');
    return;
  }
  if (!garages?.features) {
    console.log('  garage_snapshots: no garages.geojson — skipping');
    return;
  }
  const snapshotDate = snapshotDateFor(cls);

  // Aggregate this week's route data per garage_code so each garage row
  // carries summed PVR + route count consistent with route_snapshots.
  const aggByCode = {};   // { code: { totalPvr, routes: Set } }
  for (const [routeId, r] of Object.entries(cls.routes)) {
    const code = (r.garageCode || '').toUpperCase();
    if (!code) continue;
    const a = aggByCode[code] ??= { totalPvr: 0, routes: new Set() };
    if (Number.isFinite(r.pvr)) a.totalPvr += r.pvr;
    a.routes.add(routeId);
  }

  const rows = [];
  const seenCodes = new Set();   // de-duplicate if a code appears twice in geojson
  for (const f of garages.features) {
    const p = f.properties ?? {};
    const code = String(p['TfL garage code'] || p['LBR garage code'] || '').trim().toUpperCase();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);

    const splitRoutes = (s) => String(s ?? '')
      .split(/\s+/).map(t => t.trim().toUpperCase()).filter(Boolean);

    const agg = aggByCode[code];
    const lon = f.geometry?.type === 'Point' ? f.geometry.coordinates?.[0] : null;
    const lat = f.geometry?.type === 'Point' ? f.geometry.coordinates?.[1] : null;

    rows.push({
      garage_code:   code,
      snapshot_date: snapshotDate,
      garage_name:   p['Garage name'] ?? null,
      operator:      p['Group name'] ?? null,
      address:       p['Garage address'] ?? null,
      postcode:      p['_geocode_postcode'] ?? null,
      lat:           Number.isFinite(lat) ? lat : null,
      lon:           Number.isFinite(lon) ? lon : null,
      total_pvr:     agg ? agg.totalPvr : 0,
      route_count:   agg ? agg.routes.size : 0,
      routes:        splitRoutes(p['TfL main network routes']),
      night_routes:  splitRoutes(p['TfL night routes']),
      school_routes: splitRoutes(p['TfL school/mobility routes']),
    });
  }
  await upsertInBatches('garage_snapshots', rows, 'garage_code,snapshot_date');
}

// ── 5. route_performance ────────────────────────────────────────────────────
// EWT (high-frequency) / OTP (low-frequency) per-route metrics from the TfL
// QSI PDF. Idempotent on (route_id, period_label) — re-running while the PDF
// is unchanged updates extracted_at but otherwise no-ops on row content.
async function pushRoutePerformance() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'source', 'route-performance.json'));
  if (!file?.routes || !file.periodLabel) {
    console.log('  route_performance: no parsed data — skipping');
    return;
  }
  const periodLabel = file.periodLabel;
  const periodStart = file.periodStart ?? null;
  const periodEnd   = file.periodEnd   ?? null;
  const sourceUrl   = file.sourceUrl   ?? null;
  const pdfModified = file.pdfModifiedAt ?? null;
  const extractedAt = file.generatedAt ?? new Date().toISOString();

  const rows = Object.entries(file.routes).map(([routeId, r]) => ({
    route_id:                          routeId,
    period_label:                      periodLabel,
    period_start:                      periodStart,
    period_end:                        periodEnd,
    service_class:                     r.service_class ?? null,
    ewt_minutes:                       Number.isFinite(r.ewt_minutes)         ? r.ewt_minutes         : null,
    swt_minutes:                       Number.isFinite(r.swt_minutes)         ? r.swt_minutes         : null,
    awt_minutes:                       Number.isFinite(r.awt_minutes)         ? r.awt_minutes         : null,
    on_time_percent:                   Number.isFinite(r.on_time_percent)     ? r.on_time_percent     : null,
    early_percent:                     Number.isFinite(r.early_percent)       ? r.early_percent       : null,
    late_percent:                      Number.isFinite(r.late_percent)        ? r.late_percent        : null,
    non_arrival_percent:               Number.isFinite(r.non_arrival_percent) ? r.non_arrival_percent : null,
    scheduled_mileage_operated_percent: Number.isFinite(r.scheduled_mileage_operated_percent)
                                          ? r.scheduled_mileage_operated_percent : null,
    source_url:                        sourceUrl,
    pdf_modified_at:                   pdfModified,
    extracted_at:                      extractedAt,
  }));
  await upsertInBatches('route_performance', rows, 'route_id,period_label');
}

// ── 3. route_vehicle_observations ───────────────────────────────────────────
// Only push observations made *this run*. fetch-route-vehicles.js stamps every
// freshly-seen registration with the current run's `generatedAt`; older
// entries carry their previous lastSeenAt and are already in the DB from
// previous weeks. Filtering by lastSeenAt === generatedAt avoids duplicate
// inserts at the application layer (the PK + ignoreDuplicates is the
// belt-and-braces second line).
async function pushObservations() {
  const path_ = path.join(DATA_DIR, 'source', 'route-vehicles.json');
  const file = readJsonOrNull(path_);
  if (!file?.routes) {
    console.log('  route_vehicle_observations: no route-vehicles.json — skipping');
    return;
  }
  const thisRun = file.generatedAt;
  if (!thisRun) {
    console.log('  route_vehicle_observations: no generatedAt — skipping');
    return;
  }
  const rows = [];
  for (const [routeId, list] of Object.entries(file.routes)) {
    for (const entry of (list ?? [])) {
      if (entry?.lastSeenAt === thisRun && entry?.reg) {
        rows.push({
          route_id:     routeId,
          registration: entry.reg,
          observed_at:  entry.lastSeenAt,
        });
      }
    }
  }
  console.log(`  route_vehicle_observations: ${rows.length} fresh observations from this run`);
  await insertInBatches('route_vehicle_observations', rows);
}

// ── Tender derived-field helpers ────────────────────────────────────────────
// Derived columns (added in 0007). All computed from fields we already have;
// stored on the row so analytics queries don't have to reapply the regex.
// Each can be overridden per-row via data/tender-overrides.json.
function deriveTenderPropulsion(notes, jointBids) {
  const pool = `${notes ?? ''} ${jointBids ?? ''}`.toLowerCase();
  if (!pool.trim()) return null;
  // Plural forms ("electrics", "hybrids", "diesels") are common in TfL's
  // notes ("Awarded on existing diesels", "Awarded on new electrics").
  // Hydrogen check first — most specific.
  if (/\b(?:fuel\s*cells?|fcev|hydrogen)\b/.test(pool))                     return 'hydrogen';
  if (/\b(?:battery\s*hybrids?|hybrid\s*electrics?|hybrids?)\b/.test(pool)) return 'hybrid';
  if (/\b(?:zero\s*emission|battery\s*electrics?|electrics?|evs?|zedd|zesd)\b/.test(pool))
                                                                            return 'electric';
  if (/\b(?:diesels?|euro\s*\d)\b/.test(pool) && !/electric|hybrid/.test(pool)) return 'diesel';
  return null;
}
function deriveJointBid(notes, jointBids) {
  if (jointBids && jointBids.trim().length > 5 && !/^N\/?A$/i.test(jointBids.trim())) return true;
  if (notes && /\b(?:joint\s*bid|jb)\b/i.test(notes)) return true;
  return false;
}
function deriveVehiclesBasis(notes) {
  if (!notes) return null;
  const t = notes.toLowerCase();
  if (/\bexisting\b/.test(t)) return 'existing';
  // 'awarded on new electrics' / 'new bus' / 'new vehicles' / 'new euro VI hybrids'
  if (/\bnew\s+(?:bus|vehicle|fleet|electric|hybrid|euro|hydrogen|streetdeck|euro vi|battery)/i.test(t)) return 'new';
  if (/\b(?:awarded|award)\s+on\s+new\b/.test(t)) return 'new';
  return null;
}
// Awarded deck from notes: 'double' | 'single' | null. Mirrors deriveDeck() in
// pipeline/lib/tender-parse.js (the app side) so the warehouse and the app agree.
function deriveAwardedDeck(notes) {
  if (!notes) return null;
  const t = notes.toLowerCase();
  if (/double[\s-]*deck/.test(t)) return 'double';
  if (/single[\s-]*deck/.test(t)) return 'single';
  return null;
}
function deriveProgrammePropulsion(vehicleType) {
  if (!vehicleType) return null;
  const t = vehicleType.toUpperCase();
  if (/ZE(?:DD|SD)|\bZE\b|ZERO/i.test(t))         return 'electric';
  if (/\bH(?:DD|SD)\b|HYBRID/i.test(t))           return 'hybrid';
  if (/\bFC|HYDROGEN/i.test(t))                   return 'hydrogen';
  return null;
}

// Build a route_id -> current operator map from route_classifications.json
// for use as `previous_operator` on the upcoming-tender programme rows.
function loadCurrentOperators() {
  const cls = readJsonOrNull(path.join(DATA_DIR, 'route_classifications.json'));
  const map = {};
  for (const [routeId, r] of Object.entries(cls?.routes ?? {})) {
    if (r?.operator) map[routeId.toUpperCase()] = r.operator;
  }
  return map;
}
// Look up by exact route id, or for joint routes like '69/N69' try each part.
function operatorForRoute(map, routeId) {
  if (!routeId) return null;
  const exact = map[routeId.toUpperCase()];
  if (exact) return exact;
  for (const part of routeId.split('/')) {
    const v = map[part.toUpperCase()];
    if (v) return v;
  }
  return null;
}

// ── 6. tenders ──────────────────────────────────────────────────────────────
// Historical tender award records. Append-only by (tfl_tender_id) — once a
// row is in the cache it never changes (TfL doesn't retroactively edit
// award results). Re-running this is a no-op for existing rows; only newly-
// scraped btIDs appear in the upsert.
//
// Manual overrides from data/tender-overrides.json are merged on top of the
// scraped values immediately before upsert, so a single line in that file
// can correct a typo, backfill a TfL "N/A", or annotate a tender with notes
// without re-scraping. Same idiom as data/route-overrides.json. Keys
// starting with `_` are ignored (used for inline documentation / examples).
async function pushTenders() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'source', 'tenders.json'));
  if (!file?.tenders) {
    console.log('  tenders: no source file — skipping');
    return;
  }

  const overridesFile = readJsonOrNull(path.join(DATA_DIR, 'tender-overrides.json'));
  const overrides = {};
  for (const [k, v] of Object.entries(overridesFile?.tenders ?? {})) {
    if (k.startsWith('_')) continue;
    overrides[k] = v;
  }
  if (Object.keys(overrides).length) {
    console.log(`  tenders: loaded ${Object.keys(overrides).length} manual override(s)`);
  }

  // First pass: build canonical rows with overrides applied AND derived flags
  // (propulsion_type, is_joint_bid, vehicles_basis). previous_operator needs
  // a second pass because it's window-style: the prior tender for the same route.
  const rows = Object.entries(file.tenders).map(([btId, t]) => {
    const ov           = overrides[btId] ?? {};
    const notes        = ov.notes      ?? t.notes      ?? null;
    const jointBids    = ov.joint_bids ?? t.joint_bids ?? null;
    const propulsion   = ov.propulsion_type ?? deriveTenderPropulsion(notes, jointBids);
    const isJoint      = (typeof ov.is_joint_bid === 'boolean')
                           ? ov.is_joint_bid
                           : deriveJointBid(notes, jointBids);
    const basis        = ov.vehicles_basis ?? deriveVehiclesBasis(notes);
    const awardedDeck  = ov.awarded_deck ?? deriveAwardedDeck(notes);
    return {
      tfl_tender_id:        parseInt(btId, 10),
      route_id:             ov.route_id             ?? t.route_id             ?? '',
      award_announced_date: ov.award_announced_date ?? t.award_announced_date ?? null,
      awarded_operator:     ov.awarded_operator     ?? t.awarded_operator     ?? null,
      number_of_tenderers:  Number.isFinite(ov.number_of_tenderers) ? ov.number_of_tenderers
                          : (Number.isFinite(t.number_of_tenderers) ? t.number_of_tenderers : null),
      accepted_bid:         Number.isFinite(ov.accepted_bid) ? ov.accepted_bid
                          : (Number.isFinite(t.accepted_bid) ? t.accepted_bid : null),
      lowest_bid:           Number.isFinite(ov.lowest_bid)   ? ov.lowest_bid
                          : (Number.isFinite(t.lowest_bid)   ? t.lowest_bid   : null),
      highest_bid:          Number.isFinite(ov.highest_bid)  ? ov.highest_bid
                          : (Number.isFinite(t.highest_bid)  ? t.highest_bid  : null),
      cost_per_mile:        Number.isFinite(ov.cost_per_mile) ? ov.cost_per_mile
                          : (Number.isFinite(t.cost_per_mile) ? t.cost_per_mile : null),
      reason_not_lowest:    ov.reason_not_lowest    ?? t.reason_not_lowest    ?? null,
      joint_bids:           jointBids,
      notes:                notes,
      // Derived columns (added in 0007; awarded_deck in 0016)
      propulsion_type:      propulsion,
      is_joint_bid:         isJoint,
      vehicles_basis:       basis,
      awarded_deck:         awardedDeck,
      previous_operator:    ov.previous_operator    ?? null,   // populated in 2nd pass
      source_url:           t.source_url ?? null,
      data_as_of:           ov.award_announced_date ?? t.award_announced_date ?? null,
      extracted_at:         t.scraped_at ?? new Date().toISOString(),
    };
  });

  // Second pass: previous_operator. Sort within each route by award date,
  // then walk in order so each row inherits the prior row's awarded_operator.
  // Skips rows that already have an override (set in pass 1).
  const byRoute = {};
  for (const r of rows) {
    if (!byRoute[r.route_id]) byRoute[r.route_id] = [];
    byRoute[r.route_id].push(r);
  }
  for (const list of Object.values(byRoute)) {
    list.sort((a, b) => String(a.award_announced_date ?? '').localeCompare(String(b.award_announced_date ?? '')));
    let prev = null;
    for (const r of list) {
      if (r.previous_operator == null) r.previous_operator = prev;
      prev = r.awarded_operator ?? prev;
    }
  }

  await upsertInBatches('tenders', rows, 'tfl_tender_id');
}

// ── 7. tender_programme ─────────────────────────────────────────────────────
// Forward-looking tender schedule from the annual LBSL programme PDFs.
// Idempotent on (programme_year, tranche, route_id) — re-running with a
// freshly-published PDF updates affected rows in place.
async function pushTenderProgramme() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'source', 'tender-programme.json'));
  if (!file?.years) {
    console.log('  tender_programme: no source file — skipping');
    return;
  }
  // Look up the operator currently running each route so we can populate
  // `previous_operator` on every programme row -- once the upcoming tender
  // awards, today's operator becomes the previous one.
  const currentOps = loadCurrentOperators();

  const rows = [];
  for (const year of file.years) {
    for (const e of (year.entries ?? [])) {
      rows.push({
        programme_year:        e.programme_year,
        tranche:               e.tranche ?? null,
        route_id:              e.route_id,
        tender_issue_date:     e.tender_issue_date ?? null,
        tender_return_date:    e.tender_return_date ?? null,
        award_estimated:       e.award_estimated ?? null,
        contract_start_date:   e.contract_start_date ?? null,
        route_description:     e.route_description ?? null,
        vehicle_type:          e.vehicle_type ?? null,
        two_year_extension:    !!e.two_year_extension,
        // Derived columns (added in 0007)
        propulsion_type:       deriveProgrammePropulsion(e.vehicle_type),
        previous_operator:     operatorForRoute(currentOps, e.route_id),
        source_url:            e.source_url ?? null,
        pdf_modified_at:       e.pdf_modified_at ?? null,
        data_as_of:            e.data_as_of ?? null,
      });
    }
  }
  // Skip rows missing tranche — Postgres rejects null in a UNIQUE composite
  // when other slots collide, and we'd rather drop the noise than fail the batch.
  const filtered = rows.filter(r => r.tranche);
  if (filtered.length < rows.length) {
    console.log(`  tender_programme: dropped ${rows.length - filtered.length} rows without a tranche`);
  }
  await upsertInBatches('tender_programme', filtered, 'programme_year,tranche,route_id');
}

// ── 8. accidents ────────────────────────────────────────────────────────────
// Bus/coach-involved Greater-London collisions from DfT STATS19 (open road-
// safety data). Idempotent on collision_id — published collisions are
// immutable, so a re-run upserts unchanged rows and only adds newly-published
// ids. Feeds Atlas's accidents (KSI) layer.
async function pushAccidents() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'source', 'accidents.json'));
  if (!file?.accidents) {
    console.log('  accidents: no accidents.json — skipping');
    return;
  }
  const extractedAt = file.generatedAt ?? new Date().toISOString();
  const rows = file.accidents
    .filter(a => a && a.id)
    .map(a => ({
      collision_id:   String(a.id),
      lat:            Number.isFinite(a.lat) ? a.lat : null,
      lng:            Number.isFinite(a.lng) ? a.lng : null,
      severity:       a.severity ?? null,
      collision_date: a.date ?? null,
      borough:        a.borough ?? null,
      vehicles:       Number.isFinite(a.vehicles) ? a.vehicles : null,
      // decoded STATS19 collision-context (migration 0017) — clean labels, nullable
      road_type:      a.roadType ?? null,
      speed_limit:    a.speedLimit ?? null,
      junction:       a.junction ?? null,
      light:          a.light ?? null,
      weather:        a.weather ?? null,
      road_surface:   a.roadSurface ?? null,
      extracted_at:   extractedAt,
    }));
  await upsertInBatches('accidents', rows, 'collision_id');
}

// route_schedule — the scheduled-side baseline (SWT, scheduled km) the live-
// reliability sampler + builder read. One row per (route_id, snapshot_date).
async function pushSchedule() {
  const file = readJsonOrNull(path.join(DATA_DIR, 'source', 'route-schedule.json'));
  if (!file?.routes) {
    console.log('  route_schedule: no route-schedule.json — skipping');
    return;
  }
  const snapshotDate = (file.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const rows = Object.entries(file.routes).map(([id, r]) => ({
    route_id:        String(id),
    snapshot_date:   snapshotDate,
    service_class:   r.service_class ?? null,
    swt_minutes:     Number.isFinite(r.swt_minutes) ? r.swt_minutes : null,
    scheduled_trips: Number.isFinite(r.scheduled_trips) ? r.scheduled_trips : null,
    scheduled_km:    Number.isFinite(r.scheduled_km) ? r.scheduled_km : null,
    headway_min:     Number.isFinite(r.headway_min) ? r.headway_min : null,
    source:          'TfL Timetable',
  })).filter(r => r.route_id);
  await upsertInBatches('route_schedule', rows, 'route_id,snapshot_date');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Pushing to Supabase at ${SUPABASE_URL}`);
  await pushVehicles();
  await pushRouteSnapshots();
  await pushObservations();
  await pushGarageSnapshots();
  await pushAccidents();
  await pushSchedule();
  await pushRoutePerformance();
  await pushTenders();
  await pushTenderProgramme();
  console.log('Done.');
}

main().catch(err => {
  // Soft-fail: log and exit 0 so a Supabase outage doesn't break the pipeline.
  // The static JSON files have already been written by previous steps and
  // committed by the workflow. Next Monday's run picks up where this one left
  // off — route_snapshots is keyed on (route_id, snapshot_date) so it's
  // idempotent within a week.
  console.warn(`push-to-supabase failed (soft): ${err.message}`);
  process.exit(0);
});
