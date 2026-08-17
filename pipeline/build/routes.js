/**
 * build/routes.js — the route datasets that feed Atlas (and Cohort/Mandate later).
 *
 * Produces four normalised store datasets from TfL:
 *   routes                  → [{ id, name, type }]                 (left-rail list)
 *   route-classifications   → { [id]: { type, ... } }              (filter metadata)
 *   routes-overview         → GeoJSON FeatureCollection, simplified (the whole-
 *                             network map layer — both directions per route)
 *   route-geometry/<id>     → per-route FULL-FIDELITY geometry (TfL's raw ring,
 *                             5-dp rounded, both directions) — what the apps draw
 *                             when a route is selected, so the line is faithful
 *                             to the road path, not the overview simplification
 *
 * Geometry is fetched per route+direction with bounded concurrency; the raw ring
 * feeds the per-route detailed file, and a Ramer–Douglas–Peucker–simplified,
 * coordinate-rounded copy feeds the overview (0.0001° ≈ 11 m — keeps ~31% of
 * points; fidelity chosen empirically so the network layer still follows roads).
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

export function parseLineStrings(raw) {
  try {
    const ls = raw.lineStrings && raw.lineStrings[0] ? JSON.parse(raw.lineStrings[0]) : [];
    return Array.isArray(ls[0]?.[0]) ? ls[0] : ls; // → [[lng,lat], …]
  } catch { return []; }
}

/** Ordered, de-duplicated stops for one sequence (same call as the geometry).
 *  letter = the physical stop-flag letter (TfL stopLetter, e.g. "A") — what
 *  disambiguates two same-named stops ("Upton Park Station → A" vs "→ B");
 *  null where the flag carries no letter (many outer-London poles). */
