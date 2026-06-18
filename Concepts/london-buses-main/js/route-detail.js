/**
 * route-detail.js — Render one or many route cards into the Routes tab.
 *
 * Clones `#tpl-route-card` per entry and populates the per-route record from
 * `route_classifications.json`. Fields displayed from the historical pipeline:
 *   - operator, PVR, deck, propulsion (LBR + DVLA)
 *   - make + vehicle (DVLA + LBR)
 *   - avg fleet age + fleet size (DVLA cross-referenced with TfL arrivals)
 *   - reliability — EWT for high-freq, OTP for low-freq (TfL QSI PDF)
 *   - previous operator, contract expires, contract value (TfL tender data,
 *     joined from data/source/tenders.json + tender-programme.json)
 */

import { routeResults, routePrompt, routeNoResult, routeCardTpl } from './state.js';
import { opColor } from './map.js';

// Frequency label — the underlying classification is binary high/low, but
// in the narrow Freq KPI tile we render just the initial (H / L) so the
// value visually matches the compact treatment of EWT / OTP / PVR / Stops.
// The full word is still used in filter pills and tooltips elsewhere.
const FREQ_MAP  = { high: 'H', low: 'L' };
// Deck rendered as the standard industry abbreviations — saves horizontal
// space on the small Fleet rows and the composite "Awarded vehicle" cell
// (e.g. "Electric (DD)" instead of "Electric (double)").
const DECK_MAP  = { double: 'DD', single: 'SD' };
const PROP_MAP  = { electric: 'Electric', hydrogen: 'Hydrogen', hybrid: 'Hybrid', diesel: 'Diesel' };

// Tooltip text per field — short, professional "what + source" lines.
// Keyed by the value element's data-rc-* attribute (without the prefix).
// The dynamic perf / MPS tiles flip their tip text alongside their label
// (EWT vs OTP) and are wired separately in buildCard's reliability block.
// Tooltip text. Format: "[short description.] Source: X. Freshness: Y." The
// description is dropped when the label itself is self-explanatory.
const tip = (desc, source, freshness) =>
  (desc ? desc + '. ' : '') + 'Source: ' + source + '. Freshness: ' + freshness + '.';
