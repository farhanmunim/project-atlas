/**
 * fetch-schedule.js — Per-route SCHEDULED baseline for Atlas's own reliability.
 *
 * The denominator for our home-grown EWT / lost-mileage estimates. For every
 * bus route this derives, from the TfL Timetable + Route/Sequence endpoints:
 *
 *   • service_class    high-frequency (≥5 buses/hr, ≤12-min headway) vs
 *                      low-frequency — decides whether the route is graded on
 *                      EWT (waiting time) or OTD (on-time departures).
 *   • swt_minutes      Scheduled Waiting Time at a representative timing point:
 *                          SWT = Σ(hₛ²) / (2·Σhₛ)
 *                      over the SCHEDULED headways hₛ between consecutive
 *                      departures (TfL's definition — the wait a passenger
 *                      arriving at random would expect if buses ran exactly to
 *                      schedule; for a perfectly even service it reduces to
 *                      half the headway). Only meaningful for high-frequency
 *                      routes, but computed for all.
 *   • headway_min      mean scheduled headway (mins) in the representative
 *                      window — the high/low banding signal.
 *   • scheduled_trips  scheduled departures/day at the timing point (used as a
 *                      proxy for daily vehicle-trips → scheduled mileage).
 *   • scheduled_km     scheduled_trips × route length (km). Route length comes
 *                      from the Route/Sequence lineStrings geometry (haversine
 *                      along the polyline), so this script is self-contained —
 *                      it doesn't depend on the geometry ZIP pipeline step.
 *
 * Source: TfL Unified API (api.tfl.gov.uk) — the authoritative London bus feed.
 *   /Line/Mode/bus                                  → route list
 *   /Line/{id}/Route/Sequence/{dir}?...             → timing-point stop + geometry
 *   /Line/{id}/Timetable/{stopId}                   → scheduled departures
 * Cadence: WEEKLY. The schedule only changes on a timetable revision, so this
 * is a heavy-but-infrequent run; wired into refresh.js as a soft-fail step.
 *
 * Robust like fetch-route-mps.js: ~350 req/min throttle, per-request timeout,
 * per-route soft-fail (one bad route never aborts the run), a sticky cache
 * (data/source/route-schedule.json) flushed periodically + on SIGTERM so a CI
 * timeout keeps progress, and a MAX_PER_RUN cap so a cold start over ~700
 * routes is checkpointed across runs.
 *
 * ACCURACY CAVEAT: SWT here is computed over the timing point's scheduled
 * departures for the representative weekday window only — TfL's published SWT
 * aggregates several timing points across the day. Treat as a close estimate,
 * not the contractual figure. scheduled_km is trips×length, a coarse proxy for
 * TfL's odometer-based scheduled mileage (it ignores dead mileage and assumes
 * every scheduled trip runs the full length).
 *
 * Output: data/source/route-schedule.json (sticky cache, committed across runs)
 *   { generatedAt, totalRoutes, fetchedThisRun, errored,
 *     routes: { [id]: { service_class, swt_minutes, headway_min,
 *                       scheduled_trips, length_km, scheduled_km,
 *                       timing_point_stop_id, lastCheckedAt, status } } }
 *
 * Run: npm run fetch-schedule  (add --force to ignore the TTL)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';
import { loadJsonCache, atomicWriteJson, installSignalFlush } from './_lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'source', 'route-schedule.json');
const BASE_URL  = 'https://api.tfl.gov.uk';
const SCRIPT    = 'route-schedule';

// ── Config ──────────────────────────────────────────────────────────────────
const REQS_PER_MIN  = 350;     // brief of ~350/min; under TfL's 500/min app-key cap
const TTL_DAYS      = 7;        // weekly — schedules change on a timetable revision
const MAX_PER_RUN   = 1000;     // ~700 routes fit in one run; cap guards a cold start
const FLUSH_EVERY   = 25;
const RETRIES       = 4;
// High-frequency boundary (TfL): 5+ buses/hour == headway ≤ 12 min.
const HIGH_FREQ_MAX_HEADWAY = 12;

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';

function apiUrl(ep) {
  return `${BASE_URL}${ep}${API_KEY ? `${ep.includes('?') ? '&' : '?'}app_key=${API_KEY}` : ''}`;
}

async function fetchJson(url, retries = RETRIES) {
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch {
      if (i === retries) return null;
      await new Promise(res => setTimeout(res, i * 600));
    }
  }
}

// ── Geometry: route length from the Sequence lineStrings ────────────────────
// Each lineString is a JSON-encoded array of [lng,lat] pairs. Sum the haversine
// distance along the longest one (the main running line for the direction).
const R_EARTH_KM = 6371;
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function lengthKmFromSequence(seq) {
  const raw = seq?.lineStrings ?? [];
  let best = 0;
  for (const ls of raw) {
    let coords;
    try { coords = typeof ls === 'string' ? JSON.parse(ls) : ls; } catch { continue; }
    if (!Array.isArray(coords) || coords.length < 2) continue;
    let km = 0;
    for (let i = 1; i < coords.length; i++) {
      const p = coords[i - 1], q = coords[i];
      if (Array.isArray(p) && Array.isArray(q)) km += haversineKm(p, q);
    }
    if (km > best) best = km;
  }
  return best > 0 ? +best.toFixed(3) : null;
}

// ── Scheduled headways + SWT at a timing point ──────────────────────────────
// Map a TfL schedule day-type name to a bucket (mirrors fetch-frequencies).
function classifyScheduleName(name) {
  const n = (name ?? '').toLowerCase();
  if (/mon/.test(n) && /fri/.test(n)) return 'weekday';
  if (/mon/.test(n) && /thu/.test(n)) return 'weekday';
  if (/weekday/.test(n))              return 'weekday';
  if (/sat/.test(n))                  return 'saturday';
  if (/sun/.test(n))                  return 'sunday';
  if (/fri/.test(n))                  return 'weekday';
  return null;
}

// Sorted minutes-after-midnight departures for a day-type. After-midnight
// journeys are encoded hour ≥ 24 by TfL, so wrap via modulo 24.
function journeysFor(timetable, dayType) {
  const out = [];
  for (const rt of (timetable?.timetable?.routes ?? [])) {
    for (const sch of (rt.schedules ?? [])) {
      if (dayType !== 'any' && classifyScheduleName(sch.name) !== dayType) continue;
      for (const j of (sch.knownJourneys ?? [])) {
        const h = Number(j.hour), m = Number(j.minute);
        if (Number.isFinite(h) && Number.isFinite(m)) out.push((h % 24) * 60 + m);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// Consecutive headways (mins) within [startMin,endMin). Wrap-past-midnight aware.
// Drops non-positive and >120-min gaps (cross-window noise / overnight breaks).
function headwaysInBand(mins, startMin, endMin) {
  const inBand = (t) => startMin <= endMin ? (t >= startMin && t < endMin) : (t >= startMin || t < endMin);
  const band = mins.filter(inBand);
  const diffs = [];
  for (let i = 1; i < band.length; i++) {
    let d = band[i] - band[i - 1];
    if (d <= 0) d += 1440;
    if (d > 0 && d <= 120) diffs.push(d);
  }
  return diffs;
}

// SWT = Σ(h²) / (2·Σh) — TfL's Scheduled Waiting Time over scheduled headways.
function swtFromHeadways(headways) {
  if (!headways.length) return null;
  let sumSq = 0, sum = 0;
  for (const h of headways) { sumSq += h * h; sum += h; }
  if (sum <= 0) return null;
  return +(sumSq / (2 * sum)).toFixed(2);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Derive the schedule signals from a timetable. Representative window is the
// weekday off-peak (10:00–16:00) — the same window fetch-frequencies bands on —
// falling back to AM peak, PM peak, Saturday, then any overnight service so
// night-only routes still classify.
function deriveSchedule(timetable) {
  const weekday  = journeysFor(timetable, 'weekday');
  const saturday = journeysFor(timetable, 'saturday');
  const anyDay   = journeysFor(timetable, 'any');
  const windows = [
    headwaysInBand(weekday,  10 * 60, 16 * 60),
    headwaysInBand(weekday,   7 * 60, 10 * 60),
    headwaysInBand(weekday,  16 * 60, 19 * 60),
    headwaysInBand(saturday,  9 * 60, 19 * 60),
    headwaysInBand(anyDay,   23 * 60,  5 * 60),
    headwaysInBand(weekday,   0,       5 * 60),
  ];
  const headways = windows.find(w => w.length >= 1) ?? [];
  if (!headways.length) return null;
  const swt = swtFromHeadways(headways);
  const headwayMin = mean(headways);
  // Scheduled trips/day at this timing point = count of weekday departures
  // (fallback to the busiest available day-type if there's no weekday service).
  const scheduledTrips = weekday.length || saturday.length || anyDay.length || null;
  const serviceClass = headwayMin != null && headwayMin <= HIGH_FREQ_MAX_HEADWAY
    ? 'high-frequency' : 'low-frequency';
  return {
    service_class:   serviceClass,
    swt_minutes:     swt,
    headway_min:     headwayMin != null ? +headwayMin.toFixed(1) : null,
    scheduled_trips: scheduledTrips,
  };
}

// ── Per-route fetch: sequence (timing point + length) then timetable ────────
async function fetchRouteSchedule(id) {
  // Outbound sequence gives us a representative stop + the running geometry.
  const seq = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Route/Sequence/outbound?excludeCrowding=true`));
  if (!seq) return { status: 404 };
  const stops = seq?.stopPointSequences?.[0]?.stopPoint ?? [];
  // Use a mid-route stop as the timing point where possible — endpoints can be
  // stand/layover points with irregular departures; the middle is more
  // representative of through-service headways. Fall back to the first stop.
  const tpStop = stops.length ? stops[Math.floor(stops.length / 2)] : null;
  const stopId = tpStop?.id ?? tpStop?.stationId ?? stops[0]?.id ?? stops[0]?.stationId ?? null;
  const lengthKm = lengthKmFromSequence(seq);
  if (!stopId) return { status: 'no_stop', length_km: lengthKm };

  const tt = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Timetable/${encodeURIComponent(stopId)}`));
  const derived = tt ? deriveSchedule(tt) : null;
  if (!derived) return { status: 'no_timetable', timing_point_stop_id: stopId, length_km: lengthKm };

  const scheduledKm = (derived.scheduled_trips != null && lengthKm != null)
    ? +(derived.scheduled_trips * lengthKm).toFixed(2)
    : null;

  return {
    ...derived,
    timing_point_stop_id: stopId,
    length_km:            lengthKm,
    scheduled_km:         scheduledKm,
    status:               200,
  };
}

// ── Cache freshness ─────────────────────────────────────────────────────────
function isFresh(cached, cutoffMs) {
  if (!cached?.lastCheckedAt) return false;
  // 200 (parsed) and 404 (no sequence) are sticky; error states retry next run.
  if (cached.status !== 200 && cached.status !== 404) return false;
  const ts = new Date(cached.lastCheckedAt).getTime();
  return Number.isFinite(ts) && ts >= cutoffMs;
}

function buildOutput(cache, fetched, errored) {
  return {
    generatedAt:    new Date().toISOString(),
    ttlDays:        TTL_DAYS,
    totalRoutes:    Object.keys(cache.routes).length,
    fetchedThisRun: fetched,
    errored,
    routes:         cache.routes,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const limit = (() => {
    const i = process.argv.indexOf('--limit');
    return i !== -1 ? parseInt(process.argv[i + 1], 10) : null;
  })();
  const force = process.argv.includes('--force');

  console.log('Fetching bus lines...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  let ids = [...new Set((lines ?? []).map(l => String(l.id).toUpperCase()))].sort();
  if (!ids.length) {
    // Soft-fail: TfL unreachable. Keep whatever's cached; don't blank the file.
    console.warn('No bus lines returned by TfL — keeping cached schedule, exiting.');
    return;
  }
  if (Number.isFinite(limit)) ids = ids.slice(0, limit);
  console.log(`  ${ids.length} routes`);

  const cache = loadJsonCache(OUT_PATH, { routes: {} });
  if (!cache.routes) cache.routes = {};
  const cutoff = force ? -Infinity : Date.now() - TTL_DAYS * 86_400_000;

  // never-fetched first, then oldest-checked, capped at MAX_PER_RUN.
  const stale = ids.filter(id => !isFresh(cache.routes[id], cutoff));
  stale.sort((a, b) => (cache.routes[a]?.lastCheckedAt ?? '').localeCompare(cache.routes[b]?.lastCheckedAt ?? ''));
  const toFetch = stale.slice(0, MAX_PER_RUN);
  console.log(`Stale: ${stale.length}; processing ${toFetch.length} this run (cap ${MAX_PER_RUN}, TTL ${TTL_DAYS}d)`);

  if (!toFetch.length) {
    console.log('Cache fully warm — nothing to fetch.');
    atomicWriteJson(OUT_PATH, buildOutput(cache, 0, 0));
    return;
  }

  let fetched = 0, errored = 0;
  installSignalFlush(() => atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored)));

  const minInterval = Math.ceil(60_000 / REQS_PER_MIN);
  let nextSlot = Date.now();

  for (const id of toFetch) {
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextSlot = Date.now() + minInterval;

    const now = new Date().toISOString();
    try {
      const res = await fetchRouteSchedule(id);
      cache.routes[id] = { ...res, lastCheckedAt: now };
      if (res.status === 200) fetched++;
      else if (res.status !== 404) errored++;   // 404 = legitimately no route sequence
    } catch (err) {
      // Per-route soft-fail: keep last-good, mark the error, move on.
      cache.routes[id] = { ...(cache.routes[id] ?? {}), lastCheckedAt: now, status: 'error', error: err.message };
      errored++;
    }

    if ((fetched + errored) % FLUSH_EVERY === 0) {
      atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored));
      console.log(`  ${fetched + errored}/${toFetch.length}  ok=${fetched} err=${errored} (flushed)`);
    }
  }

  atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored));
  console.log(`Done: ok=${fetched} err=${errored}  total cached=${Object.keys(cache.routes).length}`);
}

main().catch(err => {
  // Soft-fail: a schedule refresh is best-effort. The cache holds last-good and
  // the downstream build degrades to whatever schedule rows already exist.
  console.warn(`fetch-schedule soft-failed: ${err.message}`);
  process.exit(0);
});
