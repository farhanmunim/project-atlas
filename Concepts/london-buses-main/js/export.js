/**
 * export.js — XLSX export (topbar Export button).
 *
 * Four sheets, all honouring the current filter state:
 *   • Routes            — per-route data, full record (identity / service /
 *                         fleet / reliability / last tender / next tender)
 *   • Garages           — per-garage data (code, name, operator, address, …)
 *   • Network overview  — per-operator aggregates (share of routes, PVR, EV)
 *                         + PVR-weighted fleet mix
 *   • Tenders           — every historical tender award (~2,500 since 2003)
 *                         AND every upcoming-tender programme entry, in one
 *                         sheet keyed by route + date with a `kind` column.
 *                         Filtered to the visible routes.
 *
 * The Tenders sheet lazy-loads its source JSON only on Export click so an
 * idle page load stays fast (the files together are ~1 MB).
 *
 * SheetJS is loaded via a <script defer> tag. If the user clicks before it
 * finishes downloading we surface a friendly "try again" message rather than
 * erroring into the console.
 */

import { getVisibleRouteProps, getVisibleGarages } from './map.js';
import { state, exportBtn } from './state.js';
import { fetchRouteStopCount } from './api.js';
import { getPinnedRouteIds } from './search.js';

// Threshold above which we warn the user before assembling a full-network
// export. Filtered exports usually return well under this, and skip the
// confirm dialog. Set just below the typical full count (~750 routes) so a
// "few hundred operator-filtered" export still skips the prompt.
const LARGE_EXPORT_THRESHOLD = 250;

exportBtn?.addEventListener('click', async () => {
  if (typeof XLSX === 'undefined') {
    alert('Export library still loading — try again in a moment.');
    return;
  }

  // Selection precedence: searched routes (pinned in the topbar) take over
  // and become the export set, so typing "25, 30, 100" + Export gives those
  // three routes only — even if other filters would otherwise admit more.
  // When no pills are active we fall back to the filter-derived view.
  const pinnedIds = getPinnedRouteIds();
  let routes = getVisibleRouteProps();
  if (pinnedIds.size) {
    const restricted = new Map();
    for (const id of pinnedIds) {
      if (routes.has(id)) {
        restricted.set(id, routes.get(id));
      } else {
        // Pinned but currently hidden by other filters — synthesise an
        // overview-shaped props record from classifications so buildRouteRows
        // sees consistent fields. Pin overrides filter exclusion.
        const cls = state.classifications?.[id];
        if (!cls) continue;
        restricted.set(id, {
          routeId:    id,
          routeType:  cls.type ?? null,
          isPrefix:   !!cls.isPrefix,
          lengthBand: cls.lengthBand ?? null,
          deck:       cls.deck ?? null,
          frequency:  cls.frequency ?? null,
          operator:   cls.operator ?? null,
          propulsion: cls.propulsion ?? null,
        });
      }
    }
    routes = restricted;
  }
  if (!routes.size) return;

  // Heads-up for large exports — full-network exports add ~3,400 tender
  // rows on top of the route/garage data and take a few seconds to
  // assemble. The confirm dialog only fires above the threshold; a tightly
  // filtered selection (or any pinned-route selection) goes straight through.
  if (!pinnedIds.size && routes.size >= LARGE_EXPORT_THRESHOLD) {
    const ok = confirm(
      `You're exporting ${routes.size} routes with no filters applied.\n\n` +
      `This includes the full historical tender history (~3,400 rows) and may take a few seconds to download.\n\n` +
      `Continue?`
    );
    if (!ok) return;
  }

  // Visual feedback while the workbook assembles. Disabling the button
  // also prevents double-click duplicate exports.
  const originalLabel = exportBtn.textContent;
  exportBtn.disabled  = true;
  exportBtn.textContent = 'Preparing…';

  try {
    await runExport(routes);
  } finally {
    exportBtn.disabled  = false;
    exportBtn.textContent = originalLabel;
  }
});

