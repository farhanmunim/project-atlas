/**
 * sources/londonbusroutes.js — scraper for londonbusroutes.net (Ian Armstrong).
 *
 * The authoritative community reference for per-route operating detail that TfL
 * does NOT publish in the free API: vehicle type (fleet), garage, PVR, route
 * length, and contract date. `details.htm` is a fixed-width <pre> table served
 * as Windows-1252.
 *
 * Scraping is the last resort (no machine-readable feed exists for this), so we
 * parse defensively: derive column boundaries from the ruler line, skip rows we
 * can't read, and let the builder fall back to last-good / sample on failure.
 * Per claude.md: check terms, be polite (one page, cached via the HTTP layer).
 *
 * Returns: [{ route, vehicleType, garage, pvr, lengthKm, contractDate }]
 */

import { getText } from "../lib/http.js";

const DETAILS_URL = "http://www.londonbusroutes.net/details.htm";
const GARAGES_URL = "http://www.londonbusroutes.net/garages.csv";

/* Quote-aware CSV → array of row-arrays. Handles doubled quotes and commas/
   newlines inside quoted fields. */
function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const GROUP_TO_OPERATOR = {
  "arriva": "Arriva London", "go-ahead": "Go-Ahead London", "metroline": "Metroline",
  "stagecoach": "Stagecoach London", "ratp": "Transport UK London Bus",
  "transport uk": "Transport UK London Bus", "first": "First Bus London",
  "abellio": "Abellio London", "uno": "Uno", "sullivan": "Sullivan Buses", "hct": "HCT Group",
};
/* LBR's CSV carries raw HTML entities in company names ("…&amp; Kent Bus Co.") —
   decode at the boundary so no downstream surface ships them. */
function decodeEnt(s) {
  return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function normaliseOperator(group) {
  const g = (group || "").trim().toLowerCase();
  for (const k in GROUP_TO_OPERATOR) if (g.startsWith(k)) return GROUP_TO_OPERATOR[k];
  return group ? group.trim() : null;
}

/** Garage-centric rows from garages.csv → [{ code, name, operator, company,
 *  postcode, pvr, routes[] }]. Coordinates are added by build/garages.js (geocode). */
export async function fetchGarages(opts = {}) {
  const csv = await getText(GARAGES_URL, { encoding: "windows-1252", timeoutMs: 25_000, ...opts });
  const rows = parseCsv(csv);
  if (rows.length < 20) throw new Error(`garages.csv: only ${rows.length} rows`);
  const header = rows[0].map((h) => h.trim());
  const col = (n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iGroup = col("Group name"), iCompany = col("Company name"), iLbr = col("LBR garage code"),
        iName = col("Garage name"), iAddr = col("Garage address"), iPvr = col("PVR"),
        iCoAddr = col("Company address");
  const routeCols = ["TfL main network routes", "TfL night routes", "TfL school/mobility routes", "Other routes"].map(col).filter((i) => i >= 0);
  const pcRe = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || !row[iLbr]) continue;
    if (/tram/i.test(row[iCompany] || "") || /tram|therapia/i.test(row[iName] || "")) continue;  // skip Tramlink
    const addr = row[iAddr] || "";
    // Keep the garage-address postcode and the company-address postcode separate:
    // the garage address is the depot itself; the company address is often the
    // operator's registered office (a different, sometimes distant location). The
    // build step prefers garage → curated override → company, so a marker only
    // falls back to the HQ postcode when nothing better exists.
    const coAddr = iCoAddr >= 0 ? (row[iCoAddr] || "") : "";
    const pc = (addr.match(pcRe) || [])[1];
    const pcCompany = (coAddr.match(pcRe) || [])[1];
    const routes = [...new Set(routeCols.flatMap((ci) => (row[ci] || "").split(/\s+/).map((s) => s.trim()).filter(Boolean)))];
    out.push({
      code: (row[iLbr] || "").trim(), name: decodeEnt((row[iName] || "").trim()) || null,
      operator: normaliseOperator(row[iGroup]), company: decodeEnt((row[iCompany] || "").trim()) || null,
      address: addr.trim() || null, postcode: pc ? pc.toUpperCase().replace(/\s+/g, " ") : null,
      postcodeCompany: pcCompany ? pcCompany.toUpperCase().replace(/\s+/g, " ") : null,
      pvr: parseInt(row[iPvr], 10) || null, routes,
    });
  }
  return out;
}

/**
 * Garage CSV → route → { operator, group, company, garageCode, garageName }.
 * Authoritative for operator/garage (the route lists are maintained per garage).
 * Columns: 0 Group,2 Company,5 LBR code,6 Garage name, 8 main / 9 night /
 * 10 school-mobility / 11 other routes.
 */
