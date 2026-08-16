/**
 * build-vehicle-assignments.js — yesterday's per-vehicle daily route
 * assignments from the continuous tracker's trip log.
 *
 * The once-daily fleet sample (08:37) catches each bus on ONE route; the
 * trip log sees every trip all day, so a bus that works route A in the
 * morning and route B at night yields one row per route it worked:
 * (registration, route, day) with first/last-seen, trip count, observed km.
 * Upserts vehicle_route_assignments_daily (migration 0033) — persisting the
 * intra-day allocation story before the 16-day log rotation discards it.
 *
 * Runs chained on the 00:37 UTC task (package.json build-reliability).
 * Soft-fails on every missing prerequisite: no trip log, partial collector
 * day, no warehouse env, missing table — warn and exit 0.
 *
 *   node scripts/build-vehicle-assignments.js [--day=YYYY-MM-DD]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_lib/env.js';
import { readJsonl, groupAssignments } from './_lib/tracking-day.js';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'tracking');

const WAREHOUSE_URL = process.env.WAREHOUSE_URL ?? '';
const WAREHOUSE_SERVICE_KEY = process.env.WAREHOUSE_SERVICE_KEY ?? '';
const BATCH = 500;
const MIN_DAY_TRIPS = 500;        // same partial-day refusal as the other tracked-day builders

const argDay = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const day = argDay || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function main() {
  const trips = readJsonl(path.join(DIR, `trips-${day}.jsonl`));
  if (!trips) { console.warn(`build-vehicle-assignments: no trip log for ${day} — collector not running here; skipping.`); return; }
  if (trips.length < MIN_DAY_TRIPS) { console.warn(`build-vehicle-assignments: only ${trips.length} trips logged for ${day} (<${MIN_DAY_TRIPS}) — partial collector day; refusing to write.`); return; }
  if (!WAREHOUSE_URL || !WAREHOUSE_SERVICE_KEY) { console.warn('build-vehicle-assignments: warehouse env not configured — skipping.'); return; }

  const rows = groupAssignments(trips, day).map((r) => ({ ...r, extracted_at: new Date().toISOString() }));
  if (!rows.length) { console.warn('build-vehicle-assignments: nothing computable — skipping.'); return; }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(WAREHOUSE_URL, WAREHOUSE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('vehicle_route_assignments_daily').upsert(rows.slice(i, i + BATCH), { onConflict: 'registration,route_id,day', ignoreDuplicates: false });
    if (error) {
      if (/vehicle_route_assignments_daily|schema cache|does not exist/i.test(error.message)) { console.warn(`build-vehicle-assignments: table missing (migration 0033 pending) — ${error.message}`); return; }
      throw new Error(`vehicle_route_assignments_daily upsert failed at row ${i}: ${error.message}`);
    }
  }
  const regs = new Set(rows.map((r) => r.registration));
  const multi = [...regs].filter((reg) => rows.filter((r) => r.registration === reg).length > 1).length;
  console.log(`build-vehicle-assignments ${day}: ${rows.length} assignments · ${regs.size} vehicles · ${multi} worked more than one route`);
}

main().catch((err) => { console.warn('build-vehicle-assignments soft-failed:', err.message); });
