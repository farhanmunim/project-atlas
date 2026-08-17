/**
 * build/route-meta.js — per-route operator / propulsion / garage / PVR / fleet /
 * contract. NOT in the free TfL API, so we ingest londonbusroutes.net (the source
 * the reference london-buses app uses) from TWO files and merge them:
 *
 *   garages.csv   → operator, group, company, garage (authoritative route→garage→
 *                   operator mapping; cross-checked against london-buses).
 *   details.htm   → vehicle type (fleet), PVR, route length, contract date.
 *
 * propulsion is derived from the vehicle-type string. On failure each source
 * degrades independently (operator without fleet, or vice-versa); a total
 * failure keeps last-good via soft-fail in the orchestrator.
 *
 * Output: route-meta.json keyed by route name.
 */

import { fetchRouteDetails, fetchGarageRouteMap } from "../sources/londonbusroutes.js";
import { deriveType } from "./routes.js";
import { overrideFor } from "../lib/overrides.js";
import { reconcilePropulsion } from "../lib/normalize.js";
import { rowsWithin, notAllNull } from "../lib/validate.js";

export function propFromVehicle(v) {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/hydrogen|fuel ?cell|fcev|hydroliner/.test(s)) return "hydrogen";
  // e\d{2,3}\s?ev catches ADL's electric range as LBR writes it (E400EV/E200EV, with or
  // without a space); BZL is Volvo's electric chassis (e.g. "BZL (sd) 10.4m/MCV" — route 314).
  if (/\bbev\b|electric|\bev\b|\bbyd\b|enviro\d{3} ?ev|e\d{2,3}\s?ev\b|\bbzl\b|electroliner|e-?bus/.test(s)) return "electric";
  if (/\blh\b|hybrid|new bus for london|nbfl|\bh\b|b5lh|e40h|mmc h/.test(s)) return "hybrid";
  return "diesel";
}

/* Contract windows for flagship routes — until the Find-a-Tender OCDS ingester. */
const CONTRACT = {
  "73":["2021-06","2028-06"], "24":["2019-11","2026-11"], "38":["2022-09","2029-09"],
  "86":["2020-04","2027-04"], "159":["2021-01","2028-01"], "148":["2023-02","2030-02"],
  "1":["2022-06","2029-06"], "7":["2021-08","2028-08"],
};

export async function build(ctx) {
  const { sink, log } = ctx;

  // two independent sources — one failing must not lose the other
  let garages = {}, details = [];
  try { garages = await fetchGarageRouteMap(); } catch (e) { log.warn(`garages.csv failed: ${e.message}`); }
  try { details = await fetchRouteDetails(); } catch (e) { log.warn(`details.htm failed: ${e.message}`); }
  if (!Object.keys(garages).length && !details.length) throw new Error("both londonbusroutes sources failed");

  const detailByRoute = {};
  for (const d of details) detailByRoute[d.route] = d;
  let allRoutes = new Set([...Object.keys(garages), ...details.map((d) => d.route)]);

  // Scope to the TfL network (routes.json — the authoritative /Line/Mode/bus set).
  // londonbusroutes.net also lists non-TfL services (Uno's UL*, tram-replacement,
  // recently-withdrawn night/school variants); keeping them would inflate every
  // downstream operator/route count. Falls back to the full union on a cold run.
  try {
    const tfl = await sink.readDataset("routes");
    const names = new Set((Array.isArray(tfl) ? tfl : []).map((r) => String(r.name)));
    if (names.size >= 400) {
      const dropped = [...allRoutes].filter((rt) => !names.has(rt));
      allRoutes = new Set([...allRoutes].filter((rt) => names.has(rt)));
      if (dropped.length) log.info(`route-meta: dropped ${dropped.length} non-TfL routes (${dropped.slice(0, 8).join(", ")}…)`);
    }
  } catch { /* no routes.json yet — keep the union */ }

  // Last-good fleet (DVLA-derived, changes slowly) — used to upgrade a route's propulsion to
  // zero-emission when the vehicle-type string has gone stale. Read defensively; absent on a
  // cold first run, in which case propulsion just falls back to the vehicle-type string.
  let fleetByRoute = {};
  try { const fl = await sink.readDataset("fleet"); fleetByRoute = (fl && fl.byRoute) || {}; }
  catch { /* no last-good fleet yet — vehicle-type string stands */ }
  let propUpgrades = 0;

  const meta = {};
  let withOperator = 0, withFleet = 0;
  for (const rt of allRoutes) {
    const g = garages[rt] || {};
    const d = detailByRoute[rt] || {};
    const [cs, ce] = CONTRACT[rt] || [];
    const ov = overrideFor(rt);
    const metaProp = propFromVehicle(d.vehicleType);
    const reconProp = reconcilePropulsion(metaProp, (fleetByRoute[rt] || {}).propulsion);
    if (reconProp !== metaProp) propUpgrades++;
    meta[rt] = {
      type: ov.type || deriveType(rt),         // regular | night | twentyfour | school
      operator: g.operator || null,
      company: g.company || null,
      propulsion: reconProp,
      garage: d.garage || g.garageCode || null,
      garageName: g.garageName || null,
      pvr: d.pvr ?? null,
      // TVR (Total Vehicle Requirement) — derived: PVR × 1.13, rounded down (the
      // conventional peak→total uplift covering engineering spare/maintenance float).
      tvr: d.pvr != null ? Math.floor(d.pvr * 1.13) : null,
      fleet: d.vehicleType || null,
      lengthKm: d.lengthKm ?? null,
      contractDate: d.contractDate || null,
      contractStart: cs || null,
      contractEnd: ce || null,
      source: "londonbusroutes.net",
    };
    // manual overrides win over every source (operator/garage/fleet/pvr/… corrections)
    for (const [k, v] of Object.entries(ov)) if (k !== "type") meta[rt][k] = v;
    if (ov.pvr != null) meta[rt].tvr = Math.floor(ov.pvr * 1.13);   // derived field follows its base
    if (meta[rt].operator) withOperator++;
    if (meta[rt].fleet) withFleet++;
  }

  // ~700 route rows on a healthy merge; floor catches a run where both sources
  // returned thin data. notAllNull on operator guards the garages.csv half going
  // empty (operator all-null) silently overwriting good operator mappings.
  const metaRows = Object.values(meta);
  rowsWithin(metaRows, 400, undefined, "route-meta routes");
  notAllNull(metaRows, "operator", "route-meta");
  await sink.writeDataset("route-meta", { generatedAt: new Date().toISOString(), source: "londonbusroutes.net (garages.csv + details.htm)", routes: meta });
  log.info(`route-meta: ${allRoutes.size} routes · ${withOperator} operator · ${withFleet} fleet · ${propUpgrades} propulsion upgraded from fleet (ZEV)`);
  return { source: "londonbusroutes.net (garages.csv + details.htm)", rows: allRoutes.size, files: ["data/route-meta.json"], note: `${withOperator} operators` };
}
