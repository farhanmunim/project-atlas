/**
 * sources/bustimes.js — bustimes.org public API (community fleet database).
 *
 * The LVF-class community source with an open, documented REST API: per-vehicle
 * records carrying what DVLA cannot provide — the full TYPE (chassis + BODY,
 * e.g. "Volvo B5LH Wright Eclipse Gemini 3"), deck style, operator fleet code,
 * and a community-maintained fuel value that corrects DVLA's known hybrid
 * misreporting. Source-priority contract (decision 2026-08-10): DVLA first and
 * never overwritten; bustimes fills only what DVLA lacks (body/deck/fleetCode)
 * plus the one documented exception — the hybrid/electric upgrade where DVLA's
 * fuelType is known-unreliable. londonbusroutes remains the route-level spec
 * authority. (LVF itself — lvf.io — is account-gated with no public API; it is
 * catalogued as a future source pending an arrangement with its admin team.)
 *
 * Politeness (community-run service): one lookup per registration EVER (hits
 * cached forever, misses re-checked after 30 days), ~300 ms between calls,
 * per-run cap, exponential backoff + hard stop on 429/5xx, identified UA.
 */

const API = "https://bustimes.org/api/vehicles/";
const UA = "Atlas/1.0 (atlas.farhan.app; auth@farhan.app)";
const SPACING_MS = 300;
const TIMEOUT_MS = 15_000;
export const MISS_RECHECK_DAYS = 30;

/** Normalise one bustimes vehicle record → our cache shape. Exported for tests. */
export function normaliseVehicle(rec) {
  if (!rec) return null;
  const vt = rec.vehicle_type || {};
  const deck = vt.double_decker === true ? "double"
    : vt.double_decker === false && /decker|bus/i.test(vt.style || "") ? "single"
    : vt.style === "single decker" ? "single" : vt.double_decker === false ? "single" : null;
  return {
    body: vt.name || null,                       // full type: chassis + bodywork
    deck,
    fuel: vt.fuel || null,                       // community-maintained; corrects DVLA hybrids
    fleetCode: rec.fleet_code || rec.fleet_number || null,
    operator: rec.operator?.name || null,
    withdrawn: rec.withdrawn === true,
  };
}

let stopped = false;
/** Look up one registration. Returns normalised record, null (confirmed miss), or
 *  undefined (unavailable this run — backoff/stopped; caller keeps cache state). */
export async function lookupVehicle(reg) {
  if (stopped) return undefined;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${API}?reg=${encodeURIComponent(reg)}&format=json`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal,
    });
    if (r.status === 429 || r.status >= 500) { stopped = true; return undefined; }  // back off for the whole run
    if (!r.ok) return undefined;
    const j = await r.json();
    await new Promise((res) => setTimeout(res, SPACING_MS));
    const hit = (j.results || []).find((x) => String(x.reg || "").toUpperCase() === String(reg).toUpperCase()) || j.results?.[0];
    return hit ? normaliseVehicle(hit) : null;
  } catch { return undefined; }
  finally { clearTimeout(t); }
}
