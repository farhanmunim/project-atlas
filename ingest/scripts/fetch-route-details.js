import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-route-details.js — Per-route supplementary data
 *
 * Produces data/source/route_details.json consumed by build-classifications.js.
 * Sources (in priority order):
 *
 *   1. data/garages.geojson  — authoritative operator / garage / PVR / route→garage
 *                              allocation (built from londonbusroutes.net's CSV).
 *   2. londonbusroutes.net/details.htm — vehicle type string per route. Parsed
 *                              via robust regex (not fixed-width columns) so
 *                              alignment drift and footnote rows don't corrupt
 *                              the result.
 *   3. TfL API /Line/{id}/Route — service type (Regular / Night / School).
 *
 * Output schema (unchanged — drop-in replacement for the old scraper):
 *   {
 *     generatedAt, source, routeCount,
 *     routes:      { [routeId]: { deck, vehicleType, propulsion, operator,
 *                                 garageName, garageCode, pvr, headwayMin } },
 *     aliases:     { "N128": "128", ... },
 *     operatorByRoute: { "128": "Stagecoach London", ... },
 *     operatorByRouteBustimes: {}  // kept as empty object for compat
 *   }
 *
 * Run: npm run fetch-route-details
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const OUT_PATH  = path.join(DATA_DIR, 'source', 'route_details.json');
const GARAGES_PATH = path.join(DATA_DIR, 'garages.geojson');
const DETAILS_URL  = 'http://www.londonbusroutes.net/details.htm';
const CHANGES_URL  = 'http://www.londonbusroutes.net/changes.htm';
const SCRIPT       = 'route-details';

// ── Normalise operators to parent brands ──────────────────────────────────────
const OPERATOR_ALIASES = {
  'Arriva': 'Arriva',
  'Go-Ahead': 'Go-Ahead',
  'Metroline': 'Metroline',
  'Stagecoach': 'Stagecoach London',
  'Stagecoach London': 'Stagecoach London',
  'Transport UK': 'Transport UK',
  'First': 'First',
  'First Bus': 'First',
  'Uno': 'Uno',
  'Sullivan Buses': 'Sullivan Buses',
};
function normaliseOperator(name) {
  if (!name) return null;
  const t = String(name).trim();
  return OPERATOR_ALIASES[t] ?? t;
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Detect encoding: details.htm sometimes serves Windows-1252.
  const buf = Buffer.from(await res.arrayBuffer());
  // Try UTF-8 strict; if replacement chars (U+FFFD) appear, fall back to Latin-1.
  let txt = buf.toString('utf8');
  if (txt.includes('\uFFFD')) txt = buf.toString('latin1');
  return txt;
}

// ── 1. Load authoritative garage → route allocation from garages.geojson ────
function loadGarageAllocation() {
  if (!fs.existsSync(GARAGES_PATH)) {
    console.warn(`  data/garages.geojson not found — operator/garage/PVR will be empty. Run fetch-garages first.`);
    return { byRoute: {}, garageByCode: {} };
  }
  const data = JSON.parse(fs.readFileSync(GARAGES_PATH, 'utf8'));
  const byRoute = {};       // { "1": { operator, garageName, garageCode, pvr, nightOnly } }
  const garageByCode = {};  // { "Q": { operator, garageName, pvr } }
  for (const f of (data.features ?? [])) {
    const p = f.properties ?? {};
    const code = String(p['TfL garage code'] || p['LBR garage code'] || '').trim().toUpperCase();
    if (!code) continue;
    const operator   = normaliseOperator(p['Group name']);
    const garageName = p['Garage name'] ?? null;
    const pvr        = parseInt(p['PVR'], 10);
    garageByCode[code] = { operator, garageName, pvr: Number.isFinite(pvr) ? pvr : null };

    const register = (tokens, { nightOnly = false, school = false } = {}) => {
      for (const raw of tokens.split(/\s+/)) {
        const t = raw.trim().toUpperCase();
        if (!t) continue;
        // Existing entry from main list wins over night-only/school-only
        const prev = byRoute[t];
        if (prev && !prev.nightOnly && !prev.schoolOnly) continue;
        if (prev && nightOnly && !prev.nightOnly) continue;
        byRoute[t] = {
          operator, garageName, garageCode: code,
          pvr: Number.isFinite(pvr) ? pvr : null,
          nightOnly, schoolOnly: school,
        };
      }
    };
    register(p['TfL main network routes'] || '', {});
    register(p['TfL night routes']        || '', { nightOnly: true });
    register(p['TfL school/mobility routes'] || '', { school: true });
  }
  console.log(`  Loaded ${Object.keys(byRoute).length} route→garage mappings from garages.geojson`);
  return { byRoute, garageByCode };
}

// ── 2. details.htm — vehicle type strings per route ─────────────────────────
// Robust regex-based parse (no fixed columns). The page has <pre> blocks like:
//   "  1  B5LH/Gemini 3 2D              Q   23  14  9  46-96   9-10     13      13    06/07/24 TQ 7 30/09/23"
// Structure after stripping inline <a>/<font> tags and &entities:
//   route-id  vehicle-type(>=3 tokens, includes spaces)  garage-code  ... numbers ...
// We anchor on: ^spaces?ROUTE  spaces(2+)  VEHICLE(greedy-until-2-spaces-then-CODE)  CODE=[A-Z0-9]{1,4}  2+spaces  digits

function stripInlineTags(s) {
  return s
    .replace(/<a [^>]*>([^<]*)<\/a>/gi, '$1')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/<\/?b>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function parseDetailsText(html) {
  // Collect <pre>…</pre> blocks
  const preBlocks = [];
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let m;
  while ((m = preRe.exec(html)) !== null) preBlocks.push(m[1]);
  if (!preBlocks.length) {
    // Upstream HTML structure changed or the page returned a transient
    // error page. Degrade gracefully so the rest of the pipeline keeps
    // its garages-derived fields rather than the whole step exiting 1.
    console.warn('  No <pre> blocks in details.htm — vehicle types will be null this run');
    return {};
  }

  // The table uses fixed-width columns defined by a dash-separator header line:
  //   ---- ----------------------------- --- --- -- -- ------- ------- ------- ------- -------- -- - --------
  //   Rte  Vehicle Type                  Op. PVR     Length          Frequencies       Timetable   Contract
  //   nr.                                Gar.    km mi minutes Mon-Sat Sunday  evening   date   specification
  // Column layout (0-indexed, inclusive ranges):
  //   0-3   route id
  //   5-33  vehicle type (29 chars)
  //   35-37 garage/op code
  //   39-41 PVR
  //   43-44 km
  //   46-47 mi
  //   49-55 range (min-max minutes)
  //   57-63 Mon-Sat headway
  //   65-71 Sunday headway
  //   73-79 evening headway
  //   81-88 timetable date
  //   90-?  contract spec
  const COLS = {
    route:   [ 0,  4],
    vehicle: [ 5, 34],
    garage:  [35, 38],
    pvr:     [39, 42],
    km:      [43, 45],
    mi:      [46, 48],
    range:   [49, 56],
    monSat:  [57, 64],
    sunday:  [65, 72],
    evening: [73, 80],
  };
  function slice(line, [a, b]) {
    return line.slice(a, b).trim();
  }

  // Parse one headway cell. Examples:
  //   "12"   → 12          (single number)
  //   "8-9"  → 8.5         (range, take mean)
  //   "12*"  → 12          (footnote markers stripped)
  //   ""     → null        (empty)
  //   "WCroydon" → null    (school routes put endpoint names here, not numbers)
  function parseHeadwayCell(s) {
    if (!s) return null;
    const c = String(s).replace(/[*†‡§·]+/g, '').trim();
    if (!c) return null;
    let m;
    if ((m = /^(\d+)\s*-\s*(\d+)$/.exec(c))) return (parseInt(m[1], 10) + parseInt(m[2], 10)) / 2;
    if ((m = /^(\d+)$/.exec(c))) return parseInt(m[1], 10);
    return null;
  }

  // Pull the contract-start date out of a row. LBR's column layout puts:
  //   ... <Mon-Sat> <Sunday> <evening> <timetable date> <contract spec> <contract date>
  // Where `contract spec` is "TQ N" / "See N" / similar, and `contract date`
  // is the start date of the current contract (dd/mm/yy). For routes with
  // only one date in the row (older contracts pre-current tracking), the
  // single date is the timetable date — no contract date available, return
  // null. Returns ISO yyyy-mm-dd or null.
  function extractContractStart(line) {
    const dates = [...line.matchAll(/\b(\d{2})\/(\d{2})\/(\d{2})\b/g)];
    if (dates.length < 2) return null;
    const [, dd, mm, yy] = dates[dates.length - 1];   // last date in the row
    const day   = parseInt(dd, 10);
    const month = parseInt(mm, 10);
    const year  = 2000 + parseInt(yy, 10);            // LBR data is post-2000 only
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Contract length (years) from the "specification" column. Per the page's own
  // legend the cell reads `<type><basis> <duration> <start-date>`, e.g.:
  //   "TQ 7 30/09/23"  — Tendered, Quality-incentive, 7-year term
  //   "TQ 5+29/06/19"  — base 5 yrs, extended to 7 (the + = extension exercised)
  //   "TQ 5X …"        — extension refused/unavailable → stays 5
  //   "TG 3 …"         — Tendered, Gross-cost, 3-year term
  //   "TQ T …"         — temporary short-term contract (no fixed term → null)
  // type ∈ {T,N,C,A}, basis ∈ {G,Q,A,P}. Returns the effective term in years
  // (a trailing `+` adds the 2-year extension), or null when none/temporary.
  // A "Contract reduced/extended to N years" note on a following line overrides
  // this — handled in the row loop, not here.
  function extractContractTerm(line) {
    const m = /\b([TNCA][GQAP])\s+(\d+|T)(\+)?(X)?\s*\d{2}\/\d{2}\/\d{2}\b/.exec(line);
    if (!m) return null;
    if (m[2] === 'T') return null;                    // temporary, no fixed term
    let years = parseInt(m[2], 10);
    if (!Number.isFinite(years) || years < 1 || years > 15) return null;
    if (m[3]) years += 2;                             // "+" = 5→7 extension exercised
    return years;
  }

  // Representative weekday headway for a row. Daytime routes carry it directly
  // in the Mon-Sat / Sunday / evening fixed-width columns. Night routes leave
  // those columns empty and put the night headways just before the date — fall
  // back to tokenising the segment after the length-range column. School /
  // limited-service routes encode endpoint names in the headway columns; we
  // detect alpha chars there and return null so they don't get a spurious band.
  function representativeHeadway(line) {
    const headwayWindow = line.length > 57 ? line.slice(57, 80) : '';
    if (/[A-Za-z]/.test(headwayWindow)) return null;
    const monSat  = parseHeadwayCell(slice(line, COLS.monSat));
    const sunday  = parseHeadwayCell(slice(line, COLS.sunday));
    const evening = parseHeadwayCell(slice(line, COLS.evening));
    for (const v of [monSat, sunday, evening]) if (v != null && v > 0) return v;
    const dateMatch = /\b\d{2}\/\d{2}\/\d{2}\b/.exec(line);
    if (!dateMatch || line.length < 39) return null;
    const segment = line.slice(39, dateMatch.index);
    const tokens = [...segment.matchAll(/(?<![A-Za-z])(\d+(?:-\d+)?)\*?(?![A-Za-z])/g)];
    const vals = tokens.map(t => parseHeadwayCell(t[1])).filter(v => v != null);
    return vals.length > 4 ? vals[4] : null;
  }

  const byRoute = {};
  let lastRid = null;   // most recent route row, so continuation notes attach to it

  for (const block of preBlocks) {
    const rawLines = block.split(/\r?\n/);
    for (const raw of rawLines) {
      const line = stripInlineTags(raw);
      if (!line.trim()) continue;
      if (/^\s*(Rte|nr\.|Route|Vehicle|Number|---)/i.test(line)) continue;

      // A "Contract reduced/extended to N years" note sits on its own line
      // below the route row and overrides the column figure (e.g. W5 shows
      // "TQ 7" but is annotated "Contract reduced to 4 years"). Must run before
      // the generic "Contract"-prefix skip below. The "(?)" uncertainty marker
      // some notes carry is tolerated; those rare ones can be hand-overridden.
      const noteM = /\bcontract\s+(?:reduced|extended)\s+to\s+(\d+)\s*(?:\(\?\)\s*)?years?\b/i.exec(line);
      if (noteM) {
        const y = parseInt(noteM[1], 10);
        if (lastRid && byRoute[lastRid] && Number.isFinite(y) && y >= 1 && y <= 15) {
          byRoute[lastRid].contractTermFromDetails = y;
        }
        continue;
      }
      if (/^\s*\*/.test(line)) continue;                 // footnote
      if (/^\s*Contract/i.test(line)) continue;

      // Route id must live in the first 4 chars
      const routeCol = slice(line, COLS.route);
      if (!routeCol) continue;
      if (!/^[A-Z]{0,3}\d{1,3}[A-Z]?$|^[A-Z]{2,4}$/.test(routeCol)) continue;
      const rid = routeCol.toUpperCase();
      if (byRoute[rid]) { lastRid = rid; continue; } // first occurrence wins; still track for notes

      const vehicleRaw = slice(line, COLS.vehicle);
      const garageRaw  = slice(line, COLS.garage).replace(/\*+$/, '').toUpperCase();
      const pvrRaw     = slice(line, COLS.pvr);
      const pvrNum = parseInt(pvrRaw, 10);
      byRoute[rid] = {
        vehicleType: vehicleRaw,
        garageCodeFromDetails: /^[A-Z0-9]{1,4}$/.test(garageRaw) ? garageRaw : null,
        pvrFromDetails: Number.isFinite(pvrNum) ? pvrNum : null,
        headwayMinFromDetails: representativeHeadway(line),
        contractStartFromDetails: extractContractStart(line),
        contractTermFromDetails:  extractContractTerm(line),
      };
      lastRid = rid;
    }
  }
  return byRoute;
}

// ── changes.htm — contract changes (cross-check / most-recent wins) ──────────
// changes.htm lists contract awards/retentions as table rows
// [route, details, expected-date]. A contract row reads e.g.
//   "Contract retained by Metroline with new electric double deckers. (7 years) (261225)"
// with the effective date in the third cell ("20 Jun 26"). We keep, per route,
// the most recent change that is ALREADY in effect (effective ≤ today) — that
// is the current contract per this page — as { termYears, startIso }. Routes
// whose contract changed more recently here than details.htm's table shows
// (the daily table can lag a live change by a day or two) get corrected.
function parseChangesContracts(html, todayIso) {
  const strip = s => String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const parseExpected = s => {
    const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/.exec(s);
    if (!m) return null;
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    return `${2000 + parseInt(m[3], 10)}-${String(mo).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  };
  const rowRe = /<TR>\s*<TD>([\s\S]*?)<\/TD>\s*<TD>([\s\S]*?)<\/TD>\s*<TD[^>]*>([\s\S]*?)<\/TD>\s*<\/TR>/gi;
  const byRoute = {};
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rid = strip(m[1]).toUpperCase();
    if (!/^[A-Z]{0,3}\d{1,3}[A-Z]?$|^[A-Z]{2,4}$/.test(rid)) continue;
    const details = strip(m[2]);
    if (!/contract\s+(?:retained|awarded|novated)/i.test(details)) continue;
    const ym = /\((\d+)\s*years?\)/i.exec(details);
    if (!ym) continue;
    const termYears = parseInt(ym[1], 10);
    if (!(termYears >= 1 && termYears <= 15)) continue;
    const startIso = parseExpected(strip(m[3]));
    if (!startIso || startIso > todayIso) continue;       // only changes already in effect
    const prev = byRoute[rid];
    if (!prev || startIso > prev.startIso) byRoute[rid] = { termYears, startIso };
  }
  return byRoute;
}

// ── Vehicle-string → deck / propulsion heuristics ────────────────────────────
// Heuristic from the chassis/body names in LBR's vehicle-type string. The
// previous version mis-treated the trailing 1D/2D/3D markers as deck count,
// but per the page's own legend those mean door count (1D=single-door,
// 2D=dual-door, 3D=triple-door). The chassis name is the authoritative
// signal. data/vehicle-lookup.json is consulted FIRST by build-classifications
// — this only runs for new vehicle strings not yet curated there.
function deriveDeck(s) {
  if (!s) return null;
  const t = s.toUpperCase();
  // Double-deck chassis / body families
  if (/NEW BUS FOR LONDON|NB4L/.test(t) ||
      /E40H|E40D|ENVIRO400/.test(t) ||
      /\bB5LH\b|\bB5TH\b|\bB9TL\b|\bB7TL\b|\bDB300\b|\bN230UD\b/.test(t) ||
      /GEMINI|EVOSETI|SRM/.test(t) ||
      /METRODECKER|STREETDECK/.test(t) ||
      /\bDD\b|\bE400EV\b|ENVIRO400EV/.test(t) ||
      /BZL \(DD\)/.test(t) ||
      /TRIDENT/.test(t)) return 'double';
  // Single-deck chassis / body families
  if (/ENVIRO200|\bE200\b|\bE20D\b|E100EV|ENVIRO100|E200DART/.test(t) ||
      /\bD[89]UR\b|\bK8SR\b|\bB[1-9]{1,2}E0[1-9]\b/.test(t) ||  // BYD single-deck chassis
      /CITARO/.test(t) ||
      /SOLO|VERSA|STREETLITE|STREETAIR/.test(t) ||
      /YUTONG|\bE1[02]\b/.test(t) ||
      /VOLVO B[78]RLE/.test(t) ||
      /KITE ELECTROLINER/.test(t) ||                              // Wright Kite (SD)
      /METROCITY|E\.CITY GOLD/.test(t) ||
      /BZL \(SD\)/.test(t)) return 'single';
  return null;
}
function derivePropulsion(s) {
  if (!s) return null;
  const t = s.toUpperCase();
  if (/FCEV|FUEL CELL|HYDROGEN/.test(t)) return 'hydrogen';
  if (/\bEV\b|EV |\bE\d{1,2}[A-Z]?EV\b|[A-Z0-9]EV\b|ELECTROLINER|STREETAIR|ELECTRIC|ECITARO|\bZEB\b|\bBYD\b|\bBZL\b/.test(t)) return 'electric';
  if (/YUTONG\s+E\d/.test(t)) return 'electric';
  if (/NEW BUS FOR LONDON|NB4L|ENVIRO400H|E40H|B5LH|B5TH|\bHEV\b|HYBRID/.test(t)) return 'hybrid';
  return 'diesel';
}
function cleanVehicleType(raw) {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/[*†‡§\u0086]+$/g, '').trim();         // trailing footnote markers
  // PRESERVE chassis / fleet prefix — it's often the most informative part of
  // the string ("BYD" = electric, "B5LH" = Volvo hybrid). The previous version
  // stripped these prefixes which collapsed e.g. "B5LH 10.5m/EvoSeti 2D" down
  // to just "EvoSeti", dropping the chassis info and making vehicleType look
  // diesel even when DVLA correctly classified the route as hybrid.
  s = s.replace(/\s*\d+\.?\d*m\//i, '/').trim();        // collapse "10.5m/" into "/"
  s = s.replace(/^\/+/, '').trim();
  s = s.replace(/\s*[123]D[?*†‡§\u0086]?\s*$/, '').trim(); // strip trailing deck tag
  return s || null;
}

// ── 3. Service types from TfL (for aliases of 24-hour routes) ────────────────
loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';

// Aliases (night→day) come from routes.htm — preserve old behaviour.
async function fetchAliases() {
  try {
    const html = await fetchText('http://www.londonbusroutes.net/routes.htm');
    const rowRe = /<TR[^>]*>\s*<TD[^>]*>\s*<a\s+name=["']?([MN][A-Z0-9]+)["']?\s+href=["']?([^"'>]+)["']?>([^<]+)<\/a>/gi;
    const rows = [];
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      rows.push({ role: m[1][0], id: (m[1][0] === 'N' ? m[1].slice(1) : m[3]).trim().toUpperCase(), href: m[2].trim() });
    }
    const byHref = {};
    for (const r of rows) (byHref[r.href] ??= []).push(r);
    const aliases = {};
    for (const r of rows) {
      if (r.role !== 'N') continue;
      const main = byHref[r.href].find(x => x.role === 'M');
      if (main) aliases[`N${r.id}`] = main.id;
    }
    return aliases;
  } catch (err) {
    console.warn(`  routes.htm unavailable (${err.message}) — aliases empty`);
    return {};
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Loading garage allocations from data/garages.geojson...');
  const { byRoute: allocByRoute, garageByCode } = loadGarageAllocation();

  console.log(`Fetching ${DETAILS_URL}...`);
  let detailsHtml = '';
  try {
    detailsHtml = await fetchText(DETAILS_URL);
    console.log(`  Downloaded ${(detailsHtml.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.warn(`  details.htm unavailable (${err.message}) — vehicle types will be null`);
  }
  const vehicleByRoute = detailsHtml ? parseDetailsText(detailsHtml) : {};
  console.log(`  Parsed vehicle info for ${Object.keys(vehicleByRoute).length} routes`);

  // Cross-check contract length against changes.htm (the forthcoming/recent
  // service-changes log). Its in-effect contract rows let us catch a contract
  // change before details.htm's daily table reflects it — "most recent wins".
  const today = new Date().toISOString().slice(0, 10);
  let changesContracts = {};
  try {
    const changesHtml = await fetchText(CHANGES_URL);
    changesContracts = parseChangesContracts(changesHtml, today);
    console.log(`  Parsed ${Object.keys(changesContracts).length} in-effect contract changes from changes.htm`);
  } catch (err) {
    console.warn(`  changes.htm unavailable (${err.message}) — contract cross-check skipped`);
  }
  let chgApplied = 0, chgConfirmed = 0;

  const aliases = await fetchAliases();
  console.log(`  Parsed ${Object.keys(aliases).length} night→day aliases`);

  // Build per-route output
  const routes = {};
  const operatorByRoute = {};
  const allIds = new Set([...Object.keys(allocByRoute), ...Object.keys(vehicleByRoute)]);
  for (const id of allIds) {
    const alloc = allocByRoute[id] ?? null;
    const v = vehicleByRoute[id] ?? null;
    const rawVehicle = v?.vehicleType ?? null;
    const cleanVeh = cleanVehicleType(rawVehicle);
    // Cross-check garage code: if details.htm gave a different one, trust the CSV
    let operator = alloc?.operator ?? null;
    let garageName = alloc?.garageName ?? null;
    let garageCode = alloc?.garageCode ?? null;
    // Route-level PVR comes from details.htm (per route). The garages CSV PVR is
    // a garage-wide total and must NOT be written to each route or it multiplies
    // when summed. Garage totals belong on the garage record, not the route.
    let pvr = v?.pvrFromDetails ?? null;
    if (!alloc && v?.garageCodeFromDetails) {
      garageCode = v.garageCodeFromDetails;
      const g = garageByCode[garageCode];
      if (g) {
        operator = g.operator;
        garageName = g.garageName;
      }
    }
    // Contract start + length come from details.htm's table by default, but a
    // more recent in-effect change on changes.htm wins ("most recent change").
    let contractStart     = v?.contractStartFromDetails ?? null;
    let contractTermYears = v?.contractTermFromDetails ?? null;
    const chg = changesContracts[id];
    if (chg && (!contractStart || chg.startIso > contractStart)) {
      // changes.htm knows a contract that started on/after details.htm's — take it.
      if (contractTermYears != null && contractTermYears !== chg.termYears) chgApplied++;
      contractStart     = chg.startIso;
      contractTermYears = chg.termYears;
    } else if (chg && contractTermYears === chg.termYears) {
      chgConfirmed++;
    }

    routes[id] = {
      deck:        deriveDeck(rawVehicle),
      vehicleType: cleanVeh,
      propulsion:  derivePropulsion(rawVehicle),
      operator, garageName, garageCode, pvr,
      // Representative weekday headway (minutes) read straight from the
      // details.htm row. Used by build-classifications.js as a fallback
      // signal when TfL's published timetable yields no band.
      headwayMin:  v?.headwayMinFromDetails ?? null,
      // Contract start date as ISO yyyy-mm-dd. LBR's details.htm publishes
      // the current contract's start in the last column of every route row,
      // covering routes the LBSL programme PDFs miss (~470 of 747). Overridden
      // by a more recent in-effect change from changes.htm.
      contractStart,
      // Contract length in years, decoded from details.htm's "TQ 7"-style spec
      // (+ any "reduced/extended to N years" note), cross-checked against
      // changes.htm. More authoritative than the tender date-gap heuristic, so
      // build-classifications prefers it.
      contractTermYears,
    };
    if (operator) operatorByRoute[id] = operator;
  }
  if (Object.keys(changesContracts).length) {
    console.log(`  changes.htm cross-check: ${chgApplied} contract length(s) updated, ${chgConfirmed} confirmed`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'garages.geojson + londonbusroutes.net/details.htm + changes.htm',
    routeCount: Object.keys(routes).length,
    routes,
    aliases,
    operatorByRoute,
    operatorByRouteBustimes: {},
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(output)), 'utf8');
  console.log(`Wrote: ${OUT_PATH}`);
  console.log(`  Routes: ${output.routeCount}`);
  // Spot-check
  if (routes['1']) {
    const r = routes['1'];
    console.log(`  Route 1: vehicle=${r.vehicleType} operator=${r.operator} garage=${r.garageCode} (${r.garageName}) pvr=${r.pvr}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
