/**
 * build/routes.js — the route datasets that feed Atlas (and Cohort/Mandate later).
 *
 * Produces three normalised store datasets from TfL:
 *   routes                  → [{ id, name, type }]                 (left-rail list)
 *   route-classifications   → { [id]: { type, ... } }              (filter metadata)
 *   routes-overview         → GeoJSON FeatureCollection, simplified (the whole-
 *                             network map layer — both directions per route)
 *
 * Geometry is fetched per route+direction with bounded concurrency, simplified
 * (Ramer–Douglas–Peucker) and coordinate-rounded for the overview, then cached.
 * `--limit N` (dev) caps how many routes fetch geometry; production runs all.
 *
 * Shapes here MUST match what the tools' dataSource seam returns, so flipping a
 * tool from backend "tfl" → "store" is a no-op for its render code.
 */

import * as tfl from "../sources/tfl.js";
import { mapLimit } from "../lib/http.js";
import { simplify, roundRing, lengthKm } from "../lib/geo.js";
import { rowsWithin, everyHas, notAllNull, check } from "../lib/validate.js";
import { overrideFor } from "../lib/overrides.js";

/** Route type — london-buses scheme: regular | night | twentyfour | school.
 *  24-hour isn't in any free feed → set via overrides.json (applied by the caller). */
export function deriveType(name) {
  if (/^N/i.test(name)) return "night";
  if (/^[69]\d\d$/.test(name)) return "school";
  return "regular";
}

function parseLineStrings(raw) {
  try {
    const ls = raw.lineStrings && raw.lineStrings[0] ? JSON.parse(raw.lineStrings[0]) : [];
    return Array.isArray(ls[0]?.[0]) ? ls[0] : ls; // → [[lng,lat], …]
  } catch { return []; }
}

/** Ordered, de-duplicated stops for one sequence (same call as the geometry). */
function extractStops(raw) {
  const seen = new Set(), out = [];
  (raw.stopPointSequences || []).forEach((sps) =>
    (sps.stopPoint || []).forEach((p) => {
      if (seen.has(p.id)) return; seen.add(p.id);
      out.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lon, lines: (p.lines || []).map((l) => l.name) });
    }));
  return out;
}

export async function build(ctx) {
  const { sink, log, args, cmpRoute } = ctx;

  // 1) route list ----------------------------------------------------------
  const linesRes = await tfl.busLines();
  const rawLines = linesRes.data || [];
  const routes = rawLines
    .map((l) => ({ id: l.id, name: l.name, type: overrideFor(l.name).type || deriveType(l.name) }))
    .sort((a, b) => cmpRoute(a.name, b.name));
  rowsWithin(routes, 400, 2000, "routes");          // London has ~676; sanity band
  everyHas(routes, ["id", "name", "type"], "routes");

  // 2) classifications -----------------------------------------------------
  const classifications = {};
  for (const r of routes) classifications[r.id] = { name: r.name, type: r.type };

  // 3) overview geometry ---------------------------------------------------
  const limit = args.limit ? Number(args.limit) : routes.length;
  const subset = routes.slice(0, limit);
  if (limit < routes.length) log.warn(`geometry limited to ${limit}/${routes.length} routes (--limit) — overview is partial`);

  const features = [];
  const routeStops = {};                 // { [routeId]: { outbound:[…], inbound:[…] } }
  let geomOk = 0, geomFail = 0, doneCount = 0;
  const total = subset.length;
  await mapLimit(subset, 10, async (r) => {
    for (const [dir, code] of [["outbound", "1"], ["inbound", "2"]]) {
      try {
        const res = await tfl.routeSequence(r.id, dir);
        const stops = extractStops(res.data);
        if (stops.length) { (routeStops[r.id] ||= {})[dir] = stops; }   // same call → free
        const ring = parseLineStrings(res.data);
        if (ring.length < 2) continue;
        const simplified = roundRing(simplify(ring, 0.0005), 4);
        features.push({
          type: "Feature",
          properties: { routeId: r.id, name: r.name, direction: code, routeType: r.type, lengthKm: Math.round(lengthKm(ring) * 10) / 10, stops: stops.length },
          geometry: { type: "LineString", coordinates: simplified },
        });
        geomOk++;
      } catch (e) { geomFail++; /* one route failing must not abort the run */ }
    }
    if (++doneCount % 50 === 0 || doneCount === total) log.info(`  geometry ${doneCount}/${total} routes (ok ${geomOk}, failed ${geomFail})`);
  });
  notAllNull(features, "geometry", "overview features");
  // ~676 routes × 2 directions → ~1,350 features on a full run; floor well below
  // that catches a partial upstream outage that returned a near-empty FeatureCollection.
  // (skip the floor when --limit deliberately caps the run in dev)
  if (limit >= routes.length) {
    rowsWithin(features, 800, undefined, "overview features");
    // a run where >30% of routes lost geometry is an upstream outage, not normal noise
    const attempted = geomOk + geomFail;
    check(attempted === 0 || geomFail / attempted <= 0.3,
      `overview geometry: ${geomFail}/${attempted} routes lost geometry (>30%) — refusing to overwrite last-good`);
  }

  const overview = {
    type: "FeatureCollection",
    metadata: { generatedAt: new Date().toISOString(), routeCount: subset.length, featureCount: features.length, partial: limit < routes.length, simplificationTolerance: 0.0005, coordinatePrecision: 4 },
    features,
  };

  // 4) write ---------------------------------------------------------------
  await sink.writeDataset("routes", routes);
  await sink.writeDataset("route-classifications", classifications);
  await sink.writeDataset("routes-overview", overview, { ext: "geojson" });
  // floor on route-stops too — a near-empty stops map means the sequence calls
  // failed wholesale; don't overwrite a good stops file (skip when --limit in dev).
  if (limit >= routes.length) rowsWithin(Object.keys(routeStops), 400, undefined, "route-stops routes");
  await sink.writeDataset("route-stops", { generatedAt: new Date().toISOString(), routes: routeStops });

  log.info(`routes: ${routes.length} · overview features: ${features.length} (ok ${geomOk}, failed ${geomFail}) · stops for ${Object.keys(routeStops).length} routes`);
  return {
    source: "TfL Unified API · /Line/Mode/bus + /Route/Sequence",
    rows: routes.length,
    files: ["data/routes.json", "data/route-classifications.json", "data/routes-overview.geojson", "data/route-stops.json"],
    note: limit < routes.length ? `partial geometry (${limit}/${routes.length})` : undefined,
  };
}
