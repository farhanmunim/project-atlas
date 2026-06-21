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
import { rowsWithin, notAllNull } from "../lib/validate.js";

function propFromVehicle(v) {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/hydrogen|fuel ?cell|fcev|hydroliner/.test(s)) return "hydrogen";
  // EV marker must tolerate a digit prefix ("E100EV", "200EV", "Enviro100EV") — the
  // old \bev\b had no word boundary after a digit, so battery models like the
  // Enviro100EV fell through to diesel. (?<![a-z]) keeps it from matching "prev"/"rev".
  if (/\bbev\b|electric|(?<![a-z])ev\b|\bbyd\b|enviro ?\d* ?ev|e\d+ev|electroliner|e-?bus/.test(s)) return "electric";
  // NB: no bare \bh\b here — it over-matches a stray "H" token. The real hybrid
  // suffixes (B5LH, E40H, MMC H, …LH) are each matched explicitly.
  if (/\blh\b|hybrid|new bus for london|nbfl|b5lh|e40h|mmc h/.test(s)) return "hybrid";
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
  const allRoutes = new Set([...Object.keys(garages), ...details.map((d) => d.route)]);

  const meta = {};
  let withOperator = 0, withFleet = 0;
  for (const rt of allRoutes) {
    const g = garages[rt] || {};
    const d = detailByRoute[rt] || {};
    const [cs, ce] = CONTRACT[rt] || [];
    const ov = overrideFor(rt);
    meta[rt] = {
      type: ov.type || deriveType(rt),         // regular | night | twentyfour | school
      operator: g.operator || null,
      company: g.company || null,
      propulsion: propFromVehicle(d.vehicleType),
      garage: d.garage || g.garageCode || null,
      garageName: g.garageName || null,
      pvr: d.pvr ?? null,
      fleet: d.vehicleType || null,
      lengthKm: d.lengthKm ?? null,
      contractDate: d.contractDate || null,
      contractStart: cs || null,
      contractEnd: ce || null,
      source: "londonbusroutes.net",
    };
    // manual overrides win over every source (operator/garage/fleet/pvr/… corrections)
    for (const [k, v] of Object.entries(ov)) if (k !== "type") meta[rt][k] = v;
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
  log.info(`route-meta: ${allRoutes.size} routes · ${withOperator} operator · ${withFleet} fleet`);
  return { source: "londonbusroutes.net (garages.csv + details.htm)", rows: allRoutes.size, files: ["data/route-meta.json"], note: `${withOperator} operators` };
}