const SOURCE = {
  TFL_API:   'TfL Open Data API',
  TFL_IBUS:  'TfL iBus open data',
  DVLA:      'DVLA Vehicle Enquiry Service',
  LBR:       'londonbusroutes.net',
  QSI:       'TfL Bus Performance (QSI) report',
  QSI_ROUTE: 'TfL per-route QSI reports',
  TENDER:    'TfL tender records',
  PROG:      'TfL tendering programme',
  LOOKUP:    'curated vehicle lookup over LBR chassis strings',
  DERIVED:   'derived (accepted bid ÷ cost per mile)',
};
const WEEKLY      = 'as at last weekly refresh';
const WEEKLY_DVLA = 'per-vehicle 90-day cache, refreshed weekly';
const QSI_FRESH   = 'TfL publishes every ~4 weeks';
const PER_TENDER  = 'set per tender contract';
const TIPS = {
  // Route KPI tiles
  pvr:             tip('Peak Vehicle Requirement — buses needed at peak',     SOURCE.LBR,     WEEKLY),
  stops:           tip('',                                                    SOURCE.TFL_API, WEEKLY),
  freq:            tip('H = 5+ buses/hour, L = fewer',                        SOURCE.TFL_API, WEEKLY),
  // Route detail rows
  garage:          tip('Operating garage',                                    SOURCE.LBR,     WEEKLY),
  // Fleet rows
  deck:            tip('',                                                    SOURCE.LOOKUP,  WEEKLY),
  propulsion:      tip('LBR chassis codes cross-checked with DVLA',           SOURCE.LBR + ' + ' + SOURCE.DVLA, WEEKLY),
  'vehicle-make':  tip('Manufacturer',                                        SOURCE.DVLA,    WEEKLY_DVLA),
  'vehicle-model': tip('Chassis and body',                                    SOURCE.LBR,     WEEKLY),
  age:             tip('Mean age of buses observed on the route',             SOURCE.DVLA,    WEEKLY_DVLA),
  // Tender · Current active contract
  'current-op':    tip('Operator who won the originating tender',             SOURCE.TENDER,  WEEKLY),
  'current-award': tip('Award date of the current in-service contract',      SOURCE.TENDER,  WEEKLY),
  'contract-start':tip('Date the current contract began service',             SOURCE.LBR,     WEEKLY),
  term:            tip('TQ N spec with reduction / extension notes',          SOURCE.LBR,     WEEKLY),
  'current-cpm':   tip('Cost per live mile of the current contract',          SOURCE.TENDER,  WEEKLY),
  'current-miles': tip('Annual contracted live miles',                        SOURCE.DERIVED, WEEKLY),
  'current-veh':   tip('Vehicle specification required by the current contract', SOURCE.TENDER, WEEKLY),
  'current-joint': tip('Whether tendered as part of a joint bid',             SOURCE.TENDER,  WEEKLY),
  'current-bids':  tip('Number of operators that bid',                        SOURCE.TENDER,  WEEKLY),
  // Tender · Next contract — awarded
  'last-award':    tip('Award date of the latest tender',                     SOURCE.TENDER,  WEEKLY),
  'next-start':    tip('Date the next contract begins service',               SOURCE.PROG,    WEEKLY),
  tranche:         tip('Programme batch this route’s upcoming tender sits in', SOURCE.PROG,   WEEKLY),
  value:           tip('Cost per live mile of the latest tender',             SOURCE.TENDER,  WEEKLY),
  'annual-miles':  tip('Annual contracted live miles of the latest tender',   SOURCE.DERIVED, WEEKLY),
  'awarded-veh':   tip('Vehicle specification required by the next contract', SOURCE.TENDER,  WEEKLY),
  joint:           tip('Whether the latest tender was a joint bid',           SOURCE.TENDER,  WEEKLY),
  bids:            tip('Number of operators that bid',                        SOURCE.TENDER,  WEEKLY),
  // Tender · Previous operator
  previous:        tip('Operator before the current incumbent',               SOURCE.TENDER,  WEEKLY),
  'prev-award':    tip('Award date of the previous contract',                 SOURCE.TENDER,  WEEKLY),
  'prev-term':     tip('Length of the previous contract (gap to next award)', SOURCE.TENDER,  WEEKLY),
  'prev-cpm':      tip('Cost per live mile of the previous contract',         SOURCE.TENDER,  WEEKLY),
  'prev-miles':    tip('Annual contracted live miles of the previous contract', SOURCE.DERIVED, WEEKLY),
  'prev-veh':      tip('Vehicle specification required by the previous contract', SOURCE.TENDER, WEEKLY),
  'prev-joint':    tip('Whether the previous contract was a joint bid',       SOURCE.TENDER,  WEEKLY),
  'prev-bids':     tip('Number of operators that bid for the previous contract', SOURCE.TENDER, WEEKLY),
};

// Walk the TIPS map and attach `data-tip` attributes to each row's label.
// `js/tooltip.js` is the listener that turns these into a custom-styled
// hover popup; using `data-tip` (not the native `title`) lets us control
// timing and look. Pseudo-element ⓘ glyph (CSS) advertises availability.
function attachTooltips(card) {
  for (const [key, tip] of Object.entries(TIPS)) {
    const valueEl = card.querySelector(`[data-rc-${key}]`);
    if (!valueEl) continue;
    const labelEl = valueEl.parentElement?.querySelector('.rc-tr-l, .rc-kpi-l');
    if (labelEl) labelEl.dataset.tip = tip;
  }
}

// Chip text per route type. Regular routes are the silent default — every
// other classification (night, 24-hour, school, letter-prefix) gets a chip
// so the user can read the route's category at a glance regardless of how
// "obvious" the prefix or numbering already makes it.
const TYPE_CHIP = {
  night:      'Night',
  twentyfour: '24h',
  school:     'School',
  prefix:     'Prefix',
};

// OPERATOR_COLORS / opColor live in map.js (single source of truth — see
// import above). Local copy removed so palettes can never diverge. The
// previous local table here was missing 'RATP Dev' and 'Uno Buses' so those
// labels rendered as grey while showing correctly elsewhere.

// Short labels for the route-card operator pill (Stagecoach London → Stagecoach).
const OPERATOR_SHORT = {
  'Arriva London':           'Arriva',
  'First London':            'First',
  'Go-Ahead London':         'Go-Ahead',
  'Stagecoach London':       'Stagecoach',
  'Uno Buses':               'Uno',
  'RATP Dev':                'RATP',
  // Belt-and-braces — these are normalised at build time in
  // `tenderOpParent`, but keep them here so any future flow that lands a raw
  // tender-form name in the UI still renders consistently.
  'Transport UK London':     'Transport UK',
  'Transport UK West London':'Transport UK',
};

