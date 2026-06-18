/**
 * build/db-mirror.js — mirror the JSON store into the SQLite warehouse.
 *
 * Runs after the builders. Reads each dataset we produced this run and `observe`s
 * every entity into the change-data-capture DB (data/transit.db). Reference data
 * that hasn't changed adds only a cheap observation row (no duplicate snapshot);
 * time-series data (status) accrues a new snapshot whenever it changes.
 *
 * This is the PERIODIC capture path. The LIVE path (tool refreshes) hits the same
 * `observe` logic via the /ingest endpoint in serve.js — one CDC engine, two feeds.
 */

import { openDb } from "../lib/db.js";

export async function build(ctx) {
  const { sink, log } = ctx;
  const dbx = openDb();
  const runId = dbx.startRun("periodic", "pipeline db-mirror");
  const now = new Date().toISOString();
  const opt = { observedAt: now, kind: "periodic", runId };
  const summary = [];

  const mirror = (type, items) => {
    if (!items.length) return;
    const { seen, changed } = dbx.observeMany(type, items, opt);
    summary.push(`${type} ${seen}${changed ? ` (${changed}△)` : ""}`);
  };

  try {
    const routes = await sink.readDataset("routes");
    if (Array.isArray(routes)) mirror("route", routes.map((r) => ({ id: r.id, data: r })));

    const meta = await sink.readDataset("route-meta");
    if (meta?.routes) mirror("route_meta", Object.entries(meta.routes).map(([id, data]) => ({ id, data })));

    const stops = await sink.readDataset("route-stops");
    if (stops?.routes) mirror("route_stops", Object.entries(stops.routes).map(([id, data]) => ({ id, data })));

    const tenders = await sink.readDataset("tenders");
    if (tenders?.byId) mirror("tender", Object.entries(tenders.byId).map(([id, data]) => ({ id, data })));

    const garages = await sink.readDataset("garages");
    if (garages?.garages) mirror("garage", garages.garages.map((g) => ({ id: g.code, data: g })));

    const fleet = await sink.readDataset("fleet");
    if (fleet?.byRoute) mirror("fleet", Object.entries(fleet.byRoute).map(([id, data]) => ({ id, data })));

    // vehicle roster (reg→routes). CDC over this gives Relay the intraday move history.
    const vehicles = await sink.readDataset("vehicles");
    if (vehicles?.byReg) mirror("vehicle", Object.entries(vehicles.byReg).map(([id, data]) => ({ id, data })));

    const status = await sink.readDataset("line-status");
    if (status?.rows) mirror("line_status", status.rows.map((r) => ({ id: r.route, data: r })));

    const overview = await sink.readDataset("routes-overview", { ext: "geojson" });
    if (overview?.features) mirror("route_geometry", overview.features.map((f) => ({
      id: `${f.properties.routeId}:${f.properties.direction}`,
      data: { coords: f.geometry.coordinates, lengthKm: f.properties.lengthKm, stops: f.properties.stops },
    })));

    const s = dbx.stats();
    log.info(`db-mirror: ${summary.join(", ")}`);
    log.info(`warehouse: ${s.entities} entities · ${s.snapshots} snapshots · ${s.observations} observations`);
    return { source: "SQLite warehouse (CDC)", rows: s.entities, files: ["data/transit.db"], note: summary.join("; ") };
  } finally { dbx.close(); }
}
