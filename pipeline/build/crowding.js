/**
 * build/crowding.js — Atlas bus-crowding layer (TfL BUSTO).
 *
 * Source: TfL BUSTO "MAX DEMAND HOUR BY ROUTE BY TIMEBAND" (sources/busto.js), streamed
 * and reduced to ONE record per route: the busiest point (peak V/C = load ÷ capacity at
 * the max-demand hour), banded comfortable→crowded, plus the per-day-type peak. Powers the
 * Crowding map layer + the route dossier's Crowding readout. Cadence: ANNUAL.
 *
 * If the source is unreachable we keep last-good (never overwrite a good file with empty).
 *
 * Output (data/crowding.json):
 *   { generatedAt, source, year, sourceFile, count, bands:[{key,label,max}],
 *     routes: { [routeName]: {
 *        peakVC, band, load, capacity, seats, boardings, dayType, time, timeband,
 *        direction, stopcode, stopname, stopSeq, maxLoad, maxCapacity,
 *        byDay: { Weekday|Saturday|Sunday: { vc, load, capacity, time, stopname } } } } }
 */

import { fetchBusto, CROWDING_BANDS, bandOf } from "../sources/busto.js";
import { rowsWithin } from "../lib/validate.js";

const MIN_ROUTES = 300;     // London has ~600+ bus routes in BUSTO; below this = degraded pull
const MAX_ROUTES = 2000;    // sanity upper bound

export async function build(ctx) {
  const { sink, log } = ctx;
  const prev = (await sink.readDataset("crowding")) || null;

  let live = null;
  try {
    const r = await fetchBusto({ log });
    if (r.routes.length >= MIN_ROUTES) live = r;
    else log.warn(`crowding: live pull thin (${r.routes.length} < ${MIN_ROUTES}) — keeping last-good`);
  } catch (e) {
    log.warn(`crowding: live BUSTO failed (${e.message}) — keeping last-good`);
  }

  let data;
  if (live) {
    data = finalise(live);
  } else if (prev && prev.routes && Object.keys(prev.routes).length >= MIN_ROUTES) {
    log.info("crowding: keeping last-good data");
    data = { ...prev, generatedAt: new Date().toISOString() };
  } else {
    throw new Error("crowding: no live data and no last-good to fall back to");
  }

  // Hard gate: route count within sane bounds (a cratered pull throws → last-good kept).
  rowsWithin(Object.keys(data.routes), MIN_ROUTES, MAX_ROUTES, "crowding routes");

  await sink.writeDataset("crowding", data, { pretty: false });

  const crowded = Object.values(data.routes).filter((r) => r.band === "crowded").length;
  const note = `${data.count} routes · ${data.year} · crowded(≥0.8 V/C)=${crowded}`;
  log.info(`crowding: ${note}`);
  return { source: data.source, rows: data.count, files: ["data/crowding.json"], note };
}

function slimDay(rec) {
  if (!rec) return undefined;
  return { vc: rec.vc, load: rec.load, capacity: rec.capacity, time: rec.time, stopname: rec.stopname };
}

function finalise(live) {
  const routes = {};
  for (const a of live.routes) {
    const p = a.peak;
    if (!p) continue;
    const byDay = {};
    for (const k of Object.keys(a.byDay)) byDay[k] = slimDay(a.byDay[k]);
    routes[a.route] = {
      peakVC: p.vc,
      band: bandOf(p.vc),
      load: p.load, capacity: p.capacity, seats: p.seats, boardings: p.boardings,
      dayType: p.dayType, time: p.time, timeband: p.timeband, direction: p.direction,
      stopcode: p.stopcode, stopname: p.stopname, stopSeq: p.stopSeq,
      maxLoad: a.maxLoad, maxCapacity: a.maxCapacity,
      byDay,
    };
  }
  return {
    generatedAt: live.generatedAt,
    source: live.source,
    year: live.year,
    sourceFile: live.sourceFile,
    count: Object.keys(routes).length,
    bands: CROWDING_BANDS.map((b) => ({ key: b.key, label: b.label, max: b.max === Infinity ? null : b.max })),
    routes,
  };
}