export function extractStops(raw) {
  const seen = new Set(), out = [];
  (raw.stopPointSequences || []).forEach((sps) =>
    (sps.stopPoint || []).forEach((p) => {
      if (seen.has(p.id)) return; seen.add(p.id);
      out.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lon, letter: p.stopLetter || null, lines: (p.lines || []).map((l) => l.name) });
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
  const detailByRoute = {};              // { [routeId]: { "1": {coordinates, lengthKm}, "2": … } } — raw rings
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
        const km = Math.round(lengthKm(ring) * 10) / 10;
        // full fidelity for the per-route file (5 dp ≈ 1 m); simplified for the overview
        (detailByRoute[r.id] ||= {})[code] = { coordinates: roundRing(ring, 5), lengthKm: km };
        const simplified = roundRing(simplify(ring, 0.0001), 5);
        features.push({
          type: "Feature",
          properties: { routeId: r.id, name: r.name, direction: code, routeType: r.type, lengthKm: km, stops: stops.length },
          geometry: { type: "LineString", coordinates: simplified },
        });
        geomOk++;
      } catch (e) { geomFail++; /* one route failing must not abort the run */ }
    }
    if (++doneCount % 50 === 0 || doneCount === total) log.info(`  geometry ${doneCount}/${total} routes (ok ${geomOk}, failed ${geomFail})`);
  });
  // ── diversion freeze ─────────────────────────────────────────────────────
  // Routes on an active diversion keep their LAST-GOOD canonical stops + geometry:
  // TfL temporarily rewrites Route/Sequence to the diverted state, and absorbing
  // that here would silently replace the baseline that build/diversions.js diffs
  // against (and that the map renders as "the route"). The diverted sequence is
  // captured separately in route-diversions.json. Self-healing: when the episode
  // ends the route leaves the flagged set and the next run writes TfL's fresh
  // sequence — permanent changes land at most one run late.
  // The flagged set comes from build/diversions.js (same run, runs first); if it
  // didn't run (--only=routes) fall back to the last-good diversions file.
  let frozen = ctx.divertedRoutes;
  if (!frozen) {
    const dv = await sink.readDataset("route-diversions");
    frozen = new Set([...Object.values(dv?.routes || {}).map((e) => e.id), ...(dv?.upcomingFreeze || [])].filter(Boolean));
  }
  if (frozen.size) {
    const prevStops = await sink.readDataset("route-stops");
    const prevGeo = await sink.readDataset("routes-overview", { ext: "geojson" });
    const prevFeats = {};
    for (const f of prevGeo?.features || []) (prevFeats[f.properties.routeId] ||= []).push(f);
    let keptStops = 0, keptGeom = 0;
    for (const id of frozen) {
      if (prevStops?.routes?.[id]) { routeStops[id] = prevStops.routes[id]; keptStops++; }
      if (prevFeats[id]?.length) {
        for (let i = features.length - 1; i >= 0; i--) if (features[i].properties.routeId === id) features.splice(i, 1);
        features.push(...prevFeats[id]);
        keptGeom++;
      }
    }
    // Detailed geometry freeze — but smarter than the overview's blanket keep: the
    // diversions builder just diffed TfL's current sequence against the canonical
    // baseline. If it found NO structural change (no missed/added stops, no published
    // redraw), TfL's current ring IS the canonical line and is safe to write in full
    // fidelity. Only routes where TfL has actually altered the sequence — or that sit
    // in the upcoming-freeze window (TfL redraws early) — withhold their detail file
    // (existing files stay last-good; absent files fall back to the frozen overview).
    const dvData = await sink.readDataset("route-diversions");
    const structurallyChanged = new Set(dvData?.upcomingFreeze || []);
    for (const e of Object.values(dvData?.routes || {})) {
      const touched = ["missedStops", "addedStops"].some((k) => Object.values(e[k] || {}).some((a) => a && a.length));
      if (touched || e.geometryStatus === "published") structurallyChanged.add(e.id);
    }
    let detailKept = 0, detailHeld = 0;
    for (const id of frozen) {
      if (structurallyChanged.has(id)) { delete detailByRoute[id]; detailHeld++; }
      else if (detailByRoute[id]) detailKept++;
    }
    log.info(`  diversion freeze: ${frozen.size} routes flagged — kept last-good stops for ${keptStops}, geometry for ${keptGeom}; detail written for ${detailKept} unchanged, withheld for ${detailHeld} structurally-changed`);
  }

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
    metadata: { generatedAt: new Date().toISOString(), routeCount: subset.length, featureCount: features.length, partial: limit < routes.length, simplificationTolerance: 0.0001, coordinatePrecision: 5 },
    features,
  };

  // route-destinations — the termini per route/direction ("Beckton Station → East
  // Ham" list labels), derived from the FINAL (post-freeze) stop sequences so
  // diverted routes keep their canonical termini. Zero extra fetches.
  const destinations = {};
  for (const [id, dirs] of Object.entries(routeStops)) {
    const name = routes.find((r) => r.id === id)?.name ?? id.toUpperCase();
    const ends = (list) => (list && list.length >= 2 ? { origin: list[0].name, destination: list[list.length - 1].name } : null);
    const o = ends(dirs.outbound), i = ends(dirs.inbound);
    if (o || i) destinations[id] = { name, ...(o ? { outbound: o } : {}), ...(i ? { inbound: i } : {}) };
  }
  if (limit >= routes.length) rowsWithin(Object.keys(destinations), 400, undefined, "route-destinations routes");

  // 4) write ---------------------------------------------------------------
  await sink.writeDataset("routes", routes);
  await sink.writeDataset("route-classifications", classifications);
  await sink.writeDataset("route-destinations", { generatedAt: new Date().toISOString(), source: "derived — first/last stop of each direction's canonical sequence", routes: destinations });
  await sink.writeDataset("routes-overview", overview, { ext: "geojson" });
  // per-route full-fidelity geometry (one small file per route, lazy-loaded by the
  // apps on selection). Frozen routes were removed above so last-good files persist.
  let detailWritten = 0;
  for (const [id, dirs] of Object.entries(detailByRoute)) {
    if (!dirs["1"] && !dirs["2"]) continue;
    await sink.writeDataset(`route-geometry/${id}`, { generatedAt: new Date().toISOString(), routeId: id, directions: dirs });
    detailWritten++;
  }
  if (limit >= routes.length) {
    rowsWithin(Object.keys(detailByRoute), 400, undefined, "route-geometry files");
    // prune per-route files for routes TfL no longer registers (full runs only,
    // and never while that id sits in the freeze set)
    const keep = new Set(routes.map((r) => r.id));
    const { readdirSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { DATA_DIR } = await import("../lib/store.js");
    try {
      for (const f of readdirSync(join(DATA_DIR, "route-geometry"))) {
        const id = f.replace(/\.json$/, "");
        if (f.endsWith(".json") && !keep.has(id) && !frozen.has(id)) unlinkSync(join(DATA_DIR, "route-geometry", f));
      }
    } catch {}
  }
  // floor on route-stops too — a near-empty stops map means the sequence calls
  // failed wholesale; don't overwrite a good stops file (skip when --limit in dev).
  if (limit >= routes.length) rowsWithin(Object.keys(routeStops), 400, undefined, "route-stops routes");
  await sink.writeDataset("route-stops", { generatedAt: new Date().toISOString(), routes: routeStops });

  log.info(`routes: ${routes.length} · overview features: ${features.length} (ok ${geomOk}, failed ${geomFail}) · detailed geometry files: ${detailWritten} · stops for ${Object.keys(routeStops).length} routes`);
  return {
    source: "TfL Unified API · /Line/Mode/bus + /Route/Sequence",
    rows: routes.length,
    files: ["data/routes.json", "data/route-classifications.json", "data/route-destinations.json", "data/routes-overview.geojson", "data/route-geometry/<id>.json", "data/route-stops.json"],
    note: limit < routes.length ? `partial geometry (${limit}/${routes.length})` : `detailed geometry for ${detailWritten} routes`,
  };
}