// Tender-history operator → parent group rollup. The TfL tender form
// carries decades of subsidiary brands and historical names that have
// since been acquired or merged into a handful of UK groups. Surfacing
// the parent group rather than the legacy brand makes "Previous operator"
// directly comparable to the current incumbent shown elsewhere on the card.
//
// Three lookup tiers, in order:
//   1. TENDER_OP_GROUP — exact match for legacy brands now under a parent
//      (Selkent → Stagecoach, Metrobus → Go-Ahead, London United → RATP, …).
//   2. TENDER_OP_PREFIXES — prefix match for subsidiary names
//      (Arriva London North → Arriva, First London East → First, …).
//   3. OPERATOR_SHORT — current-incumbent display aliases (above).
//
// Brands that never were part of a group, or are themselves the group
// label, fall through unchanged (Tower Transit, CT Plus, HCT Group,
// Sullivan Buses, NCP, TGM, Uno).
const TENDER_OP_GROUP = {
  // Go-Ahead family
  'London General':       'Go-Ahead',
  'London Central':       'Go-Ahead',
  'Blue Triangle':        'Go-Ahead',
  'Docklands Buses':      'Go-Ahead',
  'Metrobus':             'Go-Ahead',
  'East Thames Buses':    'Go-Ahead',
  'East Thames':          'Go-Ahead',
  // Stagecoach family
  'Selkent':              'Stagecoach',
  'East London':          'Stagecoach',
  // RATP family
  'London United':        'RATP',
  'London Sovereign':     'RATP',
  'Sovereign':            'RATP',
  'Quality Line':         'RATP',
  'NSL':                  'RATP',
  // First family (CentreWest was acquired by First in 1997)
  'CentreWest':           'First',
  // Abellio family (Travel London was rebranded to Abellio)
  'Travel London':        'Abellio',
  // Naming canonicalisation
  'National Car Parks':   'NCP',
};
// Order matters: longest prefix first so "Arriva London North" matches
// before the bare "Arriva ".
const TENDER_OP_PREFIXES = [
  ['Arriva ',          'Arriva'],
  ['Abellio ',         'Abellio'],
  ['Stagecoach ',      'Stagecoach'],
  ['First ',           'First'],
  ['Metroline ',       'Metroline'],
  ['Go-Ahead ',        'Go-Ahead'],
];
function normaliseTenderOperator(name) {
  if (!name) return name;
  if (TENDER_OP_GROUP[name]) return TENDER_OP_GROUP[name];
  for (const [prefix, brand] of TENDER_OP_PREFIXES) {
    if (name.startsWith(prefix)) return brand;
  }
  return OPERATOR_SHORT[name] ?? name;
}

/**
 * Render N route cards. Each entry: { id, classification, destinations }.
 * Empty list → shows the "no result" state.
 *
 * When `entries.length === 1`, the card also exposes a direction-toggle
 * button (outbound ⇄ inbound). Multi-route mode keeps the toggle hidden —
 * there's no single route to flip.
 */
export function renderRouteCards(entries, { direction = '1' } = {}) {
  if (!routeResults || !routeCardTpl) return;
  clearCards();
  if (!entries.length) { showNoResult(); return; }

  routeResults.hidden = false;
  if (routeNoResult) routeNoResult.hidden = true;
  if (routePrompt)   routePrompt.style.display = 'none';

  const single = entries.length === 1;
  for (const entry of entries) routeResults.appendChild(buildCard(entry, { single, direction }));
}

export function showNoResult() {
  clearCards();
  if (!routeResults) return;
  routeResults.hidden = false;
  if (routeNoResult) routeNoResult.hidden = false;
  if (routePrompt)   routePrompt.style.display = 'none';
}

export function showRoutePrompt() {
  clearCards();
  if (routePrompt)   routePrompt.style.display = '';
  if (routeResults)  routeResults.hidden = true;
  if (routeNoResult) routeNoResult.hidden = true;
}

// ── internals ────────────────────────────────────────────────────────────────

function clearCards() {
  if (!routeResults) return;
  [...routeResults.querySelectorAll('.route-card')].forEach(el => el.remove());
}

