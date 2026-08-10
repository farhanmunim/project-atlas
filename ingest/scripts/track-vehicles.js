/**
 * track-vehicles.js — continuous BODS SIRI-VM collector (the lost-mileage eye).
 *
 * A long-lived daemon, unlike every other ingest script: it polls the whole-
 * London vehicle feed every POLL_SEC, runs each vehicle through the trip state
 * machine (_lib/trip-tracker.js), and appends completed trips to a daily JSONL
 * on the persistent volume, plus hourly per-operator vehicle counts for the
 * feed-health gate. build-lost-mileage.js turns yesterday's log into the
 * route_lost_mileage_daily warehouse rows at 00:37 UTC.
 *
 * Ops model (SELF-HOSTING.md): started via a Coolify Scheduled Task
 *   sh scripts/run-task.sh track-vehicles npm run track-vehicles     (cron: every 30 min)
 * run-task.sh's mkdir lock makes every firing while the daemon lives a no-op;
 * the first firing after a crash/redeploy restarts it (≤30 min gap, which the
 * feed-health gate then reports as unmeasured, never as lost). SIGTERM
 * checkpoints open trips; restart within STATE_MAX_AGE resumes them.
 *
 * Politeness: BODS refreshes ~10 s and asks not to poll faster — we poll every
 * 25 s (one third of the app's edge-cache pressure), identified UA, backoff on
 * failure. Requires BODS_API_KEY (first use of BODS in ingest — add it to the
 * Coolify atlas-ingest environment).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_lib/env.js';
import { userAgentHeaders, fetchWithTimeout as httpFetch } from './_lib/http.js';
import { installSignalFlush } from './_lib/cache.js';
import { TripTracker } from './_lib/trip-tracker.js';

loadEnv();
const SCRIPT = 'track-vehicles';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'tracking');

const BODS_KEY = process.env.BODS_API_KEY ?? '';
const ATLAS_API = (process.env.ATLAS_API_BASE ?? 'https://atlas.farhan.app/api/v1').replace(/\/+$/, '');
const SIRI = 'https://data.bus-data.dft.gov.uk/api/v1/datafeed/';
const BBOX = '-0.55,51.25,0.30,51.71';

const POLL_MS = 25_000;
const GEO_REFRESH_MS = 24 * 3600_000;
const CHECKPOINT_EVERY = 12;          // sweeps (~5 min) between state checkpoints
const STATE_MAX_AGE_MS = 30 * 60_000; // resume open trips only if the checkpoint is this fresh
const RETENTION_DAYS = 16;
const LOG_EVERY = 40;                 // terse: one status line per ~17 min

if (!BODS_API_KEY_ok()) process.exit(0);
function BODS_API_KEY_ok() {
  if (BODS_KEY) return true;
  console.warn('track-vehicles: BODS_API_KEY not set — collector cannot run (add it to the atlas-ingest environment).');
  return false;
}

fs.mkdirSync(DIR, { recursive: true });
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const tripsFile = (day) => path.join(DIR, `trips-${day}.jsonl`);
const healthFile = (day) => path.join(DIR, `feedhealth-${day}.json`);
const STATE_FILE = path.join(DIR, 'state.json');

// ── SIRI-VM parse (same wire logic as the edge function) ─────────────────────
const sTag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };
function parseSiriVm(xml) {
  const out = [];
  for (const b of xml.match(/<VehicleActivity>[\s\S]*?<\/VehicleActivity>/g) || []) {
    const j = (b.match(/<MonitoredVehicleJourney>([\s\S]*?)<\/MonitoredVehicleJourney>/) || [])[1] || b;
    const lat = parseFloat(sTag(j, 'Latitude')), lng = parseFloat(sTag(j, 'Longitude'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ reg: sTag(j, 'VehicleRef'), publishedLine: sTag(j, 'PublishedLineName'),
      direction: sTag(j, 'DirectionRef'), lat, lng, operatorRef: sTag(j, 'OperatorRef'),
      recordedAt: sTag(b, 'RecordedAtTime') });
  }
  return out;
}

const fetchWithTimeout = (url, ms = 30_000) => httpFetch(url, { headers: userAgentHeaders(SCRIPT) }, ms);

// route geometry from our own public API → { NAME: { "1": coords, "2": coords } }
async function fetchGeometry() {
  const r = await fetchWithTimeout(`${ATLAS_API}/routes-overview`);
  if (!r.ok) throw new Error(`routes-overview HTTP ${r.status}`);
  const gj = await r.json();
  const geo = {};
  for (const f of gj.features || []) {
    const name = String(f.properties?.name || '').toUpperCase();
    const dir = String(f.properties?.direction || '');
    if (name && (dir === '1' || dir === '2') && f.geometry?.coordinates?.length >= 2)
      (geo[name] ||= {})[dir] = f.geometry.coordinates;
  }
  if (Object.keys(geo).length < 300) throw new Error(`geometry too small (${Object.keys(geo).length} routes)`);
  return geo;
}

// ── state persistence (open trips survive restarts/redeploys) ───────────────
function saveState(tracker, healthByDay) {
  const open = [...tracker.state.values()];
  try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ at: Date.now(), open, health: healthByDay })); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); }
  catch (e) { console.warn('state save failed:', e.message); }
}
function restoreState(tracker) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Date.now() - s.at > STATE_MAX_AGE_MS) return {};
    for (const st of s.open || []) tracker.state.set(st.reg, st);
    console.log(`resumed ${tracker.state.size} open trips from checkpoint (${Math.round((Date.now() - s.at) / 60000)} min old)`);
    return s.health || {};
  } catch { return {}; }
}

function appendTrips(trips) {
  const byDay = {};
  for (const t of trips) (byDay[dayOf(Date.parse(t.endAt))] ||= []).push(t);
  for (const [day, list] of Object.entries(byDay))
    fs.appendFileSync(tripsFile(day), list.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

function prune() {
  const cutoff = dayOf(Date.now() - RETENTION_DAYS * 86_400_000);
  for (const f of fs.readdirSync(DIR)) {
    const m = /^(?:trips|feedhealth)-(\d{4}-\d{2}-\d{2})\./.exec(f);
    if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(DIR, f)); } catch {} }
  }
}

async function main() {
  console.log(`track-vehicles: polling BODS every ${POLL_MS / 1000}s · geometry from ${ATLAS_API}`);
  let geo = await fetchGeometry();
  let geoAt = Date.now();
  const tracker = new TripTracker(geo);
  // health[day][operatorRef][hour] = max vehicles seen in any single sweep that hour
  let health = restoreState(tracker);
  let sweeps = 0, tripsOut = 0, failStreak = 0, lastDay = dayOf(Date.now());

  // Shutdown = checkpoint OPEN trips only (they resume from state, or age out if the
  // restart is >STATE_MAX_AGE away). Never also append them: a resumed trip would then
  // be written twice — once truncated at shutdown, once complete after resume.
  installSignalFlush(() => { saveState(tracker, health); console.log(`SIGTERM: checkpointed ${tracker.state.size} open trips`); });

  while (true) {
    const t0 = Date.now();
    try {
      if (t0 - geoAt > GEO_REFRESH_MS) { try { geo = await fetchGeometry(); tracker.geo = geo; tracker.lineLenKm.clear(); geoAt = t0; } catch (e) { console.warn('geometry refresh failed (keeping current):', e.message); geoAt = t0; } }
      const r = await fetchWithTimeout(`${SIRI}?${new URLSearchParams({ api_key: BODS_KEY, boundingBox: BBOX })}`);
      if (!r.ok) throw new Error(`BODS HTTP ${r.status}`);
      const vehicles = parseSiriVm(await r.text());
      const done = tracker.update(vehicles, t0);
      if (done.length) { appendTrips(done); tripsOut += done.length; }
      // feed health: per-operator max-per-sweep vehicle count for this hour
      const day = dayOf(t0), hour = new Date(t0).getUTCHours();
      const counts = {};
      for (const v of vehicles) if (v.operatorRef) counts[v.operatorRef] = (counts[v.operatorRef] || 0) + 1;
      const dh = (health[day] ||= {});
      for (const [op, n] of Object.entries(counts)) { const oh = (dh[op] ||= {}); if (n > (oh[hour] || 0)) oh[hour] = n; }
      if (day !== lastDay) { try { fs.writeFileSync(healthFile(lastDay), JSON.stringify(health[lastDay] || {})); } catch {} delete health[lastDay]; lastDay = day; prune(); }
      try { fs.writeFileSync(healthFile(day), JSON.stringify(dh)); } catch {}
      failStreak = 0;
      sweeps++;
      if (sweeps % CHECKPOINT_EVERY === 0) saveState(tracker, health);
      if (sweeps % LOG_EVERY === 0) console.log(`${new Date().toISOString()} sweep ${sweeps}: ${vehicles.length} vehicles · ${tracker.state.size} open trips · ${tripsOut} completed`);
    } catch (e) {
      failStreak++;
      if (failStreak <= 3 || failStreak % 20 === 0) console.warn(`sweep failed (streak ${failStreak}): ${e.message}`);
    }
    const wait = Math.max(5_000, POLL_MS - (Date.now() - t0)) + (failStreak ? Math.min(failStreak * 5_000, 120_000) : 0);
    await new Promise((res) => setTimeout(res, wait));
  }
}

main().catch((err) => { console.warn('track-vehicles soft-failed:', err.message); });
