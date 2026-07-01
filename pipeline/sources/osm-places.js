/**
 * sources/osm-places.js — OSM locality names for Greater London (Overpass API).
 *
 * place=town|suburb nodes with a name inside the London bbox — the map's
 * place-name label layer, so main areas (Stratford, Bow, Mile End…) read at
 * route-fit zoom without zooming in. The raster basemap only surfaces these
 * labels several zoom levels deeper, hence our own layer.
 *
 *   endpoint  GET https://overpass-api.de/api/interpreter?data=<overpass QL>
 *   cadence   MONTHLY (place names barely change) — see config.js ttl
 *   licence   OSM via Overpass — ODbL; attributed in the dataset + API docs
 *
 * Robust: single bounded query (no paging), hard timeout, retries via lib/http.
 */

import { getJson } from "../lib/http.js";

const OVERPASS = "https://overpass-api.de/api/interpreter";
// south,west,north,east — the same Greater London bbox the apps + BODS pull use
const BBOX = "51.25,-0.55,51.71,0.30";
const QUERY = `[out:json][timeout:120];(node["place"~"^(town|suburb)$"]["name"](${BBOX}););out body;`;

/** → [{ name, lat, lng, kind:"town"|"suburb" }] (raw; build/localities.js cleans/validates) */
export async function fetchPlaces(opts = {}) {
  const { data } = await getJson(`${OVERPASS}?data=${encodeURIComponent(QUERY)}`, { conditional: false, timeoutMs: 130_000, ...opts });
  const out = [];
  for (const el of data.elements || []) {
    const name = el.tags && el.tags.name;
    const lat = +el.lat, lng = +el.lon;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ name: String(name).trim(), lat, lng, kind: el.tags.place === "town" ? "town" : "suburb" });
  }
  return out;
}
