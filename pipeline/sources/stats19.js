/**
 * sources/stats19.js — DfT STATS19 road-safety data (bus/coach-involved collisions).
 *
 * Source: DfT "Road accidents and safety statistics" open data (data.dft.gov.uk).
 *   collision table  https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-{YEAR}.csv
 *   vehicle table    https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-vehicle-{YEAR}.csv
 * Cadence: ANNUAL (DfT publishes the prior year's STATS19 the following autumn).
 *
 * We want BUS/COACH-involved collisions in Greater London. The collision table has
 * the geometry + severity; the vehicle table has vehicle_type per vehicle. We join
 * on collision_index and keep collisions where any vehicle is a bus/coach
 * (vehicle_type 10 = minibus 8-16, 11 = bus/coach 17+). The collision csv carries
 * longitude/latitude (WGS84), collision_severity (1=Fatal,2=Serious,3=Slight),
 * date (DD/MM/YYYY), local_authority_ons_district, police_force, number_of_vehicles.
 *
 * Greater London filter: M25 bbox roughly [-0.55, 51.25, 0.30, 51.71].
 *
 * These CSVs are large (~100k+ rows/year, several MB). We STREAM the response and
 * parse line-by-line, keeping only matching rows — never buffering the whole file.
 * Robust: per-request timeout, soft per-year failure (a year that fails is skipped,
 * the rest still land), caller keeps last-good if the whole pull degrades.
 */

const BASE = "https://data.dft.gov.uk/road-accidents-safety-data";
const collisionUrl = (y) => `${BASE}/dft-road-casualty-statistics-collision-${y}.csv`;
const vehicleUrl   = (y) => `${BASE}/dft-road-casualty-statistics-vehicle-${y}.csv`;
const UA = "TransitInstruments/0.1 (+london-bus-operator data pipeline)";

// Greater London (M25-ish) bounding box.
export const LONDON_BBOX = [-0.55, 51.25, 0.30, 51.71]; // [minLng, minLat, maxLng, maxLat]
const BUS_TYPES = new Set(["10", "11"]); // 10 = minibus, 11 = bus/coach
const SEVERITY = { "1": "fatal", "2": "serious", "3": "slight" };

const DEFAULT_TIMEOUT_MS = 120_000; // these CSVs are multi-MB; allow a slow stream

/* ── minimal CSV field splitter (handles quoted fields with commas) ── */
function splitCsv(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Stream a CSV URL line-by-line, calling onRow(fieldsArray, headerIndexMap) per data row. */
async function streamCsv(url, onRow, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/csv" }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "", header = null, idx = null;
    const handleLine = (line) => {
      if (line === "") return;
      const fields = splitCsv(line);
      if (!header) {
        header = fields;
        idx = {};
        header.forEach((h, i) => { idx[h.trim()] = i; });
        return;
      }
      onRow(fields, idx);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buf += ""; // noop
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf.length) { let line = buf; if (line.endsWith("\r")) line = line.slice(0, -1); handleLine(line); }
  } finally {
    clearTimeout(timer);
  }
}

function inBbox(lng, lat, [minLng, minLat, maxLng, maxLat]) {
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

/** DD/MM/YYYY → YYYY-MM-DD (STATS19 date format). */
function isoDate(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((d || "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Fetch + filter one STATS19 year into bus-involved Greater-London collisions.
 * Pass 1 streams the vehicle table → set of collision_index that include a bus/coach.
 * Pass 2 streams the collision table → keep matching, in-bbox rows with valid coords.
 * Returns { year, accidents: [...] }. Throws on a hard fetch failure for the year.
 */
export async function fetchStats19Year(year, { bbox = LONDON_BBOX, timeoutMs } = {}) {
  // Pass 1 — which collisions involve a bus/coach?
  const busCollisions = new Set();
  await streamCsv(vehicleUrl(year), (f, idx) => {
    const vt = (f[idx.vehicle_type] || "").trim();
    if (BUS_TYPES.has(vt)) busCollisions.add((f[idx.collision_index] || "").trim());
  }, { timeoutMs });

  if (busCollisions.size === 0) return { year, accidents: [] };

  // Pass 2 — pull geometry/severity for those collisions, filtered to London.
  const accidents = [];
  await streamCsv(collisionUrl(year), (f, idx) => {
    const id = (f[idx.collision_index] || "").trim();
    if (!busCollisions.has(id)) return;
    const lng = Number(f[idx.longitude]);
    const lat = Number(f[idx.latitude]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (!inBbox(lng, lat, bbox)) return;
    const sev = SEVERITY[(f[idx.collision_severity] || "").trim()];
    if (!sev) return;
    const nv = parseInt(f[idx.number_of_vehicles], 10);
    const lad = idx.local_authority_ons_district != null ? (f[idx.local_authority_ons_district] || "").trim() : "";
    accidents.push({
      id,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      severity: sev,
      date: isoDate(f[idx.date]),
      borough: lad && lad !== "-1" ? lad : null,
      vehicles: Number.isFinite(nv) && nv > 0 ? nv : null,
    });
  }, { timeoutMs });

  return { year, accidents };
}

/**
 * Pull the most recent `years` years (newest first), soft-failing per year.
 * Returns { accidents:[...], years:[...landed], source, errors:[...] }.
 * The newest available STATS19 year ≈ currentYear-2 (publication lag).
 */
export async function fetchStats19({ years = [2023, 2022, 2021], bbox = LONDON_BBOX, timeoutMs, log } = {}) {
  const all = [];
  const landed = [];
  const errors = [];
  for (const y of years) {
    try {
      const { accidents } = await fetchStats19Year(y, { bbox, timeoutMs });
      if (accidents.length) { all.push(...accidents); landed.push(y); }
      log?.info?.(`stats19: ${y} → ${accidents.length} bus-involved London collisions`);
    } catch (e) {
      errors.push({ year: y, error: e.message });
      log?.warn?.(`stats19: year ${y} failed (${e.message}) — skipping that year`);
    }
  }
  return {
    accidents: all,
    years: landed,
    source: "DfT STATS19 road safety data (collision + vehicle tables, bus/coach-involved)",
    errors,
  };
}
