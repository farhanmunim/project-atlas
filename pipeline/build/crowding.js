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

  let summary, profile;
  if (live) {
    ({ summary, profile } = finalise(live));
  } else if (prev && prev.routes && Object.keys(prev.routes).length >= MIN_ROUTES) {
    log.info("crowding: keeping last-good data");
    summary = { ...prev, generatedAt: new Date().toISOString() };
    profile = (await sink.readDataset("crowding-profile")) || null;   // keep the matching last-good profile
  } else {
    throw new Error("crowding: no live data and no last-good to fall back to");
  }

  // Hard gate: route count within sane bounds (a cratered pull throws → last-good kept).
  rowsWithin(Object.keys(summary.routes), MIN_ROUTES, MAX_ROUTES, "crowding routes");

  // Two files: a LIGHT per-route summary (band/peak — the network colour layer + dossier headline),
  // and a HEAVY per-route profile (load-along-route + time-of-day curve) loaded only on route select.
  await sink.writeDataset("crowding", summary, { pretty: false });
  if (profile) await sink.writeDataset("crowding-profile", profile, { pretty: false });

  const crowded = Object.values(summary.routes).filter((r) => r.band === "crowded").length;
  const note = `${summary.count} routes · ${summary.year} · crowded(≥0.8 V/C)=${crowded}`;
  log.info(`crowding: ${note}`);
  return { source: summary.source, rows: summary.count, files: ["data/crowding.json", "data/crowding-profile.json"], note };
}

function slimDay(rec) {
  if (!rec) return undefined;
  return { vc: rec.vc, load: rec.load, capacity: rec.capacity, time: rec.time, stopname: rec.stopname };
}
const r3 = (n) => Math.round(n * 1000) / 1000;

// Load-along-route (the "where"): the busiest direction's stops in sequence, each at its
// all-day max V/C — drives the corridor crowding gradient + the load-profile chart.
function loadProfileOf(a, peakDir) {
  return Object.values(a.stopMax || {})
    .filter((s) => s.dir === peakDir)
    .sort((x, y) => x.seq - y.seq)
    .map((s) => ({ seq: s.seq, name: s.name, vc: r3(s.vc) }));
}
// Time-of-day curve (the "when"): per day type, the timebands in CHRONOLOGICAL order with the
// peak V/C + hour (sorted by clock time — the timeband index isn't time-ordered).
function timeOfDayOf(a) {
  const out = {};
  for (const day of ["Weekday", "Saturday", "Sunday"]) {
    const pts = Object.values(a.timeMax || {})
      .filter((x) => x.dayType === day)
      .map((x) => ({ t: String(x.t).slice(0, 5), vc: r3(x.vc) }))
      .sort((x, y) => x.t.localeCompare(y.t));
    if (pts.length) out[day] = pts;
  }
  return out;
}

function finalise(live) {
  const routes = {};        // light summary (network colour + dossier headline)
  const profiles = {};      // heavy per-route detail (loaded on route select)
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
    profiles[a.route] = {
      profileDir: p.direction,                 // direction the load profile is for (the busiest)
      loadProfile: loadProfileOf(a, p.direction),   // the "where" — V/C by stop in sequence
      timeOfDay: timeOfDayOf(a),               // the "when" — V/C curve by day type
    };
  }
  const meta = { generatedAt: live.generatedAt, source: live.source, year: live.year, sourceFile: live.sourceFile, count: Object.keys(routes).length };
  const bands = CROWDING_BANDS.map((b) => ({ key: b.key, label: b.label, max: b.max === Infinity ? null : b.max }));
  return {
    summary: { ...meta, bands, routes },
    profile: { ...meta, routes: profiles },
  };
}
