import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-vehicle-fleet.js — Per-vehicle fleet metadata cache
 *
 * Source-of-truth fleet table for every TfL bus, built by joining:
 *   1. iBus Vehicle.xml — registration + bonnet number + operator for ~9 000
 *      vehicles (https://ibus.data.tfl.gov.uk/, S3 bucket).
 *   2. DVLA Vehicle Enquiry Service (VES) — registration → make, fuelType,
 *      yearOfManufacture, monthOfFirstRegistration.
 *
 * Output: data/source/vehicle-fleet.json
 *   {
 *     generatedAt, ibusBaseVersion, cacheTtlDays,
 *     vehicles: {
 *       [registration]: {
 *         operator, bonnetNo, vehicleId,
 *         make, fuelType, fuelTypeRaw,
 *         yearOfManufacture, monthOfFirstRegistration,
 *         lastCheckedAt, dvlaStatus, dvlaError
 *       }
 *     }
 *   }
 *
 * Sticky cache: a registration that DVLA already classified is not re-queried
 * for `cacheTtlDays` days. Failed lookups (404 / network error) are also
 * cached so they don't hammer DVLA every refresh; the TTL covers retries.
 *
 * Rate-limiting: holds itself to ~5 req/sec under DVLA's 15 RPS free-tier
 * limit, with exponential backoff on 429 / 5xx.
 *
 * Run: npm run fetch-vehicle-fleet
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders }                 from './_lib/http.js';
import { loadJsonCache, atomicWriteJson, installSignalFlush } from './_lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'vehicle-fleet.json');

// ── Config ──────────────────────────────────────────────────────────────────
const CACHE_TTL_DAYS    = 90;               // re-query DVLA every 90 days max
const DVLA_RPS          = 5;                // < 15 RPS published free-tier limit
const DVLA_RETRIES      = 4;                // exponential backoff on 429 / 5xx
const FLUSH_EVERY       = 250;              // periodic cache flush so a CI timeout doesn't lose progress
const MAX_LOOKUPS_RUN   = 6000;             // hard cap per run — bounds runtime even if cache is cold (≈20 min @ 5 RPS)
const IBUS_BASE      = 'https://s3-eu-west-1.amazonaws.com/ibus.data.tfl.gov.uk';
const DVLA_URL       = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const SCRIPT         = 'vehicle-fleet';

loadEnv();
const DVLA_API_KEY = process.env.DVLA_API_KEY ?? '';
if (!DVLA_API_KEY) {
  console.error('Error: DVLA_API_KEY not set. Add to .env (local) or GitHub Actions secrets (CI).');
  process.exit(1);
}

// ── DVLA fuelType → our normalised enum ─────────────────────────────────────
// DVLA values seen on London bus fleets: ELECTRICITY, DIESEL, HYBRID ELECTRIC,
// HEAVY OIL (= diesel), FUEL CELL (= hydrogen). PETROL / GAS variants are
// vanishingly rare for buses but mapped defensively.
function normaliseFuel(raw) {
  if (!raw) return null;
  const t = String(raw).toUpperCase().trim();
  if (t === 'ELECTRICITY')                              return 'electric';
  if (t === 'HYBRID ELECTRIC' || t === 'HYBRID')        return 'hybrid';
  if (t === 'FUEL CELL' || t === 'HYDROGEN')            return 'hydrogen';
  if (t === 'DIESEL' || t === 'HEAVY OIL')              return 'diesel';
  if (/^GAS/.test(t))                                   return 'gas';
  if (t === 'PETROL')                                   return 'petrol';
  return null; // unknown — leave raw value in place for inspection
}

// ── iBus discovery + download ──────────────────────────────────────────────
// HTTP helpers (timeout, UA, retries) live in `_lib/http.js`. Local logic
// here is just the iBus-specific parsing.

// Discover the most recent Base_Version_YYYYMMDD/ folder in the iBus bucket.
// Sorts lexically because the date format YYYYMMDD is lex-sortable.
async function findLatestBaseVersion() {
  const res = await fetchWithTimeout(`${IBUS_BASE}/?list-type=2&delimiter=/`, {
    headers: userAgentHeaders(SCRIPT),
  });
  if (!res.ok) throw new Error(`iBus bucket list failed: HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [...xml.matchAll(/<Prefix>Base_Version_(\d{8})\/<\/Prefix>/g)]
    .map(m => m[1])
    .sort();
  if (!versions.length) throw new Error('No Base_Version_* folders found in iBus bucket');
  return versions[versions.length - 1];
}

async function downloadVehicleXml(version) {
  const url = `${IBUS_BASE}/Base_Version_${version}/Vehicle_${version}.zip`;
  const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
  if (!res.ok) throw new Error(`Vehicle ZIP fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => /Vehicle_\d{8}\.xml$/i.test(e.entryName));
  if (!entry) throw new Error('No Vehicle_*.xml inside ZIP');
  return entry.getData().toString('utf8');
}

