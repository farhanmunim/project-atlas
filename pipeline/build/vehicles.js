/**
 * build/vehicles.js — vehicle roster, inverted from `fleet`. [Relay scaffold]
 *
 * `fleet` is route→regs (which vehicles are on each route now). This inverts it to
 * reg→routes: a fleet roster keyed by registration, with the operator (from the
 * route's meta) and any DVLA attributes we've already cached (make/year/fuel). It is
 * the seed of vehicle-level analysis — the "which vehicle is on which route" index
 * the London Vehicle Finder exposes, and the foundation Relay builds on.
 *
 * No new API calls: derived purely from the `fleet` dataset + the DVLA reg cache, so
 * it's free to run every time `fleet` updates. INTRADAY MOVES (a vehicle that swaps
 * routes during the day) fall out of the warehouse automatically — every run snapshots
 * this vehicle→routes mapping via CDC, so comparing snapshots over a day yields the
 * move history (a Relay query, not a builder). Full run/block-level assignment needs
 * BODS SIRI-VM (see sources/bods.js) — wired in when Relay is built.
 */

import { rowsWithin } from "../lib/validate.js";
import { cleanMake, propulsionOf } from "../lib/normalize.js";
import { lookupVehicle, MISS_RECHECK_DAYS } from "../sources/bustimes.js";

// Per-run cap on NEW bustimes lookups — coverage accrues across daily runs
// (whole roster in ~3 runs, then only newly-plated vehicles trigger calls).
const BUSTIMES_RUN_CAP = 250;

export async function build(ctx) {
  const { sink, log } = ctx;
  const fleet = await sink.readDataset("fleet");
  if (!fleet?.byRoute) { log.warn("vehicles: no fleet dataset — skipping"); return { source: "fleet (inverted)", rows: 0, files: [] }; }

  // operator per route (so each reg inherits its route's operator)
  const meta = (await sink.readDataset("route-meta"))?.routes || {};
  const dvla = (await sink.readDataset("fleet-dvla-cache"))?.byReg || {};

  const byReg = {};
  for (const [route, e] of Object.entries(fleet.byRoute)) {
    for (const reg of e.regs || []) {
      const v = byReg[reg] || (byReg[reg] = { reg, routes: [], operator: meta[route]?.operator || null });
      if (!v.routes.includes(route)) v.routes.push(route);
      if (!v.operator && meta[route]?.operator) v.operator = meta[route].operator;
      const d = dvla[reg];
      if (d) { v.make = cleanMake(d.make); v.year = d.year; v.fuel = d.fuel; v.propulsion = propulsionOf(d.fuel); }
    }
  }

  // ── body/deck/fleet-code enrichment — bustimes.org (the LVF-class community tier) ──
  // Source priority (decision 2026-08-10): DVLA first, never overwritten. bustimes fills
  // only what DVLA cannot provide — the TYPE (chassis+body), deck and fleet code — plus
  // ONE documented exception: DVLA registers most hybrids as plain DIESEL and FCEVs as
  // ELECTRICITY, so a bustimes hybrid/electric value upgrades a diesel/null propulsion
  // (flagged via propulsionSource). One lookup per reg ever; misses re-checked monthly.
  const cache = (await sink.readDataset("vehicle-body-cache")) || { byReg: {} };
  const now = Date.now();
  let looked = 0, enriched = 0;
  for (const reg of Object.keys(byReg).sort()) {
    let c = cache.byReg[reg];
    const staleMiss = c && c.miss && now - (c.at || 0) > MISS_RECHECK_DAYS * 86400000;
    if ((!c || staleMiss) && looked < BUSTIMES_RUN_CAP) {
      const rec = await lookupVehicle(reg);
      looked++;
      if (rec === undefined) { /* unavailable this run — keep cache state, try next run */ }
      else cache.byReg[reg] = c = rec === null ? { miss: true, at: now } : { ...rec, at: now };
    }
    if (c && !c.miss) {
      const v = byReg[reg];
      if (c.body) v.body = c.body;
      if (c.deck) v.deck = c.deck;
      if (c.fleetCode) v.fleetCode = c.fleetCode;
      if ((c.fuel === "hybrid" || c.fuel === "electric") && (v.propulsion == null || v.propulsion === "diesel")) {
        v.propulsion = c.fuel; v.propulsionSource = "bustimes";
      }
      enriched++;
    }
  }
  await sink.writeDataset("vehicle-body-cache", cache);

  for (const v of Object.values(byReg)) v.routes.sort();
  // a reg seen on >1 route in a single snapshot is already a cross-route working
  const multiRoute = Object.values(byReg).filter((v) => v.routes.length > 1).length;

  // derived from fleet's live reg sample — a healthy snapshot has hundreds of regs.
  // A near-empty roster means fleet went empty; don't overwrite the last-good roster.
  rowsWithin(Object.values(byReg), 100, undefined, "vehicles regs");
  await sink.writeDataset("vehicles", { generatedAt: new Date().toISOString(), byReg });
  log.info(`vehicles: ${Object.keys(byReg).length} regs rostered · ${multiRoute} on multiple routes · body known for ${enriched} (${looked} bustimes lookups this run)`);
  return { source: "fleet (inverted) + DVLA cache + bustimes.org", rows: Object.keys(byReg).length, files: ["data/vehicles.json"], note: `${multiRoute} multi-route · ${enriched} with body` };
}
