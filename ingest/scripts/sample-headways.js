/**
 * sample-headways.js — Frequent, light sampler of LIVE arrival predictions,
 * written to Supabase (NOT committed to git).
 *
 * The raw feed behind Atlas's own reliability estimates. Runs every ~30 min
 * across the service day and, for each bus route, records ONE row per
 * (route, timing-point stop, vehicle) carrying that vehicle's soonest predicted
 * arrival at the timing point. Accumulated over a day, these rows let
 * build-reliability.js reconstruct OBSERVED headways (sort a stop's distinct
 * vehicle passings by time, diff consecutive) → AWT → EWT, and count distinct
 * vehicle-trips → operated mileage.
 *
 * Mirrors sample-vehicles.js exactly in shape: TfL /Arrivals → Supabase only,
 * no DVLA, no geometry, no git. Cheap (~2 min). Soft-fails to a no-op if
 * BUS_API_KEY or the Supabase env vars are missing.
 *
 * Design notes:
 *   • Timing point: we use the route's representative timing-point stop from
 *     route-schedule.json where available (so the observed headways line up
 *     with the SCHEDULED headways fetch-schedule.js measured at the same stop).
 *     Falls back to /Arrivals' own stop ids when no schedule row exists yet.
 *   • One row per (route, stop, vehicle): /Line/{id}/Arrivals returns one
 *     prediction per (vehicle, stop) pair; we keep each vehicle's SOONEST
 *     prediction at each timing-point stop. expected_at + recorded_at together
 *     let the builder recover a passing time.
 *   • Rolling retention: rows older than RETENTION_DAYS are pruned each run so
 *     arrival_samples stays bounded on the free tier (it is high-volume).
 *
 * ACCURACY CAVEAT: expectedArrival is TfL's PREDICTION, not a measured
 * departure; periodic sampling under-observes short headways. These samples
 * reconstruct an ESTIMATE of observed headways, not TfL's measured AWT.
 *
 * Run: npm run sample-headways
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const BASE_URL       = 'https://api.tfl.gov.uk';
const SCRIPT         = 'sample-headways';
const CONC           = 4;
const REQS_PER_MIN   = 480;   // TfL allows 500/min with an app key — sweep the network faster
const RETENTION_DAYS = 3;     // only need a trailing window to rebuild daily headways
const BATCH          = 500;
// Denser sampling within ONE run. GitHub Actions can't cron faster than ~5 min and the
// */30 sampler snapshot misses most buses on ≤12-min high-frequency headways, which is the
// dominant cause of inflated EWT (see ingest/RELIABILITY-METHODOLOGY.md). So take several
// sweeps per invocation, spaced a few minutes apart — each a distinct timestamp — to catch
// the buses that actually pass during the window. Tunable via env; defaults stay well inside
// the 30-min cron and TfL rate limits. SWEEPS=1 reproduces the old single-snapshot behaviour.
const SWEEPS           = Math.max(1, Number(process.env.SAMPLE_SWEEPS ?? 4));
const SWEEP_INTERVAL_MS = Math.max(30, Number(process.env.SAMPLE_SWEEP_INTERVAL_SEC ?? 180)) * 1000;

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';
const SUPABASE_URL              = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// Reg-plate validation — reuse the shared definition so vehicle_id is the same
// shape the sightings collectors accept (rejects bonnet numbers / train ids).
import { BUS_REG_RE } from './_lib/arrivals.js';

function apiUrl(ep) {
  return `${BASE_URL}${ep}${API_KEY ? `${ep.includes('?') ? '&' : '?'}app_key=${API_KEY}` : ''}`;
}

async function fetchJson(url, retries = 4) {
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch {
      if (i === retries) return null;
      await new Promise(res => setTimeout(res, i * 800));
    }
  }
}

// Pull the route → timing-point stop map from Supabase route_schedule so our
// observed headways are measured at the SAME stop as the scheduled ones.
// Best-effort: if it's empty (schedule not yet built) we fall back to recording
// arrivals at whatever stops the /Arrivals feed reports.
async function loadTimingPoints(supabase) {
  const map = {};   // route → Set(stop ids) of QSI points to observe
  try {
    const { data, error } = await supabase
      .from('route_schedule')
      .select('route_id, timing_point_stop_id, qsi_point_stop_ids');
    if (error) throw error;
    for (const r of (data ?? [])) {
      const ids = new Set();
      // prefer the multi-point QSI set (migration 0021); fall back to the single timing point
      const qsi = Array.isArray(r.qsi_point_stop_ids) ? r.qsi_point_stop_ids : null;
      if (qsi) for (const s of qsi) { if (s) ids.add(String(s)); }
      if (r.timing_point_stop_id) ids.add(String(r.timing_point_stop_id));
      if (ids.size) map[String(r.route_id).toUpperCase()] = ids;
    }
  } catch (err) {
    console.warn(`  route_schedule QSI points unavailable (${err.message}) — using feed stop ids`);
  }
  return map;
}