// A subset of iBus rows have the bonnet number in the Registration_Number
// field (e.g. First's "2530"), not a real UK VRM. DVLA rejects those with
// HTTP 400. We require at least one letter AND one digit, length 5-7,
// alphanumeric — covers every UK plate format from 1963 onwards while
// rejecting pure-numeric junk and stray test strings.
function looksLikeUkVrm(s) {
  return /^[A-Z0-9]{5,7}$/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

// XML is a flat list of <Vehicle aVehicleId="..."><Registration_Number>...
// Regex parse — XML is well-formed and the elements are simple.
function parseVehicleXml(xml) {
  const out = [];
  const re = /<Vehicle\s+aVehicleId="(\d+)"\s*>\s*<Registration_Number>([^<]+)<\/Registration_Number>\s*<Bonnet_No>([^<]*)<\/Bonnet_No>\s*<Operator_Agency>([^<]*)<\/Operator_Agency>\s*<\/Vehicle>/g;
  let m;
  let skipped = 0;
  while ((m = re.exec(xml)) !== null) {
    const reg = m[2].trim().toUpperCase().replace(/\s+/g, '');
    if (!reg) continue;
    if (!looksLikeUkVrm(reg)) { skipped++; continue; }
    out.push({
      vehicleId: m[1],
      reg,
      bonnetNo: m[3].trim() || null,
      operator: m[4].trim() || null,
    });
  }
  if (skipped) console.log(`  Skipped ${skipped} iBus rows with non-VRM Registration_Number (likely bonnet numbers)`);
  return out;
}

// ── DVLA call with retry + backoff ──────────────────────────────────────────
async function dvlaLookup(reg) {
  for (let attempt = 1; attempt <= DVLA_RETRIES; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(DVLA_URL, {
        method:  'POST',
        headers: userAgentHeaders(SCRIPT, {
          'x-api-key':    DVLA_API_KEY,
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ registrationNumber: reg }),
      });
    } catch (err) {
      // Network / abort. Backoff and retry.
      if (attempt === DVLA_RETRIES) return { status: 0, error: err.message };
      await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
      continue;
    }

    if (res.status === 200) {
      const body = await res.json();
      return { status: 200, body };
    }
    if (res.status === 404) {
      // Authoritative: DVLA has no record. Cache it.
      return { status: 404, error: 'not found' };
    }
    if (res.status === 429 || res.status >= 500) {
      // Transient. Backoff (DVLA Retry-After honoured if present).
      const retryAfter = parseFloat(res.headers.get('retry-after') ?? '');
      const delayMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 500 * 2 ** (attempt - 1);
      if (attempt === DVLA_RETRIES) {
        return { status: res.status, error: `HTTP ${res.status} after ${attempt} retries` };
      }
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }
    // Anything else (400/401/403): authoritative refusal — don't retry.
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    return { status: res.status, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
// Cache load + atomic flush both go through `_lib/cache.js`. `flushCache`
// builds the output shape and writes it; the closure over `cache` is what
// lets the SIGTERM hook flush without passing args through the signal.
function loadCache() {
  const j = loadJsonCache(OUT_PATH, {});
  const vehicles = j.vehicles ?? {};
  // One-time prune of pre-existing non-VRM entries (bonnet numbers, etc).
  // These were written before the parse-time VRM filter existed and have
  // been silently rejected by DVLA every run since.
  let pruned = 0;
  for (const key of Object.keys(vehicles)) {
    if (!looksLikeUkVrm(key)) { delete vehicles[key]; pruned++; }
  }
  if (pruned) console.log(`  Pruned ${pruned} cached entries with non-VRM keys`);
  return {
    vehicles,
    ibusBaseVersion: j.ibusBaseVersion ?? null,
  };
}

function flushCache(cache, ibusBaseVersion) {
  atomicWriteJson(OUT_PATH, {
    generatedAt:     new Date().toISOString(),
    ibusBaseVersion,
    cacheTtlDays:    CACHE_TTL_DAYS,
    vehicleCount:    Object.keys(cache.vehicles).length,
    vehicles:        cache.vehicles,
  });
}

function isStale(cached, cutoffMs) {
  if (!cached?.lastCheckedAt) return true;
  const ts = new Date(cached.lastCheckedAt).getTime();
  return !Number.isFinite(ts) || ts < cutoffMs;
}

async function main() {
  console.log('Discovering latest iBus base version...');
  const version = await findLatestBaseVersion();
  console.log(`  Base_Version_${version}`);

  console.log('Downloading Vehicle.xml...');
  const xml = await downloadVehicleXml(version);
  const vehicles = parseVehicleXml(xml);
  console.log(`  Parsed ${vehicles.length} vehicles`);

  const cache = loadCache();
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86_400_000;

  // 1. Refresh iBus-derived fields (operator/bonnet) on every vehicle so the
  //    cache always reflects the latest fleet → garage allocation.
  for (const v of vehicles) {
    const prev = cache.vehicles[v.reg] ?? {};
    cache.vehicles[v.reg] = {
      ...prev,
      vehicleId: v.vehicleId,
      bonnetNo:  v.bonnetNo,
      operator:  v.operator,
    };
  }

  // 2. Identify which need DVLA (new or stale). Cap per-run lookups so a cold
  //    cache spreads over multiple weekly runs instead of blowing the CI
  //    budget on a single Monday.
  const stale = vehicles.filter(v => isStale(cache.vehicles[v.reg], cutoff));
  // Prefer never-checked vehicles before re-validating older entries.
  stale.sort((a, b) => {
    const ta = cache.vehicles[a.reg]?.lastCheckedAt ?? '';
    const tb = cache.vehicles[b.reg]?.lastCheckedAt ?? '';
    return ta.localeCompare(tb);
  });
  const toFetch = stale.slice(0, MAX_LOOKUPS_RUN);
  console.log(`DVLA: ${stale.length} need lookup; will process ${toFetch.length} this run (cap=${MAX_LOOKUPS_RUN}, TTL ${CACHE_TTL_DAYS}d)`);

  // Flush once before any DVLA calls so the iBus updates (operator/bonnet)
  // persist even if the script crashes during the lookup loop.
  flushCache(cache, version);

  if (toFetch.length === 0) {
    console.log('  Cache fully warm — skipping DVLA calls');
  } else {
    const minIntervalMs = Math.ceil(1000 / DVLA_RPS);
    let nextSlot = Date.now();
    let done = 0, ok = 0, miss = 0, err = 0;

    // Atomic-ish flush on Ctrl-C / SIGTERM — preserves whatever progress was
    // made before the kill signal so a CI timeout never wastes a run.
    installSignalFlush(() => flushCache(cache, version));

    for (const v of toFetch) {
      const wait = nextSlot - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      nextSlot = Date.now() + minIntervalMs;

      const result = await dvlaLookup(v.reg);
      const now = new Date().toISOString();
      const prev = cache.vehicles[v.reg] ?? {};

      if (result.status === 200) {
        const b = result.body ?? {};
        cache.vehicles[v.reg] = {
          ...prev,
          make:                     b.make ?? null,
          fuelType:                 normaliseFuel(b.fuelType),
          fuelTypeRaw:              b.fuelType ?? null,
          yearOfManufacture:        b.yearOfManufacture ?? null,
          monthOfFirstRegistration: b.monthOfFirstRegistration ?? null,
          lastCheckedAt:            now,
          dvlaStatus:               200,
          dvlaError:                null,
        };
        ok++;
      } else if (result.status === 404) {
        cache.vehicles[v.reg] = {
          ...prev,
          lastCheckedAt: now,
          dvlaStatus:    404,
          dvlaError:     'not found',
        };
        miss++;
      } else {
        cache.vehicles[v.reg] = {
          ...prev,
          lastCheckedAt: now,
          dvlaStatus:    result.status,
          dvlaError:     result.error,
        };
        err++;
      }

      done++;
      if (done % FLUSH_EVERY === 0) {
        flushCache(cache, version);
        console.log(`  ${done}/${toFetch.length}  ok=${ok}  notfound=${miss}  err=${err}  (cache flushed)`);
      }
    }

    console.log(`Done: ok=${ok}  notfound=${miss}  err=${err}`);
  }

  flushCache(cache, version);
  console.log(`Wrote ${Object.keys(cache.vehicles).length} vehicles to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