export async function fetchGarageRouteMap(opts = {}) {
  const csv = await getText(GARAGES_URL, { encoding: "windows-1252", timeoutMs: 25_000, ...opts });
  const rows = parseCsv(csv);
  if (rows.length < 20) throw new Error(`garages.csv: only ${rows.length} rows`);
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iGroup = col("Group name"), iCompany = col("Company name"), iLbr = col("LBR garage code"), iName = col("Garage name");
  const routeCols = ["TfL main network routes", "TfL night routes", "TfL school/mobility routes", "Other routes"].map(col).filter((i) => i >= 0);

  const map = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || !row[iLbr]) continue;
    // skip non-bus depots — Croydon Tramlink lists lines 1–4 which collide with bus route numbers
    if (/tram/i.test(row[iCompany] || "") || /tram|therapia/i.test(row[iName] || "")) continue;
    const operator = normaliseOperator(row[iGroup]);
    const entry = { operator, group: (row[iGroup] || "").trim() || null, company: decodeEnt((row[iCompany] || "").trim()) || null,
      garageCode: (row[iLbr] || "").trim() || null, garageName: decodeEnt((row[iName] || "").trim()) || null };
    for (const ci of routeCols) {
      (row[ci] || "").split(/\s+/).map((s) => s.trim()).filter(Boolean).forEach((rt) => {
        if (!map[rt]) map[rt] = entry;   // first garage listing wins as primary
      });
    }
  }
  return map;
}

/** Column [start,end) spans from a ruler line of dash-runs. */
function columnsFromRuler(ruler) {
  const cols = [];
  const re = /-+/g; let m;
  while ((m = re.exec(ruler))) cols.push([m.index, m.index + m[0].length]);
  return cols;
}
const slice = (line, [s, e]) => (line.slice(s, e) || "").trim();

/** Parse one fixed-width <pre> route table → rows. Shared first-five-column layout
 *  across the main / night / school tables: [Rte, VehicleType, Op.Gar, PVR, km]. */
function parseDetailsBlock(block) {
  const lines = block.split(/\r?\n/);
  // the finer ruler is the dashed line with the most dash-groups (defines columns)
  let rulerIdx = -1, best = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^[-\s]+$/.test(lines[i]) && lines[i].includes("-")) {
      const groups = (lines[i].match(/-+/g) || []).length;
      if (groups > best) { best = groups; rulerIdx = i; }
    }
  }
  if (rulerIdx < 0) return [];
  const cols = columnsFromRuler(lines[rulerIdx]);
  // expected layout: [Rte, VehicleType, Garage, PVR, km, mi, minutes, …, contractDate]
  const C = { rte: 0, veh: 1, gar: 2, pvr: 3, km: 4 };

  const rows = [];
  for (let i = rulerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^[-\s]+$/.test(line)) continue;
    const rte = slice(line, cols[C.rte]);
    // data rows start with a route id: digits with up to a 3-letter prefix (25, N137, SL1,
    // EL1, BL1) or a rare all-letter code (SCS). Skip continuations/notes (empty col, "*…").
    if (!/^[A-Za-z]{0,3}\d/.test(rte) && !/^[A-Z]{2,4}$/.test(rte)) continue;
    const pvr = parseInt(slice(line, cols[C.pvr]), 10);
    const km = parseFloat(slice(line, cols[C.km]));
    const dates = line.match(/\b\d{2}\/\d{2}\/\d{2}\b/g) || [];
    // night rows defer their contract spec to the day route ("See 137") — the only date on
    // such a line is the timetable date, which must NOT be read as a contract date.
    const seeRef = /\bSee\s+[A-Z]{0,2}\d/i.test(line);
    rows.push({
      route: rte.replace(/\*$/, ""),
      vehicleType: slice(line, cols[C.veh]) || null,
      garage: (slice(line, cols[C.gar]) || "").replace(/\*$/, "") || null,
      // PVR 0 → null: a running route cannot need zero peak vehicles — LBR prints 0
      // where a route shares its bus with a paired route (389/399's single Barnet
      // circular bus); 0 is a wrong value, null is an honest unknown.
      pvr: Number.isFinite(pvr) && pvr > 0 ? pvr : null,
      lengthKm: Number.isFinite(km) ? km : null,
      contractDate: dates.length > 1 ? dates[dates.length - 1]            // last date = contract spec date
                  : (dates.length === 1 && !seeRef ? dates[0] : null),
    });
  }
  return rows;
}

export async function fetchRouteDetails(opts = {}) {
  const html = await getText(DETAILS_URL, { encoding: "windows-1252", timeoutMs: 25_000, ...opts });
  const pres = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((x) => x[1].replace(/<[^>]+>/g, ""));
  // details.htm carries FOUR fixed-width tables: main network · Croydon Tramlink · night
  // buses · school/mobility. Parse EVERY bus table (night + school routes carry their own
  // PVR / vehicle type / garage rows there — skipping them starved route-meta of ~130
  // routes' PVR/fleet). The tram table must stay excluded: its lines 1–4 collide with bus
  // routes 1–4 (same exclusion as the garages parser).
  const blocks = pres.filter((p) =>
    /Vehicle Type/i.test(p) && /PVR/i.test(p) && !/Variobahn|CR4000|Tramlink|Trams from/i.test(p));
  if (!blocks.length) throw new Error("details.htm: route table not found");

  const byRoute = {};
  for (const block of blocks) {
    for (const row of parseDetailsBlock(block)) {
      if (!byRoute[row.route]) byRoute[row.route] = row;   // first table wins (main network is first)
    }
  }
  const rows = Object.values(byRoute);
  if (rows.length < 300) throw new Error(`details.htm: only ${rows.length} rows parsed (expected ~600+)`);
  return rows;
}