// Acquisition links between brands — pairs of names that are the same
// operating entity under modern ownership. Used to align the awarded-
// operator display with the current incumbent on routes where a contract
// transferred via acquisition rather than re-tender:
//   • Tower Transit's Lea Interchange (East London) routes → Stagecoach (2024)
//   • RATP Dev London → First Bus London (Feb 2025, ~83 routes)
// `previousOperator` is untouched — those records reflect genuine prior
// awards (re-tenders), which remain historically accurate.
const OPERATOR_ACQUISITION_PAIRS = [
  ['First',      'RATP'],
  ['Stagecoach', 'Tower Transit'],
];
function sameOperator(a, b) {
  if (a === b) return true;
  for (const [x, y] of OPERATOR_ACQUISITION_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

function buildCard({ id, classification, destinations, stopCount }, { single = false, direction = '1' } = {}) {
  const node = routeCardTpl.content.firstElementChild.cloneNode(true);
  const set  = (sel, text) => { const el = node.querySelector(sel); if (el) el.textContent = text; };

  const outbound = destinations?.outbound?.destination;
  const inbound  = destinations?.inbound?.destination;

  set('[data-rc-num]', id);

  // Route name shows the direction-specific "origin → destination" pair.
  // For single-route with both directions, the swap button flips this text
  // between the two orientations without re-fetching.
  const dirBtn = node.querySelector('[data-rc-dir]');
  const hasBoth = !!(outbound && inbound);
  if (single && hasBoth) {
    const isOutbound = direction !== '2';
    const origin = isOutbound ? inbound  : outbound;
    const dest   = isOutbound ? outbound : inbound;
    set('[data-rc-name]', `${origin} → ${dest}`);
    if (dirBtn) dirBtn.hidden = false;
  } else {
    // Multi-route or single-direction — static display, no toggle.
    const nameBits = [outbound, inbound].filter(Boolean);
    set('[data-rc-name]', nameBits.length ? nameBits.join(' → ') : '—');
    if (dirBtn) dirBtn.hidden = true;
  }

  const op   = classification?.operator ?? 'Unknown';
  const opEl = node.querySelector('[data-rc-op]');
  if (opEl) {
    opEl.textContent = OPERATOR_SHORT[op] ?? op;
    opEl.style.background = opColor(op);
  }

  // Type chip — only for 24-hour and school. Regular / night / prefix are
  // already self-evident from the route number itself.
  const typeKey  = classification?.isPrefix ? 'prefix' : (classification?.type ?? '');
  const chipText = TYPE_CHIP[typeKey];
  const chipEl   = node.querySelector('[data-rc-type]');
  if (chipEl) {
    if (chipText) { chipEl.textContent = chipText; chipEl.hidden = false; }
    else          { chipEl.textContent = '';      chipEl.hidden = true;  }
  }
  set('[data-rc-pvr]',        classification?.pvr ?? 'XXX');
  set('[data-rc-stops]',      Number.isFinite(stopCount) ? stopCount.toLocaleString() : '—');
  set('[data-rc-freq]',       FREQ_MAP[classification?.frequency]  ?? 'XXX');
  set('[data-rc-deck]',       DECK_MAP[classification?.deck]       ?? 'XXX');
  set('[data-rc-propulsion]', PROP_MAP[classification?.propulsion] ?? 'XXX');

  const gn = classification?.garageName;
  const gc = classification?.garageCode;
  set('[data-rc-garage]', gn && gc ? `${gn} (${gc})` : (gn ?? gc ?? 'XXX'));

  // Vehicle make — DVLA returns the manufacturer in upper-case ("VOLVO").
  // Title-case it so it reads naturally ("Volvo").
  const make = classification?.make;
  set('[data-rc-vehicle-make]', make ? toTitleCase(make) : 'XXX');

  // Vehicle model — chassis+body string from LBR ("B5LH/Gemini 3", "Enviro400 MMC").
  // The underlying field is still called `vehicleType` for compatibility with
  // the Supabase schema; the UI calls it "Vehicle model".
  set('[data-rc-vehicle-model]', classification?.vehicleType ?? 'XXX');

  // Avg fleet age in years — mean of (today − monthOfFirstRegistration) across
  // observed regs. One decimal, matches DVLA's resolution.
  const age = classification?.vehicleAgeYears;
  set('[data-rc-age]', Number.isFinite(age) ? `${age.toFixed(1)} years` : 'XXX');

  // Reliability KPIs — paired tiles in the Route section. The first tile
  // shows the actual measurement (EWT for high-freq, OTP for low-freq);
  // the second shows the contractual minimum performance standard for the
  // same metric. Splitting them keeps each tile readable on a narrow card
  // while still letting the eye compare actual vs standard side-by-side.
  // Both labels swap together so the user always knows which metric is
  // being shown (EWT/EWT-MPS vs OTP/OTP-MPS).
  const perfL    = node.querySelector('[data-rc-perf-l]');
  const perfMpsL = node.querySelector('[data-rc-perf-mps-l]');
  const sc       = classification?.serviceClass;
  const ewt      = classification?.ewtMinutes;
  const otp      = classification?.onTimePercent;
  const ewtMps   = classification?.ewtMps;
  const otpMps   = classification?.otpMps;
  // Tile 1 = actual measurement (EWT / OTP). Tile 2 = the contractual
  // Minimum Performance Standard for the same metric. Labels and tooltips
  // both swap together so the metric is unambiguous regardless of class.
  const TIP_EWT     = tip('Excess Wait Time in minutes',  SOURCE.QSI_ROUTE, QSI_FRESH);
  const TIP_OTP     = tip('On-Time Performance',          SOURCE.QSI_ROUTE, QSI_FRESH);
  const TIP_EWT_MPS = tip('Contractual EWT minimum',      SOURCE.TENDER,    PER_TENDER);
  const TIP_OTP_MPS = tip('Contractual OTP minimum',      SOURCE.TENDER,    PER_TENDER);
  if (sc === 'high-frequency') {
    if (perfL)    { perfL.textContent    = 'EWT'; perfL.dataset.tip    = TIP_EWT; }
    if (perfMpsL) { perfMpsL.textContent = 'MPS'; perfMpsL.dataset.tip = TIP_EWT_MPS; }
    set('[data-rc-perf]',     Number.isFinite(ewt)    ? ewt.toFixed(1)    : '—');
    set('[data-rc-perf-mps]', Number.isFinite(ewtMps) && ewtMps > 0 ? ewtMps.toFixed(1) : '—');
  } else if (sc === 'low-frequency') {
    if (perfL)    { perfL.textContent    = 'OTP'; perfL.dataset.tip    = TIP_OTP; }
    if (perfMpsL) { perfMpsL.textContent = 'MPS'; perfMpsL.dataset.tip = TIP_OTP_MPS; }
    set('[data-rc-perf]',     Number.isFinite(otp)    ? `${otp.toFixed(0)}%` : '—');
    set('[data-rc-perf-mps]', Number.isFinite(otpMps) && otpMps > 0 ? `${otpMps.toFixed(0)}%` : '—');
  } else {
    if (perfL)    { perfL.textContent    = 'EWT'; perfL.dataset.tip    = TIP_EWT; }
    if (perfMpsL) { perfMpsL.textContent = 'MPS'; perfMpsL.dataset.tip = TIP_EWT_MPS; }
    set('[data-rc-perf]',     '—');
    set('[data-rc-perf-mps]', '—');
  }

  // Awarded on — when the most recent tender on this route was decided.
  const lastAwd = classification?.lastAwardDate;
  set('[data-rc-last-award]', lastAwd ? formatHumanDate(lastAwd) : 'XXX');

  // Length (contract term) — note-derived (rare, authoritative) or
  // date-derived (broader coverage, ±1y precision). Declared up here
  // because it's reused below to infer the Next-contract Starts-on date
  // when TfL's programme PDF doesn't yet list the route.
  const term      = classification?.contractTermYears;
  const termValid = Number.isFinite(term) && term > 0;
  toggleRow(node, 'term', termValid);
  if (termValid) set('[data-rc-term]', `${term} years`);

  // Tranche — the LBSL programme batch number this route's upcoming tender
  // sits in (e.g. 913). Sourced from TfL's tender programme PDFs; null for
  // routes with no entry in any published programme year, so the row hides
  // rather than showing a placeholder.
  const tranche = classification?.nextTenderTranche;
  const trancheValid = tranche != null && String(tranche).trim() !== '';
  toggleRow(node, 'tranche', trancheValid);
  if (trancheValid) set('[data-rc-tranche]', String(tranche));

  // Bids received — competitiveness of the most recent tender.
  const bids = classification?.numberOfTenderers;
  toggleRow(node, 'bids', Number.isFinite(bids) && bids > 0);
  if (Number.isFinite(bids) && bids > 0) set('[data-rc-bids]', `${bids}${bids === 1 ? ' bid' : ' bids'}`);

  // Joint bid — always rendered Yes/No so the user can see at a glance.
  // The TfL `joint_bids` field is populated for ~52% of awards; we collapse
  // its (sometimes paragraph-long) bundled-routes list to a plain Yes.
  const wasJB = classification?.wasJointBid === true;
  set('[data-rc-joint]', wasJB ? 'Yes' : 'No');

  // Contract start date — when the current contract actually began service.
  // Joined from the LBSL tender programme PDFs (~277 routes covered;
  // routes whose current contract started pre-2017 are blank). Hidden
  // when missing rather than rendered as "—".
  const start = classification?.contractStartDate;
  toggleRow(node, 'contract-start', !!start);
  if (start) set('[data-rc-contract-start]', formatHumanDate(start));

  // ── Current active contract block ──────────────────────────────────────────
  // Populated from the *originating* tender award (the one that produced the
  // in-service contract) — distinct from the latest tender, which describes
  // whatever's most recently been awarded. For most routes the two coincide;
  // for ~10% in the transition window they don't (a re-tender has been
  // awarded but the previous contract is still running). Each row hides when
  // its value isn't on file rather than rendering "—".

  // Operator who won the originating tender. Usually equals the incumbent at
  // the top of the card; differs only for novated contracts (rare) and for
  // acquisitions — where an operator absorbed the contract along with its
  // depot (Stagecoach took over Tower Transit's Lea Interchange operations
  // in 2024; FirstGroup acquired RATP Dev London in Feb 2025). The tender
  // record correctly carries the original awardee, but the display should
  // align with the current incumbent so the user doesn't read two operators
  // for one contract. `sameOperator` (defined below) encodes those parent
  // links.
  const currentOpDisplay = OPERATOR_SHORT[op] ?? op;
  const cAwardedOp        = classification?.currentContractAwardedOperator;
  const cAwardedShort     = cAwardedOp ? (OPERATOR_SHORT[cAwardedOp] ?? cAwardedOp) : null;
  const cAwardedOpDisplay = cAwardedShort && sameOperator(currentOpDisplay, cAwardedShort)
    ? currentOpDisplay
    : cAwardedShort;
  toggleRow(node, 'current-op', !!cAwardedOpDisplay);
  if (cAwardedOpDisplay) set('[data-rc-current-op]', cAwardedOpDisplay);

  const cAward = classification?.currentContractAwardDate;
  toggleRow(node, 'current-award', !!cAward);
  if (cAward) set('[data-rc-current-award]', formatHumanDate(cAward));

  const cCpm = classification?.currentContractCostPerMile;
  toggleRow(node, 'current-cpm', Number.isFinite(cCpm));
  if (Number.isFinite(cCpm)) set('[data-rc-current-cpm]', `£${cCpm.toFixed(2)}`);

  const cMiles = classification?.currentContractedAnnualMiles;
  toggleRow(node, 'current-miles', Number.isFinite(cMiles) && cMiles > 0);
  if (Number.isFinite(cMiles) && cMiles > 0) set('[data-rc-current-miles]', cMiles.toLocaleString());

  const cVeh = formatAwardedVehicle(classification?.currentContractAwardedPropulsion, classification?.currentContractAwardedDeck);
  const cVehValid = cVeh && cVeh !== 'XXX';
  toggleRow(node, 'current-veh', !!cVehValid);
  if (cVehValid) set('[data-rc-current-veh]', cVeh);

  const cJoint = classification?.currentContractWasJointBid;
  toggleRow(node, 'current-joint', cJoint != null);
  if (cJoint != null) set('[data-rc-current-joint]', cJoint ? 'Yes' : 'No');

  const cBids = classification?.currentContractNumberOfTenderers;
  toggleRow(node, 'current-bids', Number.isFinite(cBids) && cBids > 0);
  if (Number.isFinite(cBids) && cBids > 0) set('[data-rc-current-bids]', `${cBids}${cBids === 1 ? ' bid' : ' bids'}`);

  // ── "Next contract — awarded" section toggle ───────────────────────────────
  // Show only when a re-tender has been awarded for a not-yet-started contract
  // (i.e., the latest tender post-dates the originating one). Steady-state
  // routes hide this section entirely so the card doesn't show two boxes
  // describing the same contract.
  const lastAwdIso = classification?.lastAwardDate ?? null;
  const showNext   = lastAwdIso && cAward && lastAwdIso !== cAward;
  const nextSec    = node.querySelector('[data-rc-section="next-contract"]');
  if (nextSec) nextSec.hidden = !showNext;

  // Awarded operator on the next contract. Flag inline when it doesn't match
  // the incumbent at the top of the card — otherwise a user reading the
  // section would assume the new contract is going to the same operator.
  // `sameOperator` is hoisted above to also normalise the current-contract
  // awarded-operator display.
  const nextOp = classification?.lastAwardedOperator;
  const nextOpShort = nextOp ? (OPERATOR_SHORT[nextOp] ?? nextOp) : null;
  const nextOpDisplay = nextOpShort && sameOperator(currentOpDisplay, nextOpShort)
    ? currentOpDisplay
    : nextOpShort;
  set('[data-rc-next-op]', nextOpDisplay ?? '—');
  const opChangeEl = node.querySelector('[data-rc-op-change]');
  if (opChangeEl) opChangeEl.hidden = !(showNext && nextOpDisplay && !sameOperator(nextOpDisplay, currentOpDisplay));

  // Contract start of the just-awarded contract.
  const nextStartIso = classification?.nextTenderStart;
  toggleRow(node, 'next-start', !!(showNext && nextStartIso));
  if (showNext && nextStartIso) set('[data-rc-next-start]', formatHumanDate(nextStartIso));

  // Previous operator — derived from tender history (most recent earlier
  // award whose operator differs from the current incumbent). Subsidiary
  // names ("Arriva London North", "First London East", …) fold into the
  // parent brand for readability. Three distinct UI states:
  //   • Real predecessor       → "Arriva", "Tower Transit", …
  //   • count >= 2 + null      → "(no change)" — same operator re-awarded
  //   • count <= 1             → "(first award)" or "—" (no history at all)
  const prevOp     = classification?.previousOperator;
  const awardCount = classification?.tenderAwardCount ?? 0;
  const prevEl     = node.querySelector('[data-rc-previous]');
  if (prevOp) {
    if (prevEl) {
      prevEl.classList.remove('rc-tr-v--muted');
      prevEl.textContent = normaliseTenderOperator(prevOp);
    }
  } else if (awardCount >= 2) {
    if (prevEl) {
      prevEl.classList.add('rc-tr-v--muted');
      prevEl.textContent = 'no change';
    }
  } else if (awardCount === 1) {
    if (prevEl) {
      prevEl.classList.add('rc-tr-v--muted');
      prevEl.textContent = 'first award';
    }
  } else {
    if (prevEl) {
      prevEl.classList.remove('rc-tr-v--muted');
      prevEl.textContent = 'XXX';
    }
  }

  // Previous operator — Awarded on / Length, mirroring the current-contract
  // block. Both rows hide when the previous-operator row resolves to "no
  // change" or "first award" (no genuine predecessor → no separate contract
  // to date or measure).
  const prevAwardDate = classification?.previousAwardDate;
  toggleRow(node, 'prev-award', !!prevOp && !!prevAwardDate);
  if (prevOp && prevAwardDate) set('[data-rc-prev-award]', formatHumanDate(prevAwardDate));

  const prevTerm = classification?.previousContractTermYears;
  const prevTermValid = !!prevOp && Number.isFinite(prevTerm) && prevTerm > 0;
  toggleRow(node, 'prev-term', prevTermValid);
  if (prevTermValid) set('[data-rc-prev-term]', `${prevTerm} years`);

  // Cost per mile — most recent tender's £/mile (normalised so comparisons
  // across routes of different lengths actually mean something). Two decimals
  // matches TfL's published precision.
  const cpm = classification?.lastCostPerMile;
  set('[data-rc-value]', Number.isFinite(cpm) ? `£${cpm.toFixed(2)}` : 'XXX');

  // Contracted annual miles — bid ÷ £/mile, computed at build time. Shown
  // as the full figure with thousands separators (e.g. 1,258,932). Hidden
  // when the derivation isn't possible (no recent tender, or one of the two
  // inputs missing).
  const annualMiles = classification?.contractedAnnualMiles;
  const milesValid  = Number.isFinite(annualMiles) && annualMiles > 0;
  toggleRow(node, 'annual-miles', milesValid);
  if (milesValid) set('[data-rc-annual-miles]', annualMiles.toLocaleString());

  // Awarded vehicle — what TfL specified the most recent contract should
  // run. Worth comparing against the live `propulsion` / `deck` above; a
  // route mid-conversion will show awarded=electric vs actual=hybrid.
  set('[data-rc-awarded-veh]', formatAwardedVehicle(classification?.awardedPropulsion, classification?.awardedDeck));

  // Previous-operator contract detail — mirrors the current-contract block
  // (joint bid / cost per mile / contracted miles / awarded vehicle / bids
  // received) for the changed-hands award, so the section reads like a
  // like-for-like comparison. Every row hides when its value is absent or
  // when there's no genuine predecessor.
  const prevJoint = classification?.previousWasJointBid;
  toggleRow(node, 'prev-joint', !!prevOp && prevJoint != null);
  if (prevOp && prevJoint != null) set('[data-rc-prev-joint]', prevJoint ? 'Yes' : 'No');

  const prevCpm = classification?.previousCostPerMile;
  const prevCpmValid = !!prevOp && Number.isFinite(prevCpm) && prevCpm > 0;
  toggleRow(node, 'prev-cpm', prevCpmValid);
  if (prevCpmValid) set('[data-rc-prev-cpm]', `£${prevCpm.toFixed(2)}`);

  const prevMiles = classification?.previousContractedAnnualMiles;
  const prevMilesValid = !!prevOp && Number.isFinite(prevMiles) && prevMiles > 0;
  toggleRow(node, 'prev-miles', prevMilesValid);
  if (prevMilesValid) set('[data-rc-prev-miles]', prevMiles.toLocaleString());

  // Awarded vehicle of the previous contract — shown whenever we have a spec
  // for it (parity with the current section), not only when it differs.
  const pP = classification?.prevAwardedPropulsion;
  const pD = classification?.prevAwardedDeck;
  const prevVeh = (pP || pD) ? formatAwardedVehicle(pP, pD) : null;
  toggleRow(node, 'prev-veh', !!prevOp && !!prevVeh);
  if (prevOp && prevVeh) set('[data-rc-prev-veh]', prevVeh);

  const prevBids = classification?.previousNumberOfTenderers;
  const prevBidsValid = !!prevOp && Number.isFinite(prevBids) && prevBids > 0;
  toggleRow(node, 'prev-bids', prevBidsValid);
  if (prevBidsValid) set('[data-rc-prev-bids]', `${prevBids}${prevBids === 1 ? ' bid' : ' bids'}`);

  // The Next-contract section was removed — nothing in it has actually
  // been awarded yet, so labels like "Awarded vehicle" mis-state what we
  // know. The underlying fields (`nextTenderStart`, `nextAwardPropulsion`,
  // `nextAwardDeck`, `extensionEligible`) are still derived in
  // build-classifications.js and surfaced via the XLSX export — they're
  // just not rendered on the card today.

  // Hover tooltips on every label — explains where each metric comes from
  // and how it's derived. Pseudo-element ⓘ glyph (CSS) advertises that a
  // tooltip is available; the browser shows the `title` text on hover.
  attachTooltips(node);

  return node;
}

// Show or hide a conditional row by its `data-rc-row` key. Rows ship with
// the `hidden` attribute set in the template so missing data doesn't draw
// a placeholder; renders only flip the attribute, never construct DOM.
function toggleRow(card, key, show) {
  const row = card.querySelector(`[data-rc-row="${key}"]`);
  if (!row) return;
  row.hidden = !show;
}

// "Hybrid (DD)" / "Electric" / "—" depending on what we have. Kept as one
// row rather than two so the Tender section stays compact.
function formatAwardedVehicle(propulsion, deck) {
  const p = propulsion ? PROP_MAP[propulsion] : null;
  const d = deck       ? DECK_MAP[deck]       : null;
  if (p && d) return `${p} (${d})`;
  if (p)      return p;
  if (d)      return d;
  return 'XXX';
}

function toTitleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// ISO yyyy-mm-dd → "12 Aug 2025". Locale-stable so the card reads the same
// for everyone regardless of browser locale.
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatHumanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return iso;
  const mon = MONTHS_SHORT[parseInt(m[2], 10) - 1] ?? m[2];
  return `${parseInt(m[3], 10)} ${mon} ${m[1]}`;
}
