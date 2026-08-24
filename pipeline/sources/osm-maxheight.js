/**
 * sources/osm-maxheight.js — OSM height-restriction tags for Greater London.
 *
 *   endpoint  GET https://overpass-api.de/api/interpreter?data=<overpass QL>
 *   licence   ODbL — © OpenStreetMap contributors
 *   cadence   community-maintained (live); we pull once per daily build
 *
 * Why: the authoritative TfL/OS EPOWR height-restrictions workbook has not been
 * refreshed upstream since 2019 (Last-Modified audited 2026-08-19), while OSM's
 * maxheight tags are actively maintained. This source does NOT replace EPOWR —
 * it cross-checks it (build/bridges.js attaches the nearest OSM reading to each
 * EPOWR structure) and contributes restrictions OSM knows that EPOWR predates.
 *
 * maxheight lives on the WAY passing under a structure, so one physical bridge
 * is often several tagged way segments — callers get a deduped cluster list.
 */

import { getJson } from "../lib/http.js";

/* Overpass rejects/times out long GET query strings under load, but the same query
   as a POST body answers in seconds — so this source POSTs (unlike osm-places'
   lighter GET query, which fits comfortably in a URL). */
async function postOverpass(host, query, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(host, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "TransitInstruments/0.1 (+london-bus-operator data pipeline)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`POST ${host} → HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// main instance first; the Kumi Systems public mirror picks up its transient 503s
const OVERPASS_HOSTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const BBOX = "51.25,-0.55,51.71,0.30";   // same Greater London bbox as osm-places
// Ways only, restricted to drivable public road classes — maxheight also tags
// car-park barriers, service roads and footpaths, which are noise for a bus
// network (a bus never meets a car-park height bar). Nodes are skipped for the
// same reason: a bare maxheight node is almost always a barrier=height_restrictor.
const HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const QUERY = `[out:json][timeout:150];way["maxheight"]["highway"~"^(${HIGHWAYS})$"](${BBOX});out center tags;`;

/** "4.1" | "4.1 m" | "13'6\"" | "13ft 6in" → metres, else null ("default"/"none"/junk). */
export function parseMaxheight(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || /^(default|none|unsigned|no)$/.test(s)) return null;
  const imp = s.match(/^(\d+)\s*(?:'|ft)\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?$/);
  if (imp) {
    const m = (+imp[1] + (+imp[2] || 0) / 12) * 0.3048;
    return +m.toFixed(2);
  }
  const met = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|meter|metre)?s?$/);
  if (met) {
    const m = +met[1];
    return m >= 1 && m <= 8 ? +m.toFixed(2) : null;   // outside 1–8 m isn't a road clearance
  }
  return null;
}

const distM = (aLat, aLng, bLat, bLng) => {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dl = toR(bLat - aLat), dn = toR(bLng - aLng);
  const x = Math.sin(dl / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/**
 * → [{ lat, lng, heightM, name, ref }] — deduped: tagged segments within 60 m at
 * the same parsed height collapse to one point (centroid of the cluster).
 */
export async function fetchMaxheights(opts = {}) {
  let data, lastErr;
  // OSM_MAXHEIGHT_FILE: dev-only fixture (a saved Overpass JSON response) so the
  // enrichment logic can be validated offline / when Overpass is congested.
  if (process.env.OSM_MAXHEIGHT_FILE) {
    const { readFileSync } = await import("node:fs");
    data = JSON.parse(readFileSync(process.env.OSM_MAXHEIGHT_FILE, "utf8"));
  }
  for (const host of OVERPASS_HOSTS) {
    if (data) break;
    try { data = await postOverpass(host, QUERY, 160_000); }
    catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr;
  const hwRe = new RegExp(`^(${HIGHWAYS})$`);
  const raw = [];
  for (const el of data.elements || []) {
    if (!el.tags || !hwRe.test(el.tags.highway || "")) continue;   // drivable public roads only (also filters fixtures)
    const heightM = parseMaxheight(el.tags.maxheight);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (heightM == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    raw.push({ lat: +lat, lng: +lng, heightM, name: (el.tags.name || "").trim() || null, ref: el.tags.ref || null });
  }
  // cluster: same height within 60 m → one point
  const out = [];
  for (const r of raw) {
    const hit = out.find((o) => o.heightM === r.heightM && distM(o.lat, o.lng, r.lat, r.lng) < 60);
    if (hit) {
      hit.lat = (hit.lat * hit._n + r.lat) / (hit._n + 1);
      hit.lng = (hit.lng * hit._n + r.lng) / (hit._n + 1);
      hit._n++;
      if (!hit.name && r.name) hit.name = r.name;
    } else out.push({ ...r, _n: 1 });
  }
  for (const o of out) delete o._n;
  return out;
}

export { distM };
