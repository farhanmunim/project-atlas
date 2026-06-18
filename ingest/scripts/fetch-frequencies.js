import { sanitizeRecord } from './_lib/sanitize.js';
/**
 * fetch-frequencies.js — Per-route frequency-band cache
 *
 * For each bus line, calls /Line/{id}/Timetable/{firstStopId} and derives the
 * representative headway (minutes between buses) for whichever service window
 * is most meaningful for that route. Daytime routes use the weekday off-peak
 * window; night-only routes use overnight; mixed service routes fall through
 * in that order. The headway is then binned into two categorical bands:
 *
 *   high     ≤ 12 min  (5+ buses/hour — matches "5 or more buses an hour")
 *   low      > 12 min  (matches "4 or fewer buses an hour"; covers the 13–14 min
 *                       gap too, since those routes don't meet the 5+/hr bar)
 *
 * Output: data/frequencies.json — flat map { "1": "high", "N86": "low" }.
 * null means "no published timetable" (distinct from any band).
 *
 * Run: npm run fetch-frequencies
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './_lib/env.js';
import { fetchWithTimeout, userAgentHeaders } from './_lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'frequencies.json');
const BASE_URL = 'https://api.tfl.gov.uk';
const SCRIPT = 'frequencies';

loadEnv();
const API_KEY = process.env.BUS_API_KEY ?? '';

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
    } catch (err) {
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, i * 800));
    }
  }
}

function round1(v) { return Math.round(v * 10) / 10; }

// Bin a representative headway (minutes between buses) into a categorical band.
// Input is the first positive signal from the preference chain; null means "no
// timetable" and returns null so the frontend can render an explicit unknown.
function bandForHeadway(h) {
  if (h == null || h <= 0) return null;
  return h <= 12 ? 'high' : 'low';   // 5+ buses/hour vs fewer
}

// Pick the first positive headway from a preference chain. 0 means "TfL says
// no service in that window" so we skip it rather than reporting 0-min headway.
const firstPositive = (...vals) => vals.find(v => typeof v === 'number' && v > 0) ?? null;

// Expand a TfL "schedule" day-type into a set of minute-of-day departure times.
// The timetable endpoint returns structure: timetable.routes[*].schedules[*]
//   with name ("Monday - Friday"/"Saturday"/"Sunday"), knownJourneys[*]{hour,minute}
// TfL names night-route schedules things like "Saturday Night/Sunday Morning"
// and "Mo-Th Nights/Tu-Fr Morning", which don't match naive weekday/saturday/
// sunday filters. First-match keyword picks the right bucket.
function classifyScheduleName(name) {
  if (/mon/.test(name) && /fri/.test(name)) return 'weekday';
  if (/mon/.test(name) && /thu/.test(name)) return 'weekday';
  if (/weekday/.test(name))                 return 'weekday';
  if (/sat/.test(name))                     return 'saturday';
  if (/sun/.test(name))                     return 'sunday';
  if (/fri/.test(name))                     return 'weekday';
  return null;
}

// Expand TfL schedules for a given day-type into sorted minutes-after-midnight.
// dayType is 'weekday' | 'saturday' | 'sunday' | 'any' (all schedules).
// TfL encodes after-midnight departures as hour ≥ 24 (e.g. 24:18 = 00:18 next
// day) so we wrap via modulo — without it night journeys land at 1400+ minutes
// and miss every band.
function journeysFor(timetable, dayType) {
  const out = [];
  for (const rt of (timetable?.timetable?.routes ?? [])) {
    for (const sch of (rt.schedules ?? [])) {
      const name = (sch.name ?? '').toLowerCase();
      if (dayType !== 'any' && classifyScheduleName(name) !== dayType) continue;
      for (const j of (sch.knownJourneys ?? [])) {
        const h = Number(j.hour), m = Number(j.minute);
        if (Number.isFinite(h) && Number.isFinite(m)) out.push((h % 24) * 60 + m);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

// Compute mean headway in minutes within [startMin, endMin). Returns null when <2 departures.
function headwayInBand(mins, startMin, endMin) {
  // Support wrap-past-midnight bands
  const inBand = (t) => startMin <= endMin
    ? t >= startMin && t < endMin
    : t >= startMin || t < endMin;
  const band = mins.filter(inBand);
  if (band.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < band.length; i++) {
    let d = band[i] - band[i - 1];
    if (d <= 0) d += 1440;
    if (d > 0 && d <= 120) diffs.push(d);
  }
  if (!diffs.length) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return round1(mean);
}

async function main() {
  console.log('Fetching bus lines...');
  const lines = await fetchJson(apiUrl('/Line/Mode/bus'));
  const ids = [...new Set((lines ?? []).map(l => String(l.id).toUpperCase()))].sort();
  console.log(`  ${ids.length} routes`);

  const out = {};
  let done = 0;

  // Limited concurrency to respect rate limits (~300/min under 500 cap).
  const CONC = 4, MIN_INTERVAL = Math.ceil(60_000 / 300);
  let nextSlot = Date.now();
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= ids.length) break;
      const now = Date.now();
      const wait = nextSlot - now;
      nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      const id = ids[i];
      try {
        // First: find a stop id on this line
        const seq = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Route/Sequence/outbound?excludeCrowding=true`));
        const stops = seq?.stopPointSequences?.[0]?.stopPoint ?? [];
        const stopId = stops[0]?.id ?? stops[0]?.stationId;
        if (!stopId) { done++; continue; }
        const tt = await fetchJson(apiUrl(`/Line/${encodeURIComponent(id)}/Timetable/${encodeURIComponent(stopId)}`));
        if (!tt) { done++; continue; }

        const weekday  = journeysFor(tt, 'weekday');
        const saturday = journeysFor(tt, 'saturday');
        // Overnight service is measured over the union of every schedule that
        // plausibly runs through the small hours. This catches night-only
        // routes (schedules named "Nights" / "Friday Nights") that contain no
        // weekday schedule at all.
        const nightAll = journeysFor(tt, 'any');

        // Preference chain: weekday off-peak → weekday AM peak → weekday PM
        // peak → Saturday → overnight. Whichever window first yields a real
        // headway is the route's representative signal for banding.
        const signal = firstPositive(
          headwayInBand(weekday,  10 * 60, 16 * 60),
          headwayInBand(weekday,   7 * 60, 10 * 60),
          headwayInBand(weekday,  16 * 60, 19 * 60),
          headwayInBand(saturday,  9 * 60, 19 * 60),
          headwayInBand(nightAll, 23 * 60,  5 * 60),
          headwayInBand(weekday,   0,       5 * 60),
        );
        out[id] = bandForHeadway(signal);
      } catch (err) {
        // skip
      }
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${ids.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // ── Fallback pass: for any route still missing frequencies, scrape the
  //    matching londonbusroutes.net/times/<id>.htm page. The page contains
  //    HHMM departure columns per stop; we take the first time-row and compute
  //    headways using the same bands as the primary pass.
  const missingIds = ids.filter(id => !out[id]);
  if (missingIds.length) {
    console.log(`  ${missingIds.length} routes missing frequencies — trying londonbusroutes.net fallback`);
    // Build href map from routes.htm so N-prefixed routes resolve to their
    // correct filename (e.g. N1 → times/N001.htm).
    let hrefMap = {};
    try {
      const routesHtml = await (await fetchWithTimeout('http://www.londonbusroutes.net/routes.htm', {
        headers: userAgentHeaders(SCRIPT),
      })).text();
      const re = /<a\s+name=["']?[MN]([A-Z0-9]+)["']?\s+href=["']?([^"'>]+)["']?>([^<]+)<\/a>/gi;
      let mm;
      while ((mm = re.exec(routesHtml)) !== null) {
        const rid = (mm[3] || mm[1]).trim().toUpperCase();
        if (!hrefMap[rid]) hrefMap[rid] = mm[2].trim();
      }
    } catch (err) {
      console.warn(`  routes.htm href map unavailable (${err.message})`);
    }

    let filled = 0;
    for (const id of missingIds) {
      const href = hrefMap[id] || `times/${id}.htm`;
      const url = `http://www.londonbusroutes.net/${href}`;
      try {
        await new Promise(r => setTimeout(r, 250)); // polite pacing
        const res = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
        if (!res.ok) continue;
        const html = await res.text();

        // Each <pre> is one day-type timetable; the site usually orders them
        // Mon-Fri / Sat / Sun. Detect day via nearby heading before each <pre>,
        // falling back to block index.
        const dayTypeOrder = ['weekday', 'saturday', 'sunday'];
        const dayTables = {};
        const preBlocksWithCtx = [];
        let cursor = 0, idx = 0;
        const preIter = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
        let pm;
        while ((pm = preIter.exec(html)) !== null) {
          const before = html.slice(cursor, pm.index).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
          cursor = pm.index + pm[0].length;
          // Use only the tail (just before the <pre>) and prefer explicit
          // heading patterns like "XX Mondays to Fridays towards ..."
          const tail = before.slice(-180);
          let dayType = null;
          if (/nights?/.test(tail)) dayType = 'night';
          else if (/mondays?\s+to\s+fridays?|mon\s*-\s*fri|weekdays?/.test(tail)) dayType = 'weekday';
          else if (/saturdays?/.test(tail)) dayType = 'saturday';
          else if (/sundays?/.test(tail)) dayType = 'sunday';
          if (!dayType) dayType = dayTypeOrder[Math.min(idx, 2)];
          preBlocksWithCtx.push({ dayType, block: pm[1] });
          idx++;
        }

        for (const { dayType, block } of preBlocksWithCtx) {
          if (dayTables[dayType]) continue; // keep first occurrence
          const lines = block.split(/\r?\n/)
            .map(l => l.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' '))
            .filter(l => l.trim());
          // Find first row with at least 3 HHMM tokens
          const timeLine = lines.find(l => (l.match(/\b[0-2]\d[0-5]\d\b/g) || []).length >= 3);
          if (!timeLine) continue;
          const times = (timeLine.match(/\b[0-2]\d[0-5]\d\b/g) || [])
            .map(t => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10));
          dayTables[dayType] = times.sort((a, b) => a - b);
        }

        const weekday  = dayTables.weekday  || [];
        const saturday = dayTables.saturday || [];
        const sunday   = dayTables.sunday   || [];
        const night    = dayTables.night    || [];
        const nightAll = [...weekday, ...saturday, ...sunday, ...night].sort((a, b) => a - b);

        const signal = firstPositive(
          headwayInBand(weekday,  10 * 60, 16 * 60),
          headwayInBand(weekday,   7 * 60, 10 * 60),
          headwayInBand(weekday,  16 * 60, 19 * 60),
          headwayInBand(saturday,  9 * 60, 19 * 60),
          headwayInBand(nightAll, 23 * 60,  5 * 60),
        );
        const band = bandForHeadway(signal);
        if (band) { out[id] = band; filled++; }
      } catch (err) {
        // ignore individual failures
      }
    }
    console.log(`  timetable fallback filled ${filled}/${missingIds.length}`);
  }

  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(sorted)), 'utf8');
  console.log(`Wrote ${Object.keys(sorted).length} routes to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
