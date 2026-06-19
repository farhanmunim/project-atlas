/**
 * sources/london-bridges.js — TfL / London Datastore low-bridge & height-restriction data.
 *
 * Dataset: "Bridges, Tunnels, Road Barriers & Height Restrictions (EPOWR)" on the
 * London Datastore (slug `bridges-tunnels-road-barriers-height-restrictions-epowr`).
 * ~877 structures (low bridges, tunnels, road barriers) across Greater London / M25,
 * each with a banded height clearance + coordinates. Feeds Atlas's double-decker route
 * validation + bridge-strike avoidance layer.
 *
 *   discovery   GET https://data.london.gov.uk/api/dataset/<slug>   (London Datastore
 *               dataset API — NOT standard CKAN package_show) → resources[].url
 *   resource    https://roads.data.tfl.gov.uk/BridgesRestrictions/height-restrictions-in-london.xlsx
 * Cadence: ANNUAL (the .csv/.xlsx is refreshed ~yearly by TfL).
 *
 * The resource is an .xlsx (a ZIP of XML). It downloads DIRECTLY once the URL is known;
 * the landing page is JS-rendered but the dataset API above returns the resource URL as
 * JSON. We read the workbook with a tiny dependency-free ZIP+XML reader (no xlsx lib):
 * inflate `xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml`, then walk the rows.
 *
 * Columns (A–L): Height restriction (m) [banded] · Height restriction (imperial) [banded]
 *   · Easting (EPSG:27700) · Northing · Grid Reference · Lat (WGS84) · Lng (WGS84)
 *   · Borough · Road name · Road number · TLRN? · Comments.
 *
 * Coordinates: the file already carries WGS84 Lat/Lng — we use those. As a fallback (and
 * to honour the brief), we also implement the standard OSGB36→WGS84 transform from the
 * British National Grid easting/northing, used only when Lat/Lng are missing/invalid.
 *
 * Height: stored as a BAND ("Up to 3.0", "Between 4.6 and 5.1", or imperial "13'3\"…").
 * We normalise to METRES using the band's LOWER bound — the conservative/safe clearance
 * for strike avoidance (never claim more headroom than guaranteed).
 *
 * Robust: per-request timeout, soft-fail (throws on a hard failure so the caller keeps
 * last-good), filters to valid coords inside the M25 bbox.
 */

import zlib from "node:zlib";

const SLUG = "bridges-tunnels-road-barriers-height-restrictions-epowr";
const DATASET_API = `https://data.london.gov.uk/api/dataset/${SLUG}`;
// Known direct resource (kept as a fallback if the dataset API is unreachable/changes).
const FALLBACK_RESOURCE = "https://roads.data.tfl.gov.uk/BridgesRestrictions/height-restrictions-in-london.xlsx";
const UA = "TransitInstruments/0.1 (+london-bus-operator data pipeline)";

// Greater London (M25-ish) bounding box — matches accidents/stats19.
export const LONDON_BBOX = [-0.55, 51.25, 0.30, 51.71]; // [minLng, minLat, maxLng, maxLat]
const DEFAULT_TIMEOUT_MS = 60_000;

