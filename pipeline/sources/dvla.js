/**
 * sources/dvla.js — DVLA Vehicle Enquiry Service (VES) lookup by registration.
 *
 * Turns a bus reg (from TfL arrivals, e.g. "LTZ1030") into { make, yearOfManufacture,
 * fuelType, … } — the basis for per-route avg fleet age / make / propulsion.
 *
 * VES is NOT key-less: it needs an `x-api-key` (free to register, but approval-gated),
 * so this only runs when DVLA_API_KEY is set. Without it, the live-vehicle regs are
 * still captured (TfL arrivals) — only the age/make enrichment is skipped.
 *
 * RATE LIMITS (official docs): VES throttles by requests/second tied to your plan and
 * returns HTTP 429 when exceeded. We therefore stay deliberately polite and inside the
 * free tier by:
 *   • a configurable inter-request delay (DVLA_DELAY_MS, default 220ms ≈ 4.5 req/s),
 *   • a per-RUN lookup cap (DVLA_MAX_LOOKUPS, default 2000) so a cold start spreads
 *     coverage across several daily runs instead of one huge burst,
 *   • exponential backoff on 429, and a hard stop after repeated 429s (persist what we
 *     got, resume next run) — partial success is success.
 * Because resolved regs are CACHED (and the cache is committed), steady-state daily
 * volume is only the handful of NEW regs as the fleet rotates — trivially within limits.
 *
 * Endpoint: POST https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles
 */

const VES = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const RATE_LIMIT = Symbol("dvla-429");

export function hasKey() { return !!process.env.DVLA_API_KEY; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise + validate a UK VRM before spending a DVLA lookup on it. Bus feeds carry
// the odd bonnet/placeholder id that DVLA 400s on; skip those so we don't waste the
// per-run budget or pollute the cache with junk keys.
export function normReg(reg) { return String(reg || "").replace(/\s+/g, "").toUpperCase(); }
export function looksLikeUkVrm(reg) {
  const r = normReg(reg);
  return /^[A-Z0-9]{5,7}$/.test(r) && /[A-Z]/.test(r) && /[0-9]/.test(r);
}

/** Look up one registration. Returns a record, null on miss/error, or RATE_LIMIT on 429. */
export async function lookup(reg) {
  const key = process.env.DVLA_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(VES, {
      method: "POST", signal: ctrl.signal,
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ registrationNumber: String(reg).replace(/\s+/g, "").toUpperCase() }),
    });
    if (res.status === 429) return RATE_LIMIT;
    if (!res.ok) return null;            // 404 = unknown reg, etc. — cache the miss
    const v = await res.json();
    return { reg, make: v.make || null, year: v.yearOfManufacture || null, fuel: v.fuelType || null, co2: v.co2Emissions ?? null };
  } catch { return null; }
  finally { clearTimeout(t); }
}

const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

/**
 * Look up many regs, reusing `cache` (reg → record|null) so a reg is only ever queried
 * once. Polite + bounded (see file header). Mutates + returns { cache, looked, deferred,
 * stopped }. No-ops without a key.
 */
export async function lookupMany(regs, cache = {}, opts = {}) {
  if (!hasKey()) return { cache, looked: 0, deferred: 0, stopped: false };
  const delayMs = opts.delayMs ?? envInt("DVLA_DELAY_MS", 220);
  const max = opts.max ?? envInt("DVLA_MAX_LOOKUPS", 5000);
  const fresh = [...new Set(regs.map(normReg))].filter((r) => r && !(r in cache));
  // Skip ids that aren't valid UK VRMs (bonnet/placeholder numbers) — cache them as
  // null so they're not retried, and never waste a DVLA call (a sure 400) on them.
  let skipped = 0;
  for (const r of fresh) if (!looksLikeUkVrm(r)) { cache[r] = null; skipped++; }
  const todo = fresh.filter(looksLikeUkVrm);
  let looked = 0, stopped = false;
  for (const reg of todo) {
    if (looked >= max) break;            // per-run cap → spread cold starts over days
    let r = await lookup(reg), tries = 0;
    while (r === RATE_LIMIT && tries < 4) {           // 429 → exponential backoff
      await sleep(Math.min(1000 * 2 ** tries, 15_000) + Math.random() * 250);
      r = await lookup(reg); tries++;
    }
    if (r === RATE_LIMIT) { stopped = true; break; }  // still throttled → stop, resume next run
    cache[reg] = r || null;              // cache misses too, so we don't retry every run
    looked++;
    if (delayMs) await sleep(delayMs);
  }
  const deferred = todo.length - looked;
  return { cache, looked, deferred, stopped, skipped };
}