async function runExport(routes) {
  // When the user has pinned specific routes via the topbar search, every
  // sheet should reflect that selection — including Garages (only the
  // garage(s) running the pinned routes) and Tenders (only those routes'
  // history). Visibility-by-pin is detected by comparing the routes Map
  // size to the underlying overview's full count.
  const pinned = getPinnedRouteIds();
  const pinnedRouteIds = pinned.size ? new Set([...routes.keys()]) : null;
  // Pre-resolve per-route stop counts so the Routes sheet can include them.
  // First call warms the route_stops bundle (~1.3 MB gzipped); subsequent
  // calls are O(1). Using Promise.all keeps the click → file gap under a
  // second on a warm cache and ~1-2 s on a cold one.
  const stopCounts = new Map();
  // Lazy-load tender + programme JSON in parallel with stop counts. Cached
  // by the browser after the first export so subsequent clicks are instant.
  const [_, tendersJson, programmeJson] = await Promise.all([
    Promise.all([...routes.keys()].map(async (id) => {
      try { stopCounts.set(id, await fetchRouteStopCount(id)); }
      catch { stopCounts.set(id, null); }
    })),
    fetch('./data/source/tenders.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/source/tender-programme.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  const visibleIds = new Set([...routes.keys()].map(s => String(s).toUpperCase()));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildRouteRows(routes, stopCounts)),                       'Routes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildGarageRows(pinnedRouteIds)),                          'Garages');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildOverviewRows(routes)),                                'Network overview');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildTenderRows(tendersJson, programmeJson, visibleIds)),  'Tenders');
  XLSX.writeFile(wb, `london-buses-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Helpers — keep formatting consistent across the sheet so a downstream
// pivot or sort behaves predictably.
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const num   = (v) => (Number.isFinite(v) ? v : '');
const str   = (v) => (v ?? '');

function buildRouteRows(routes, stopCounts) {
  return [...routes.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([id, props]) => {
      const dest = state.destinations[id]    ?? {};
      const cls  = state.classifications[id] ?? {};

      // Column ordering mirrors the route-card sections (identity → service →
      // fleet → reliability → last tender → next tender) so the spreadsheet
      // reads in the same order a user would scan the card.
      return {
        // ── Identity ──
        route_id:                  id,
        destination_outbound:      str(dest.outbound?.destination),
        destination_inbound:       str(dest.inbound?.destination),
        route_type:                str(props.routeType),
        is_prefix:                 yesNo(props.isPrefix),
        operator:                  str(props.operator),

        // ── Service ──
        frequency:                 str(props.frequency),
        length_band:               str(props.lengthBand),
        pvr:                       num(cls.pvr),
        stop_count:                num(stopCounts.get(id)),
        garage_code:               str(cls.garageCode),
        garage_name:               str(cls.garageName),

        // ── Fleet (live, observed via TfL arrivals + DVLA join) ──
        deck:                      str(props.deck),
        propulsion:                str(props.propulsion),
        vehicle_make:              str(cls.make),
        vehicle_model:             str(cls.vehicleType),
        avg_fleet_age_years:       num(cls.vehicleAgeYears),
        observed_fleet_size:       num(cls.fleetSize),

        // ── Reliability (TfL QSI PDF — actuals + per-route contractual MPS) ──
        service_class:             str(cls.serviceClass),
        ewt_minutes:               num(cls.ewtMinutes),
        ewt_mps_minutes:           num(cls.ewtMps),
        on_time_percent:           num(cls.onTimePercent),
        otp_mps_percent:           num(cls.otpMps),
        mileage_mps_percent:       num(cls.mileageMps),
        performance_period:        str(cls.perfPeriod),

        // ── Tender — current active contract (in-service) ──
        // Sourced from the *originating* tender award (the one that produced
        // the in-service contract). May differ from `last_*` below during a
        // re-tender transition window (~10% of routes at any time).
        contract_start_date:                str(cls.contractStartDate),
        contract_term_years:                num(cls.contractTermYears),
        current_contract_award_date:        str(cls.currentContractAwardDate),
        current_contract_awarded_operator:  str(cls.currentContractAwardedOperator),
        current_contract_cost_per_mile_gbp: num(cls.currentContractCostPerMile),
        current_contract_accepted_bid_gbp:  num(cls.currentContractAcceptedBid),
        current_contracted_annual_miles:    num(cls.currentContractedAnnualMiles),
        current_contract_bids_received:     num(cls.currentContractNumberOfTenderers),
        current_contract_was_joint_bid:     yesNo(cls.currentContractWasJointBid),
        current_contract_awarded_propulsion: str(cls.currentContractAwardedPropulsion),
        current_contract_awarded_deck:       str(cls.currentContractAwardedDeck),

        // ── Tender — latest award (may be the same as current, or the
        //     just-awarded next contract if we're in the transition window) ──
        last_award_date:           str(cls.lastAwardDate),
        last_awarded_operator:     str(cls.lastAwardedOperator),
        awards_on_record:          num(cls.tenderAwardCount),
        bids_received:             num(cls.numberOfTenderers),
        was_joint_bid:             yesNo(cls.wasJointBid),
        awarded_propulsion:        str(cls.awardedPropulsion),
        awarded_deck:              str(cls.awardedDeck),
        cost_per_mile_gbp:         num(cls.lastCostPerMile),
        accepted_bid_gbp:          num(cls.lastAcceptedBid),
        contracted_annual_miles:   num(cls.contractedAnnualMiles),

        // ── Tender — previous (changed-hands) operator ──
        previous_operator:                str(cls.previousOperator),
        previous_award_date:              str(cls.previousAwardDate),
        previous_contract_term_years:     num(cls.previousContractTermYears),
        previous_was_joint_bid:           yesNo(cls.previousWasJointBid),
        previous_cost_per_mile_gbp:       num(cls.previousCostPerMile),
        previous_accepted_bid_gbp:        num(cls.previousAcceptedBid),
        previous_contracted_annual_miles: num(cls.previousContractedAnnualMiles),
        previous_bids_received:           num(cls.previousNumberOfTenderers),
        previous_awarded_propulsion:      str(cls.prevAwardedPropulsion),
        previous_awarded_deck:            str(cls.prevAwardedDeck),

        // ── Tender — next (upcoming) contract ──
        tranche:                   str(cls.nextTenderTranche),
        contract_expires:          str(cls.nextTenderStart),
        next_programme_year:       str(cls.nextTenderYear),
        next_award_propulsion:     str(cls.nextAwardPropulsion),
        next_award_deck:           str(cls.nextAwardDeck),
        extension_eligible:        yesNo(cls.extensionEligible),
      };
    });
}

function buildGarageRows(pinnedRouteIds) {
  // Pre-index PVR by garage code so we can attach each garage's contracted
  // PVR (sum of every route assigned to it). PVR is per-route in the
  // classifications, not per-garage, so it has to be aggregated here.
  // When pinned routes are passed in, the PVR sum and route_count restrict
  // to just those routes, and the garage list filters to garages running
  // at least one pinned route.
  const pvrByGarage = {};
  const pinnedRoutesByGarage = {};
  for (const [routeId, cls] of Object.entries(state.classifications ?? {})) {
    const code = cls.garageCode;
    if (!code) continue;
    if (pinnedRouteIds && !pinnedRouteIds.has(String(routeId).toUpperCase())) continue;
    if (Number.isFinite(cls.pvr)) {
      pvrByGarage[code] = (pvrByGarage[code] ?? 0) + cls.pvr;
    }
    pinnedRoutesByGarage[code] = (pinnedRoutesByGarage[code] ?? 0) + 1;
  }

  return getVisibleGarages()
    .filter(g => !pinnedRouteIds || pinnedRoutesByGarage[g.code])
    .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''))
    .map(g => ({
      garage_code: g.code,
      garage_name: g.name,
      operator:    g.operator ?? '',
      address:     g.address  ?? '',
      latitude:    g.lat,
      longitude:   g.lon,
      route_count: pinnedRouteIds ? (pinnedRoutesByGarage[g.code] ?? 0) : (g.routeCount ?? 0),
      total_pvr:   pvrByGarage[g.code] ?? 0,
      // Operating-centre authorised-vehicle capacity (DVSA licence). Blank
      // when not on file.
      capacity:    Number.isFinite(g.capacity) ? g.capacity : '',
    }));
}

// Combined Tenders sheet — historical award rows + upcoming programme rows
// in one stream, keyed by route. The `kind` column ('historical' / 'programme')
// tells consumers which set a row belongs to; columns common to both (date,
// operator, vehicle spec) are reused, columns specific to one stay blank for
// the other. Sorted by route_id then by the row's primary date so a route's
// full timeline reads top-to-bottom for analysts.
//
// Filter: only routes currently passing the page filter contribute. A
// historical award keyed "341/N341" feeds rows for both 341 and N341 if
// either is visible.
function buildTenderRows(tendersJson, programmeJson, visibleIds) {
  const rows = [];

  // ── Historical awards ───────────────────────────────────────────────────
  for (const [, t] of Object.entries(tendersJson?.tenders ?? {})) {
    if (!t?.route_id) continue;
    // route_id may be combined ("341/N341"); emit one row per id IF the id
    // is in the visible set.
    const ids = String(t.route_id).split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
    const matchedIds = ids.filter(id => visibleIds.has(id));
    if (!matchedIds.length) continue;
    for (const id of matchedIds) {
      const wasJB = !!(t.joint_bids && t.joint_bids.trim().length > 5 && !/^N\/?A$/i.test(t.joint_bids.trim()));
      // Derived contracted annual miles: if both the accepted bid and the
      // cost-per-mile were published, divide them. TfL only publishes the
      // ratio (£/mile) explicitly; the absolute mileage is what people
      // actually plan around (vehicle utilisation, depot allocation).
      const milesPerYear = (Number.isFinite(t.accepted_bid) && Number.isFinite(t.cost_per_mile) && t.cost_per_mile > 0)
        ? Math.round(t.accepted_bid / t.cost_per_mile)
        : null;
      rows.push({
        route_id:               id,
        kind:                   'historical',
        date:                   str(t.award_announced_date),         // award announcement
        contract_start_date:    '',                                  // not in tender form
        operator:               str(t.awarded_operator),
        bids_received:          num(t.number_of_tenderers),
        accepted_bid_gbp:       num(t.accepted_bid),
        lowest_bid_gbp:         num(t.lowest_bid),
        highest_bid_gbp:        num(t.highest_bid),
        cost_per_mile_gbp:      num(t.cost_per_mile),
        contracted_annual_miles: num(milesPerYear),
        was_joint_bid:          yesNo(wasJB),
        joint_bid_partners:     str(wasJB ? t.joint_bids : ''),
        reason_not_lowest:      str(t.reason_not_lowest),
        notes:                  str(t.notes),
        // Programme-only fields — blank for historical
        programme_year:         '',
        tranche:                '',
        tender_issue_date:      '',
        tender_return_date:     '',
        award_estimated:        '',
        vehicle_specification:  '',
        two_year_extension:     '',
        route_description:      '',
      });
    }
  }

  // ── Upcoming programme entries ──────────────────────────────────────────
  for (const yr of (programmeJson?.years ?? [])) {
    for (const e of (yr.entries ?? [])) {
      if (!e?.route_id) continue;
      const ids = String(e.route_id).split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
      const matchedIds = ids.filter(id => visibleIds.has(id));
      if (!matchedIds.length) continue;
      for (const id of matchedIds) {
        rows.push({
          route_id:               id,
          kind:                   'programme',
          // For programme rows the row's primary "date" column is the
          // contract start (when the contract begins service); the explicit
          // contract_start_date column carries the same value so the column
          // semantics are unambiguous when sorting/filtering.
          date:                   str(e.contract_start_date),
          contract_start_date:    str(e.contract_start_date),
          operator:               '',                                // not yet awarded
          bids_received:          '',
          accepted_bid_gbp:       '',
          lowest_bid_gbp:         '',
          highest_bid_gbp:        '',
          cost_per_mile_gbp:      '',
          contracted_annual_miles: '',
          was_joint_bid:          '',
          joint_bid_partners:     '',
          reason_not_lowest:      '',
          notes:                  '',
          // Programme-specific fields
          programme_year:         str(e.programme_year),
          tranche:                str(e.tranche),
          tender_issue_date:      str(e.tender_issue_date),
          tender_return_date:     str(e.tender_return_date),
          award_estimated:        str(e.award_estimated),
          vehicle_specification:  str(e.vehicle_type),
          two_year_extension:     yesNo(!!e.two_year_extension),
          route_description:      str(e.route_description),
        });
      }
    }
  }

  // Sort by route_id (numeric-aware) then by date so a single route's full
  // timeline reads chronologically.
  rows.sort((a, b) => {
    const r = String(a.route_id).localeCompare(String(b.route_id), undefined, { numeric: true });
    if (r !== 0) return r;
    return String(a.date ?? '').localeCompare(String(b.date ?? ''));
  });
  return rows;
}

function buildOverviewRows(routes) {
  const list = [...routes.entries()].map(([id, props]) => ({
    ...props,
    pvr:             state.classifications[id]?.pvr ?? null,
    vehicleAgeYears: state.classifications[id]?.vehicleAgeYears ?? null,
  }));
  const totalRoutes = list.length;
  const totalPvr    = list.reduce((s, r) => s + (r.pvr ?? 0), 0);

  const ops = {};
  for (const r of list) {
    const op = r.operator ?? 'Unknown';
    const pvr = Number.isFinite(r.pvr) ? r.pvr : 0;
    (ops[op] ??= { routes: 0, pvr: 0, ev: 0, ageSum: 0, agePvr: 0 }).routes++;
    ops[op].pvr += pvr;
    if (r.propulsion === 'electric') ops[op].ev++;
    if (Number.isFinite(r.vehicleAgeYears) && pvr > 0) {
      ops[op].ageSum += r.vehicleAgeYears * pvr;
      ops[op].agePvr += pvr;
    }
  }
  const pct = (n, d) => d ? Math.round(n / d * 100) + '%' : '–';
  const avgAgeFmt = (sum, w) => w ? +(sum / w).toFixed(1) : '–';
  let netAgeSum = 0, netAgePvr = 0;
  for (const v of Object.values(ops)) { netAgeSum += v.ageSum; netAgePvr += v.agePvr; }
  const rows = Object.entries(ops)
    .sort(([aK, aV], [bK, bV]) => aK === 'Unknown' ? 1 : bK === 'Unknown' ? -1 : bV.routes - aV.routes)
    .map(([op, v]) => ({
      operator:        op,
      routes:          v.routes,
      route_share:     pct(v.routes, totalRoutes),
      pvr_total:       v.pvr,
      pvr_share:       pct(v.pvr, totalPvr),
      electric_routes: v.ev,
      electric_share:  pct(v.ev, v.routes),
      avg_fleet_age_y: avgAgeFmt(v.ageSum, v.agePvr),
    }));
  const totalEv = list.filter(r => r.propulsion === 'electric').length;
  rows.push({
    operator:        'TOTAL',
    routes:          totalRoutes,
    route_share:     '100%',
    pvr_total:       totalPvr,
    pvr_share:       '100%',
    electric_routes: totalEv,
    electric_share:  pct(totalEv, totalRoutes),
    avg_fleet_age_y: avgAgeFmt(netAgeSum, netAgePvr),
  });

  // Fleet mix block — mirrors the right-panel Fleet Mix chart. PVR-weighted
  // so a 42-bus diesel route outweighs a 6-bus electric school route, which
  // is how operations teams think about the fleet. Blank rows above act as a
  // visual separator in the spreadsheet; the "FLEET MIX" label sits in the
  // operator column so it reads naturally at the top of the block.
  const buckets = { electric: 0, hybrid: 0, hydrogen: 0, diesel: 0, unknown: 0 };
  const routeBuckets = { electric: 0, hybrid: 0, hydrogen: 0, diesel: 0, unknown: 0 };
  for (const r of list) {
    const key = buckets[r.propulsion] !== undefined ? r.propulsion : 'unknown';
    buckets[key]      += r.pvr ?? 0;
    routeBuckets[key] += 1;
  }
  const labelOf = { electric: 'Electric', hybrid: 'Hybrid', hydrogen: 'Hydrogen', diesel: 'Diesel', unknown: 'Unknown' };

  rows.push({ operator: '' }, { operator: 'FLEET MIX (by PVR)' });
  for (const key of ['electric', 'hybrid', 'hydrogen', 'diesel', 'unknown']) {
    const pvr = buckets[key];
    if (!pvr && !routeBuckets[key]) continue; // skip empty buckets
    rows.push({
      operator:        labelOf[key],
      routes:          routeBuckets[key],
      route_share:     pct(routeBuckets[key], totalRoutes),
      pvr_total:       pvr,
      pvr_share:       pct(pvr, totalPvr),
      electric_routes: '',
      electric_share:  '',
    });
  }
  return rows;
}
