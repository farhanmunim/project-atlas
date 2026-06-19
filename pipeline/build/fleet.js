/**
 * build/fleet.js — per-route live fleet, enriched + warehoused.
 *
 * Pipeline (so the app reads the DB, never the live API for this):
 *   1. TfL Line Arrivals → the vehicle registrations currently running each route.
 *   2. DVLA VES (if DVLA_API_KEY set) → make / year / fuel per reg, via a
 *      persisted reg-cache so a reg is only ever looked up once.
 *   3. Aggregate per route → { regs, count, avgAgeYears, propulsion mix, makes }.
 *
 * Output dataset `fleet`: { generatedAt, enriched, byRoute: { <name>: {...} } }.
 * db-mirror mirrors it into the warehouse (entity type `fleet`), serve.js exposes
 * /api/fleet, and Atlas reads it through the dataSource seam. Without a DVLA key
 * the regs + counts are still captured (enriched:false) — degrade, don't break.
 *
 * Cadence: fleet composition moves slowly, but the reg SAMPLE is live; a daily
 * pull accumulates coverage in the warehouse via CDC. Polite: concurrency-limited
 * arrivals, sequential rate-limited DVLA, cached.
 */

import { lineArrivals } from "../sources/tfl.js";
import { mapLimit } from "../lib/http.js";
import { hasKey, lookupMany } from "../sources/dvla.js";
import { rowsWithin, notAllNull, check } from "../lib/validate.js";
import { propulsionOf, cleanMake } from "../lib/normalize.js";

export async function build(ctx) {
  const { sink, log, args } = ctx;
  const routes = (await sink.readDataset("routes")) || [];
  const list = args.limit ? routes.slice(0, Number(args.limit)) : routes;
  const thisYear = new Date().getUTCFullYear();

  // 1 — collect current regs per route (live arrivals), concurrency-limited.
  const byRoute = {};
  const allRegs = new Set();
  await mapLimit(list, 5, async (r) => {
    try {
      const resp = await lineArrivals(r.id);
      const arr = Array.isArray(resp) ? resp : (resp?.data || []);   // getJson wraps the body in { data }
      const regs = [...new Set(arr.map((a) => a.vehicleId).filter(Boolean)
        .map((v) => String(v).replace(/\s+/g, "").toUpperCase()))];
      byRoute[r.name] = { route: r.name, regs, count: regs.length };
      regs.forEach((x) => allRegs.add(x));
    } catch (e) { byRoute[r.name] = { route: r.name, regs: [], count: 0 }; }
  });

  // 2 — DVLA enrichment (cached; no-op without a key).
  const enriched = hasKey();
  let cache = {}, dvla = { looked: 0, deferred: 0, stopped: false };
  if (enriched) {
    try { cache = (await sink.readDataset("fleet-dvla-cache"))?.byReg || {}; } catch { cache = {}; }
    // Backfill: look up not just the regs on the road THIS minute, but every reg we've
    // ever rostered (the `vehicles` dataset) that isn't cached yet — so newly-observed
    // plates fill in regardless of whether they happen to be running right now. Still
    // bounded by the per-run cap + 429 backoff inside lookupMany.
    let rosterRegs = [];
    try { rosterRegs = Object.keys((await sink.readDataset("vehicles"))?.byReg || {}); } catch { rosterRegs = []; }
    const lookupSet = new Set([...allRegs, ...rosterRegs]);
    dvla = await lookupMany([...lookupSet], cache);   // bounded + 429-safe; mutates cache
    cache = dvla.cache;
    await sink.writeDataset("fleet-dvla-cache", { generatedAt: new Date().toISOString(), byReg: cache });   // persist partial progress
  }

  // 3 — aggregate per route.
  for (const k of Object.keys(byRoute)) {
    const e = byRoute[k];
    if (enriched && e.regs.length) {
      const prop = { electric: 0, hydrogen: 0, hybrid: 0, diesel: 0 };
      const makes = {}; let ageSum = 0, ageN = 0;
      for (const reg of e.regs) {
        const v = cache[reg]; if (!v) continue;
        const p = propulsionOf(v.fuel); if (p) prop[p]++;
        const mk = cleanMake(v.make); if (mk) makes[mk] = (makes[mk] || 0) + 1;
        if (v.year && v.year >= 1990 && v.year <= thisYear) { ageSum += thisYear - v.year; ageN++; }
      }
      e.avgAgeYears = ageN ? +(ageSum / ageN).toFixed(1) : null;
      e.propulsion = prop;
      e.makes = Object.entries(makes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([make, n]) => ({ make, n }));
      e.enriched = ageN;
    }
  }

  const withVehicles = Object.values(byRoute).filter((e) => e.count).length;
  // ~676 routes have a fleet row; floor well below that catches an arrivals outage
  // that returned an empty/near-empty map (skip when --limit caps the run in dev).
  if (!args.limit) {
    rowsWithin(Object.values(byRoute), 400, undefined, "fleet routes");
    // and at least one route must actually have live vehicles — an all-zero run
    // (every arrivals call failed) must not overwrite the last-good live sample.
    notAllNull(Object.values(byRoute).filter((e) => e.count > 0), "count", "fleet counts");
    check(withVehicles > 0, "fleet: no route has any live vehicles — refusing to overwrite last-good");
  }
  await sink.writeDataset("fleet", { generatedAt: new Date().toISOString(), enriched, byRoute });
  const dvNote = enriched
    ? ` · DVLA: ${dvla.looked} looked up${dvla.deferred ? `, ${dvla.deferred} deferred to next run` : ""}${dvla.stopped ? " (stopped on rate-limit)" : ""}`
    : " · no DVLA key (regs only)";
  log.info(`fleet: ${list.length} routes · ${withVehicles} with live vehicles · ${allRegs.size} regs${dvNote}`);
  return { source: "TfL Line Arrivals" + (enriched ? " + DVLA VES" : ""), rows: Object.keys(byRoute).length, files: ["data/fleet.json"], note: `${withVehicles} routes with vehicles${enriched ? ", DVLA-enriched" : ""}` };
}