/* ── fetch helpers (timeout + abort) ───────────────────────────────────────── */
async function fetchBuffer(url, { timeoutMs = DEFAULT_TIMEOUT_MS, accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...(accept ? { Accept: accept } : {}) }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJson(url, opts) {
  const buf = await fetchBuffer(url, { ...opts, accept: "application/json" });
  return JSON.parse(buf.toString("utf8"));
}

/* ── resource discovery via the London Datastore dataset API ────────────────── */
/** Return the .xlsx/.csv resource URL for the bridges dataset (falls back to the known URL). */
export async function discoverResourceUrl({ timeoutMs, log } = {}) {
  try {
    const pkg = await fetchJson(DATASET_API, { timeoutMs });
    const resources = pkg && pkg.resources ? Object.values(pkg.resources) : [];
    // Prefer xlsx/csv; otherwise first resource with a url.
    const pick = resources.find((r) => /\.xlsx?$/i.test(r.url || "") || /\.csv$/i.test(r.url || "")) || resources.find((r) => r.url);
    if (pick && pick.url) {
      log?.info?.(`london-bridges: resource discovered → ${pick.url}`);
      return pick.url.trim();
    }
    log?.warn?.("london-bridges: dataset API returned no usable resource — using known fallback URL");
  } catch (e) {
    log?.warn?.(`london-bridges: resource discovery failed (${e.message}) — using known fallback URL`);
  }
  return FALLBACK_RESOURCE;
}

/* ── tiny dependency-free ZIP reader (stored + raw-deflate members) ─────────── */
/** Parse an .xlsx (ZIP) buffer → { "path": "<utf8 xml>" } for the members we need. */
function readZipMembers(buf, wanted) {
  const want = new Set(wanted);
  const out = {};
  let i = 0;
  while (i + 4 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break; // local file header signature; stop at central directory
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buf.toString("utf8", nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (want.has(name)) {
      out[name] = method === 0 ? data.toString("utf8") : zlib.inflateRawSync(data).toString("utf8");
    }
    i = dataStart + compSize;
  }
  return out;
}

/* ── minimal XLSX (SpreadsheetML) extraction ───────────────────────────────── */
const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** sharedStrings.xml → array of decoded strings (concatenating <t> runs per <si>). */
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
}

/** Excel column letters → 0-based index ("A"→0, "L"→11). */
function colIndex(ref) {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (let k = 0; k < letters.length; k++) n = n * 26 + (letters.charCodeAt(k) - 64);
  return n - 1;
}

/** sheet1.xml → array of rows, each an array of cell values (strings/numbers, sparse-filled). */
function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || "";
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const ci = refM ? colIndex(refM[1]) : cells.length;
      const typeM = /t="([^"]+)"/.exec(attrs);
      const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let val = vM ? decodeXml(vM[1]) : "";
      if (typeM && typeM[1] === "s") val = shared[Number(val)] ?? "";
      else if (typeM && typeM[1] === "str") val = decodeXml(val);
      cells[ci] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/* ── height band → metres (conservative lower bound) ───────────────────────── */
/**
 * Normalise a banded height string to numeric METRES, using the band's LOWER bound
 * (safe clearance). Handles metric bands ("Up to 3.0", "Between 4.6 and 5.1") and
 * imperial bands ("Up to 9'10\"", "Between 13'3\" and 14'9\""). Returns null if unparseable.
 */
