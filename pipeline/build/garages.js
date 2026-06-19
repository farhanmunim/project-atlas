/**
 * build/garages.js — bus garages with coordinates (markers + route→garage links).
 *
 * londonbusroutes.net garages.csv (operator, routes, address) → extract postcode →
 * geocode via postcodes.io → garages.json: [{code,name,operator,lat,lng,pvr,routes[]}].
 * Garages that fail to geocode are kept (no lat/lng) so the route→garage lookup
 * still works; only mappable ones get a marker.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchGarages } from "../sources/londonbusroutes.js";
import { geocode } from "../sources/postcodes.js";
import { rowsWithin, notAllNull } from "../lib/validate.js";

// Curated postcode overrides for garages whose CSV row carries no extractable
// postcode (applied before geocoding, so coordinates stay postcodes.io-sourced).
function loadJson(file, key) {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", file);
    return JSON.parse(readFileSync(p, "utf8"))[key] || {};
  } catch { return {}; }
}
const loadPostcodeOverrides = () => loadJson("garage-postcodes.json", "postcodes");
const loadCapacity = () => loadJson("garage-capacity.json", "capacity");

export async function build(ctx) {
  const { sink, log } = ctx;
  const garages = await fetchGarages();
  const overrides = loadPostcodeOverrides();
  const capacity = loadCapacity();
  // Geocode every candidate postcode at once: each garage's own (garage + company)
  // plus every curated override. Then resolve per-garage by precedence, so the
  // override also rescues a garage whose CSV postcode simply won't geocode.
  const candidates = new Set();
  for (const g of garages) { if (g.postcode) candidates.add(g.postcode); if (g.postcodeCompany) candidates.add(g.postcodeCompany); }
  for (const c of Object.values(overrides)) candidates.add(c);
  let coords = {};
  try { coords = await geocode([...candidates]); }
  catch (e) { log.warn(`geocode failed (${e.message}) — garages saved without coordinates`); }

  // Precedence: garage-address postcode → curated override → company address (HQ).
  let placed = 0, overridden = 0, fromCompany = 0;
  const out = garages.map((g) => {
    let pc = g.postcode, c = pc ? coords[pc] : null, src = c ? "garage" : null;
    if (!c && overrides[g.code] && coords[overrides[g.code]]) { pc = overrides[g.code]; c = coords[pc]; src = "override"; overridden++; }
    else if (!c && g.postcodeCompany && coords[g.postcodeCompany]) { pc = g.postcodeCompany; c = coords[pc]; src = "company"; fromCompany++; }
    if (c) placed++;
    const cap = Number.isFinite(capacity[g.code]) ? capacity[g.code] : null;
    // utilisation = peak vehicles ÷ authorised-vehicle capacity (how full the depot runs)
    const utilisation = cap && g.pvr ? +(g.pvr / cap).toFixed(3) : null;
    return { code: g.code, name: g.name, operator: g.operator, company: g.company,
      postcode: pc, postcodeSource: src, lat: c?.lat ?? null, lng: c?.lng ?? null,
      pvr: g.pvr, capacity: cap, utilisation, routes: g.routes };
  });

  // Drop stale duplicate garages: a garage with NO routes sitting on top of (<150 m) an
  // active route-serving garage is a historical/duplicate listing — e.g. Ash Grove is
  // still listed under its former Arriva code (AE) while Stagecoach now runs it as HK.
  // Genuine out-of-area depots (no routes, but not co-located with an active garage) stay.
  const near = (a, b) => { const R = 6371000, toR = (d) => (d * Math.PI) / 180;
    const dl = toR(b.lat - a.lat), dn = toR(b.lng - a.lng);
    const x = Math.sin(dl / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x)); };
  const routed = out.filter((g) => g.routes && g.routes.length && g.lat != null);
  const deduped = out.filter((g) => {
    if ((g.routes && g.routes.length) || g.lat == null) return true;
    const dup = routed.find((r) => r.code !== g.code && near(g, r) < 150);
    if (dup) { log.info(`garages: dropped stale duplicate ${g.code} (${g.operator}) — co-located with active ${dup.code} (${dup.operator}, ${dup.name})`); return false; }
    return true;
  });

  // London has ~88 garages; floor catches a garages.csv outage. notAllNull on lat
  // ensures an all-failed-geocode run can't overwrite good coordinates (garages are
  // kept without coords by design, but ALL coords going null is an outage, not design).
  rowsWithin(deduped, 50, undefined, "garages");
  notAllNull(deduped, "lat", "garages");
  await sink.writeDataset("garages", { generatedAt: new Date().toISOString(), source: "londonbusroutes.net + postcodes.io", garages: deduped });
  const withCap = deduped.filter((g) => g.capacity != null).length;
  log.info(`garages: ${deduped.length} (${placed} geocoded · ${overridden} override · ${fromCompany} company-addr fallback · ${withCap} with capacity · ${out.length - deduped.length} stale dupes dropped)`);
  return { source: "londonbusroutes.net garages.csv + postcodes.io", rows: deduped.length, files: ["data/garages.json"], note: `${placed} geocoded${overridden?`, ${overridden} override`:""}` };
}