// From one route's /Arrivals payload, keep each vehicle's SOONEST prediction at
// the route's timing-point stop (or, if none known, at every stop). Returns
// rows ready for arrival_samples.
function rowsFromArrivals(routeId, arrivals, stopSet, recordedAt) {
  if (!Array.isArray(arrivals)) return [];
  // soonest expected per (stop, vehicle)
  const soonest = new Map();   // key `${stop}|${reg}` → { stopId, reg, dir, expected }
  for (const p of arrivals) {
    const stopId = String(p?.naptanId ?? '');
    if (stopSet && stopSet.size && !stopSet.has(stopId)) continue;   // restrict to QSI points
    const reg = String(p?.vehicleId ?? '').toUpperCase().replace(/\s+/g, '');
    if (!BUS_REG_RE.test(reg)) continue;
    const expected = p?.expectedArrival ? new Date(p.expectedArrival) : null;
    if (!expected || Number.isNaN(expected.getTime())) continue;
    const key = `${stopId}|${reg}`;
    const prev = soonest.get(key);
    if (!prev || expected < prev.expected) {
      soonest.set(key, { stopId, reg, dir: p?.direction ?? null, expected });
    }
  }
  const rows = [];
  for (const { stopId, reg, dir, expected } of soonest.values()) {
    rows.push({
      route_id:    routeId,
      stop_id:     stopId || null,
      direction:   dir,
      vehicle_id:  reg,
      expected_at: expected.toISOString(),
      recorded_at: recordedAt,
    });
  }
  return rows;
}

async function main() {
  if (!API_KEY) {
    console.warn('BUS_API_KEY missing — cannot sample arrivals. Skipping.');
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase env not configured — nowhere to write samples. Skipping.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('Fetching bus lines...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  const ids = [...new Set((lines ?? []).map(l => String(l.id).toUpperCase()))].sort();
  if (!ids.length) {
    console.warn('No bus lines returned by TfL — skipping (nothing to sample).');
    return;
  }
  console.log(`  ${ids.length} routes`);

  const timingPoints = await loadTimingPoints(supabase);
  console.log(`  ${Object.keys(timingPoints).length} routes have a known timing point`);

  const minInterval = Math.ceil(60_000 / REQS_PER_MIN);
  let nextSlot = Date.now();

  // One sweep = one /Arrivals snapshot of every route, rate-limited, sharing one timestamp.
  async function sweep(recordedAt) {
    let idx = 0, withObs = 0;
    const rows = [];
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= ids.length) break;
        const wait = nextSlot - Date.now();
        nextSlot = Math.max(Date.now(), nextSlot) + minInterval;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const id = ids[i];
        const arr = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Arrivals`));
        const sr = rowsFromArrivals(id, arr, timingPoints[id] ?? null, recordedAt);
        if (sr.length) { rows.push(...sr); withObs++; }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    return { rows, withObs };
  }

  // Take SWEEPS sweeps spaced SWEEP_INTERVAL apart — denser coverage within this run.
  const rows = [];
  for (let s = 0; s < SWEEPS; s++) {
    if (s > 0) await new Promise(r => setTimeout(r, SWEEP_INTERVAL_MS));
    const { rows: sr, withObs } = await sweep(new Date().toISOString());
    rows.push(...sr);
    console.log(`  sweep ${s + 1}/${SWEEPS}: ${sr.length} rows, ${withObs} routes with observations`);
  }
  console.log(`Collected ${rows.length} arrival samples across ${SWEEPS} sweep(s).`);

  // ── Write — plain insert (append-only; the builder dedupes downstream) ──────
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('arrival_samples').insert(chunk);
    if (error) throw new Error(`arrival_samples insert failed at row ${i}: ${error.message}`);
    written += chunk.length;
  }
  console.log(`Wrote ${written} rows to arrival_samples.`);

  // ── Prune — keep the rolling window bounded on the free tier ────────────────
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { error: pruneErr } = await supabase
    .from('arrival_samples')
    .delete()
    .lt('recorded_at', cutoff);
  if (pruneErr) console.warn(`  Prune (>${RETENTION_DAYS}d) failed: ${pruneErr.message}`);
  else console.log(`Pruned arrival_samples older than ${cutoff}.`);
}

// Soft-fail: a sampling run is best-effort. Never exit non-zero — a missed
// sample just means a slightly sparser headway reconstruction, not a break.
main().catch(err => { console.warn('sample-headways soft-failed:', err.message); });
