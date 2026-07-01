/**
 * build/localities.js — locality labels (London towns + suburbs) for the map.
 *
 * Fetch (OSM Overpass, sources/osm-places.js) → Clean (name + coord validation,
 * bbox clamp, dedupe) → Validate (row floor as a hard gate) → Store
 * data/localities.json. Powers the apps' "Place names" layer so main areas /
 * town centres are readable at route-fit zoom. Cadence: monthly.
 */

import { fetchPlaces } from "../sources/osm-places.js";
import { rowsWithin } from "../lib/validate.js";

export async function build(ctx) {
  const { sink, log } = ctx;
  const raw = await fetchPlaces();

  const seen = new Set();
  const rows = [];
  for (const p of raw) {
    if (p.lat < 51.2 || p.lat > 51.8 || p.lng < -0.6 || p.lng > 0.4) continue;   // clamp to the map bbox
    if (!p.name || p.name.length > 60) continue;
    const key = p.name.toLowerCase() + "|" + p.lat.toFixed(2) + "," + p.lng.toFixed(2);   // same name in the same ~1km cell = dupe
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name: p.name, lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), kind: p.kind });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  rowsWithin(rows, 300, undefined, "localities");   // hard gate — a thin pull never overwrites last-good
  await sink.writeDataset("localities", {
    generatedAt: new Date().toISOString(),
    source: "OpenStreetMap via Overpass API (ODbL) — place=town|suburb, Greater London",
    count: rows.length,
    localities: rows,
  });
  log.info(`localities: ${rows.length} places (${rows.filter((r) => r.kind === "town").length} towns)`);
  return { source: "OSM Overpass (place=town|suburb)", rows: rows.length, files: ["data/localities.json"] };
}
