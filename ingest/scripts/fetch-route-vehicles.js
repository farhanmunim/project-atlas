import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-route-vehicles.js — Per-route vehicle observations from TfL arrivals
 *
 * For every bus line, calls TfL `/Line/<id>/Arrivals` and collects the unique
 * `vehicleId` values from the prediction list. The vehicleId in TfL's Unified
 * API is the bus registration (e.g. `LK20FNZ`), so this gives us the set of
 * registrations actually working a route at the moment of the snapshot.
 *
 * Designed to run weekly at peak (Mondays 09:00 UTC = 09:00 GMT / 10:00 BST)
 * so the snapshot catches a representative active fleet. Each refresh appends
 * newly-seen registrations to the per-route set; entries older than
 * `OBSERVATION_TTL_DAYS` are pruned. Steady-state coverage is well above 90%
 * after two or three Mondays.
 *
 * Output: data/source/route-vehicles.json
 *   {
 *     generatedAt, observationTtlDays,
 *     routes: {
 *       [routeId]: [
 *         { reg: "LK20FNZ", firstSeenAt, lastSeenAt, sightings: 7, days: 7 },
 *         …
 *       ]
 *     }
 *   }
 *
 * `sightings` is the running count of runs this reg appeared on the route;
 * `days` is the number of distinct calendar dates it was seen on. The fleet
 * aggregator (build-classifications.js) uses these to tell a route's recurring
 * core fleet from one-off cover/reserve buses that ran it once — a single
 * emergency vehicle no longer defines a route's make, age, or fleet size.
 * Legacy entries that only carried `lastSeenAt` are back-filled as a single
 * sighting on load, so counts rebuild forward from the first run after this.
 *
 * Run: npm run fetch-route-vehicles
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';
import { extractRegs } from './_lib/arrivals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'route-vehicles.json');
const BASE_URL  = 'https://api.tfl.gov.uk';
const SCRIPT    = 'route-vehicles';

const OBSERVATION_TTL_DAYS = 56;   // ~8 weeks of Monday samples accumulate
const CONC                 = 4;
const REQS_PER_MIN         = 300;

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';

function apiUrl(ep) {
  return `${BASE_URL}${ep}${API_KEY ? `${ep.includes('?') ? '&' : '?'}app_key=${API_KEY}` : ''}`;
}

// HTTP timeout + UA come from `_lib/http.js`. Retry / backoff stays local
// because TfL's quirks dictate the policy (4 attempts, linear backoff).
async function fetchJson(url, retries = 4) {
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, i * 800));
    }
  }
}

function loadExisting() {
  if (!fs.existsSync(OUT_PATH)) return { routes: {} };
  try {
    const j = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return { routes: j.routes ?? {} };
  } catch {
    return { routes: {} };
  }
}

async function main() {
  console.log('Fetching bus lines...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  const ids = [...new Set((lines ?? []).map(l => String(l.id).toUpperCase()))].sort();
  console.log(`  ${ids.length} routes`);

  const existing = loadExisting();
  const cutoff = Date.now() - OBSERVATION_TTL_DAYS * 86_400_000;

  const observations = {};   // { routeId: Map(reg → {firstSeenAt,lastSeenAt,sightings,days}) }
  const sampledAt = new Date().toISOString();
  const sampledDay = sampledAt.slice(0, 10);

  // Seed with previously-observed regs that haven't expired. Carry forward the
  // accumulated sighting/day counts; back-fill legacy entries (which stored only
  // a single `lastSeenAt`) as one sighting on one day so counts grow from here.
  for (const [rid, list] of Object.entries(existing.routes)) {
    const m = new Map();
    for (const entry of (list ?? [])) {
      const reg = typeof entry === 'string' ? entry : entry?.reg;
      const seen = typeof entry === 'object' ? entry?.lastSeenAt : null;
      if (!reg) continue;
      const seenMs = seen ? new Date(seen).getTime() : 0;
      if (seenMs < cutoff) continue;
      m.set(reg.toUpperCase(), {
        firstSeenAt: (typeof entry === 'object' && entry?.firstSeenAt) || seen,
        lastSeenAt:  seen,
        sightings:   Number.isFinite(entry?.sightings) ? entry.sightings : 1,
        days:        Number.isFinite(entry?.days)      ? entry.days      : 1,
      });
    }
    if (m.size) observations[rid] = m;
  }

  const minInterval = Math.ceil(60_000 / REQS_PER_MIN);
  let nextSlot = Date.now();
  let idx = 0, done = 0, withObs = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= ids.length) break;

      const wait = nextSlot - Date.now();
      nextSlot = Math.max(Date.now(), nextSlot) + minInterval;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      const id = ids[i];
      const arr = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Arrivals`));
      if (Array.isArray(arr)) {
        // Plate-shaped `vehicleId`s only — shared with sample-vehicles.js so
        // both collectors accept exactly the same set (see _lib/arrivals.js).
        const regs = new Set(extractRegs(arr));
        if (regs.size) {
          if (!observations[id]) observations[id] = new Map();
          const m = observations[id];
          for (const r of regs) {
            const prev = m.get(r);
            if (prev) {
              prev.sightings += 1;
              // Only bump the distinct-day count when this run lands on a new
              // calendar date, so a manual same-day re-run can't inflate it.
              if (prev.lastSeenAt.slice(0, 10) !== sampledDay) prev.days += 1;
              prev.lastSeenAt = sampledAt;
            } else {
              m.set(r, { firstSeenAt: sampledAt, lastSeenAt: sampledAt, sightings: 1, days: 1 });
            }
          }
          withObs++;
        }
      }

      done++;
      if (done % 50 === 0) console.log(`  ${done}/${ids.length}  withObs=${withObs}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // Serialise back as { reg, firstSeenAt, lastSeenAt, sightings, days }
  const routesOut = {};
  for (const id of Object.keys(observations).sort()) {
    routesOut[id] = [...observations[id].entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reg, rec]) => ({
        reg,
        firstSeenAt: rec.firstSeenAt,
        lastSeenAt:  rec.lastSeenAt,
        sightings:   rec.sightings,
        days:        rec.days,
      }));
  }

  const output = {
    // generatedAt MUST equal sampledAt — push-to-supabase.js identifies "this
    // run's fresh observations" by `lastSeenAt === generatedAt`. If we use
    // `new Date().toISOString()` here we get a timestamp 2-3 minutes after
    // sampledAt (the worker pool finish time) and the filter never matches.
    generatedAt:        sampledAt,
    observationTtlDays: OBSERVATION_TTL_DAYS,
    routeCount:         Object.keys(routesOut).length,
    routes:             routesOut,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(output)), 'utf8');
  console.log(`Wrote vehicle observations for ${output.routeCount} routes to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
