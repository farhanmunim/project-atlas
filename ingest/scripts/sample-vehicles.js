/**
 * sample-vehicles.js — Daily snapshot of which registration is running which
 * route, written to Supabase (NOT committed to git).
 *
 * The weekly refresh (fetch-route-vehicles.js) only samples the active fleet
 * once a week, so it takes weeks to tell a route's recurring core fleet from a
 * one-off cover bus. This script runs DAILY, captures the same TfL /Arrivals
 * snapshot, and appends it to the rolling `route_vehicle_sightings` table. The
 * weekly build then reads those daily samples back (backfill-route-vehicle-
 * sightings.js) to compute a dense, accurate per-route `days` recurrence count.
 *
 * Design notes:
 *   • No DVLA, no geometry, no git commit — just TfL → Supabase. Cheap (~2 min).
 *   • Rolling retention: rows older than RETENTION_DAYS are pruned each run so
 *     the table stays bounded on the Supabase free tier. The PERMANENT weekly
 *     analytics log (route_vehicle_observations) is untouched.
 *   • Soft-fail: if BUS_API_KEY or the Supabase env vars are missing, it logs
 *     and exits 0. The weekly pipeline degrades gracefully to its own snapshot.
 *
 * Run: npm run sample-vehicles
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';
import { extractRegs } from './_lib/arrivals.js';

const BASE_URL  = 'https://api.tfl.gov.uk';
const SCRIPT    = 'sample-vehicles';
const CONC      = 4;
const REQS_PER_MIN  = 300;
const RETENTION_DAYS = 70;   // a touch beyond the 56-day core-fleet window
const BATCH     = 500;       // Supabase upsert chunk size

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';
const WAREHOUSE_URL         = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';

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

async function main() {
  if (!API_KEY) {
    console.warn('BUS_API_KEY missing — cannot sample arrivals. Skipping.');
    return;
  }
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) {
    console.warn('Warehouse env not configured — nowhere to write samples. Skipping.');
    return;
  }

  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, {
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

  // One timestamp for the whole run so all of today's rows share an observed_at
  // (distinct from other days → contributes exactly one to each reg's `days`).
  const sampledAt = new Date().toISOString();

  const minInterval = Math.ceil(60_000 / REQS_PER_MIN);
  let nextSlot = Date.now();
  let idx = 0, done = 0, withObs = 0;
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
      const regs = extractRegs(arr);
      if (regs.length) {
        for (const reg of regs) rows.push({ route_id: id, registration: reg, observed_at: sampledAt });
        withObs++;
      }
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${ids.length}  withObs=${withObs}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`Collected ${rows.length} observations across ${withObs} routes.`);

  // ── Write — upsert with ignoreDuplicates so a same-day re-run is a no-op ────
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('route_vehicle_sightings')
      .upsert(chunk, { onConflict: 'route_id,registration,observed_at', ignoreDuplicates: true });
    if (error) throw new Error(`route_vehicle_sightings insert failed at row ${i}: ${error.message}`);
    written += chunk.length;
  }
  console.log(`Wrote up to ${written} rows to route_vehicle_sightings.`);

  // ── Prune — keep the rolling window bounded on the free tier ────────────────
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { error: pruneErr } = await supabase
    .from('route_vehicle_sightings')
    .delete()
    .lt('observed_at', cutoff);
  if (pruneErr) console.warn(`  Prune (>${RETENTION_DAYS}d) failed: ${pruneErr.message}`);
  else console.log(`Pruned sightings older than ${cutoff}.`);
}

// Soft-fail: a sampling run is best-effort. Never exit non-zero — a failed day
// just means slightly sparser recurrence data, not a broken pipeline.
main().catch(err => { console.warn('sample-vehicles soft-failed:', err.message); });