export function heightToMetres(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Imperial: pull all ft'in" pairs; "Up to X" → X, "Between A and B" → A (lower).
  const ftin = [...s.matchAll(/(\d+)\s*'\s*(\d+)?\s*"?/g)].map((m) => Number(m[1]) + (m[2] ? Number(m[2]) : 0) / 12);
  if (ftin.length && /['"]/.test(s)) {
    const feet = Math.min(...ftin);            // lower bound = smallest pair
    return Math.round(feet * 0.3048 * 100) / 100;
  }
  // Metric: decimals in the string; lower bound = smallest.
  const nums = [...s.matchAll(/\d+(?:\.\d+)?/g)].map(Number).filter((n) => Number.isFinite(n));
  if (nums.length) return Math.round(Math.min(...nums) * 100) / 100;
  return null;
}

/* ── OSGB36 (EPSG:27700) easting/northing → WGS84 lat/lng (fallback only) ───── */
/** Standard Ordnance Survey transverse-Mercator inverse + Helmert OSGB36→WGS84. */
export function osgbToWgs84(E, N) {
  // Airy 1830 ellipsoid (OSGB36 datum).
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717, lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tan2 = tanLat * tanLat, tan4 = tan2 * tan2;
  const sec = 1 / cosLat;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan4 * tan2);
  const dE = E - E0, dE2 = dE * dE;
  let latA = lat - VII * dE2 + VIII * dE2 * dE2 - IX * dE2 * dE2 * dE2;
  let lonA = lon0 + X * dE - XI * dE * dE2 + XII * dE * dE2 * dE2 - XIIA * dE * dE2 * dE2 * dE2;

  // Helmert transform OSGB36 → WGS84 (cartesian).
  const toCart = (phi, lam, h, A, B) => {
    const ecc = 1 - (B * B) / (A * A);
    const v = A / Math.sqrt(1 - ecc * Math.sin(phi) ** 2);
    return [
      (v + h) * Math.cos(phi) * Math.cos(lam),
      (v + h) * Math.cos(phi) * Math.sin(lam),
      ((1 - ecc) * v + h) * Math.sin(phi),
    ];
  };
  let [x, y, z] = toCart(latA, lonA, 0, a, b);
  // OSGB36→WGS84 Helmert params.
  const tx = 446.448, ty = -125.157, tz = 542.06;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * (Math.PI / 180), ry = (0.247 / 3600) * (Math.PI / 180), rz = (0.8421 / 3600) * (Math.PI / 180);
  const x2 = tx + (1 + s) * x - rz * y + ry * z;
  const y2 = ty + rz * x + (1 + s) * y - rx * z;
  const z2 = tz - ry * x + rx * y + (1 + s) * z;

  // WGS84 cartesian → geodetic.
  const aW = 6378137.0, bW = 6356752.3142;
  const e2W = 1 - (bW * bW) / (aW * aW), ep2 = (aW * aW - bW * bW) / (bW * bW);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  const th = Math.atan2(z2 * aW, p * bW);
  const lonW = Math.atan2(y2, x2);
  const latW = Math.atan2(z2 + ep2 * bW * Math.sin(th) ** 3, p - e2W * aW * Math.cos(th) ** 3);
  return { lat: (latW * 180) / Math.PI, lng: (lonW * 180) / Math.PI };
}

const inBbox = (lng, lat, [minLng, minLat, maxLng, maxLat]) =>
  lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function classifyStructure(road, comments, imperial) {
  const t = `${road || ""} ${comments || ""}`.toLowerCase();
  if (/tunnel|subway|underpass/.test(t)) return "tunnel";
  if (/barrier|bollard|width|gate/.test(t)) return "barrier";
  return "bridge"; // the dataset is overwhelmingly low bridges
}

/**
 * Fetch + parse the EPOWR workbook into normalised bridge records inside the M25.
 * Returns { source, resourceUrl, bridges:[ {id,lat,lng,height_m,height_imperial,name,road,structure_type,borough} ] }.
 * Throws on a hard fetch/parse failure (caller keeps last-good / falls to sample).
 */
export async function fetchLondonBridges({ bbox = LONDON_BBOX, timeoutMs, log } = {}) {
  const resourceUrl = await discoverResourceUrl({ timeoutMs, log });
  const buf = await fetchBuffer(resourceUrl, { timeoutMs, accept: "application/octet-stream" });

  const members = readZipMembers(buf, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  const shared = parseSharedStrings(members["xl/sharedStrings.xml"]);
  const rows = parseSheet(members["xl/worksheets/sheet1.xml"] || "", shared);
  if (rows.length < 2) throw new Error(`workbook parsed to ${rows.length} rows — unexpected layout`);

  // Column order (A–L), validated against the header row.
  const COL = { heightM: 0, heightImp: 1, easting: 2, northing: 3, grid: 4, lat: 5, lng: 6, borough: 7, road: 8, roadNo: 9, tlrn: 10, comments: 11 };
  const hdr = rows[0].map((c) => String(c || "").toLowerCase());
  if (!hdr[COL.heightM]?.includes("height") || !hdr[COL.lat]?.includes("lat")) {
    log?.warn?.(`london-bridges: header mismatch (${hdr.join("|")}) — proceeding with positional columns`);
  }

  const bridges = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;

    let lat = Number(row[COL.lat]);
    let lng = Number(row[COL.lng]);
    // Fallback: derive from BNG easting/northing if WGS84 lat/lng absent.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const E = Number(row[COL.easting]), N = Number(row[COL.northing]);
      if (Number.isFinite(E) && Number.isFinite(N)) {
        const w = osgbToWgs84(E, N);
        lat = w.lat; lng = w.lng;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!inBbox(lng, lat, bbox)) continue;

    const heightImperial = (row[COL.heightImp] && String(row[COL.heightImp]).trim()) || null;
    const heightM = heightToMetres(row[COL.heightM]) ?? heightToMetres(heightImperial);
    const road = (row[COL.road] && String(row[COL.road]).trim()) || null;
    const roadNo = (row[COL.roadNo] && String(row[COL.roadNo]).trim()) || null;
    const borough = (row[COL.borough] && String(row[COL.borough]).trim()) || null;
    const comments = (row[COL.comments] && String(row[COL.comments]).trim()) || null;
    const grid = (row[COL.grid] && String(row[COL.grid]).trim()) || null;

    bridges.push({
      id: grid || `LBR-${String(r).padStart(4, "0")}`,
      lat: r6(lat),
      lng: r6(lng),
      height_m: heightM,
      height_imperial: heightImperial,
      name: road ? (roadNo ? `${road} (${roadNo})` : road) : (comments || null),
      road,
      structure_type: classifyStructure(road, comments, heightImperial),
      borough,
    });
  }

  return {
    source: "TfL / London Datastore — Bridges, Tunnels, Road Barriers & Height Restrictions (EPOWR)",
    resourceUrl,
    bridges,
  };
}
