/**
 * fetch-route-mps.js -- Per-route Minimum Performance Standards (MPS)
 *
 * TfL publishes a small PDF per route at:
 *   https://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf
 *
 * Each PDF contains, for the trailing 13 4-week periods:
 *   - Current year actuals  (EWT for high-frequency / % On-Time for low-frequency)
 *   - Previous year actuals (same metric, prior FY for comparison)
 *   - Minimum Standard      (the contractual MPS the route is graded against)
 *   - Mileage Operated %    (current actual)
 *   - Mileage Minimum Standard
 *
 * MPS is contract-defined and only changes when a new tender is awarded,
 * so this is a sticky cache: a route already classified is not re-fetched
 * unless its TTL expires OR the PDF's Last-Modified header has moved.
 *
 * Output: data/source/route-mps.json (force-committed across runs)
 *   {
 *     generatedAt, totalRoutes, fetchedThisRun, errored,
 *     mpsTtlDays,
 *     routes: {
 *       [routeId]: {
 *         service_class:        'high-frequency' | 'low-frequency',
 *         ewt_mps_minutes:      number | null,    // high-frequency only
 *         otp_mps_percent:      number | null,    // low-frequency only
 *         mileage_mps_percent:  number | null,    // both
 *         pdf_modified_at:      ISO,
 *         lastCheckedAt:        ISO,
 *         status:               200 | 404 | <error>
 *       }
 *     }
 *   }
 *
 * Run: npm run fetch-route-mps
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithTimeout, headLastModified, userAgentHeaders } from './_lib/http.js';
import { extractPdfRows }                                      from './_lib/pdf.js';
import { loadJsonCache, atomicWriteJson, installSignalFlush }  from './_lib/cache.js';
import { sanitizeRecord }                                      from './_lib/sanitize.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const ROUTES_IDX = path.join(ROOT, 'data', 'routes', 'index.json');
const OUT_PATH   = path.join(ROOT, 'data', 'source', 'route-mps.json');

const SCRIPT     = 'route-mps';
const PDF_URL    = (id) => `https://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-${id}.pdf`;

// ── Config ──────────────────────────────────────────────────────────────────
const MPS_TTL_DAYS    = 28;     // re-check every TfL period (~4 weeks).
const RPS             = 4;      // gentle on TfL's static-PDF host
const MAX_PER_RUN     = 1000;   // cap per run; ~700 routes so a cold start fits
const FLUSH_EVERY     = 50;
const RETRIES         = 3;

// ── PDF download with retries (helper-backed) ───────────────────────────────
async function fetchPdfBuffer(url) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetchWithTimeout(url, { headers: userAgentHeaders(SCRIPT) });
      if (r.status === 404) return { status: 404 };
      if (!r.ok) {
        if (attempt === RETRIES) return { status: r.status };
        await new Promise(s => setTimeout(s, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const lm = r.headers.get('last-modified');
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: 200, buffer: buf, lastModified: lm ? new Date(lm).toISOString() : null };
    } catch (err) {
      if (attempt === RETRIES) return { status: 0, error: err.message };
      await new Promise(s => setTimeout(s, 500 * 2 ** (attempt - 1)));
    }
  }
}

// ── MPS parser ─────────────────────────────────────────────────────────────
// The PDF has two clearly delineated sections, each containing a row labelled
// "Minimum Standard" followed by 13 identical numeric values (the period
// breakdown — same value across every period for a given contract).
//
//   Reliability Performance
//     Header line: "High Frequency - EWT (mins)" or "Low Frequency - % On Time"
//     ...
//     Minimum Standard | 0.70 | 0.70 | ... (13×)
//
//   Mileage Performance
//     ...
//     Minimum Standard | 98.00 | 98.00 | ... (13×)
//
// We walk the rows in order; a "Minimum Standard" row's first numeric value
// is the MPS for the section we're currently in.
function parseMps(rows) {
  let serviceClass = null;
  let section = null;          // 'reliability' | 'mileage'
  let mileageCurrentSeen = false;
  const out = {
    service_class: null,
    ewt_mps_minutes: null,
    otp_mps_percent: null,
    mileage_mps_percent: null,
    // Actual mileage-operated readings for the trailing 13 reporting periods.
    // The MPS PDF carries them in the Mileage Performance section ("Current
    // Year" row, period 7 of last TfL year through period 6 of this one).
    // Headline figures: most recent period (responsive, noisy) and the
    // 13-period mean (smoothed). Both are useful — the latter for trend
    // questions, the former for "what happened last 4 weeks".
    mileage_operated_latest_percent: null,
    mileage_operated_avg_percent:    null,
  };

  // Period-data rows in the PDF look like:
  //   ['P07 24/25 to P06 25/26', '96.25', '97.41', ..., '92.77']   (current year)
  //   ['P07 23/24 to P06 24/25', '92.10', '90.40', ..., '96.93']   (prior year)
  // The first such row in each section is the current year. After
  // splitting off the period label, the remaining cells are the 13
  // chronological period readings (P7 → P6 of the next TfL year).
  function extractPeriodValues(cells) {
    // Some PDFs split the label and numbers across separate row-clusters
    // (sample: row [16] is just the label, row [17] has the 13 numbers).
    // Treat any leading non-numeric cell as the label and pull the numerics.
    const nums = [];
    for (const c of cells) {
      const n = parseFloat(c);
      if (Number.isFinite(n)) nums.push(n);
    }
    return nums.length === 13 ? nums : null;
  }

  // First pass: section state machine + MPS extraction.
  // Track index because mileage-section "Current Year" row may live one row
  // *after* its label cell (PDF text-extraction quirk on some routes).
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.length) continue;
    const flat = cells.join(' ').toLowerCase();

    // Section detection
    if (/reliability\s+performance/i.test(flat)) { section = 'reliability'; mileageCurrentSeen = false; continue; }
    if (/mileage\s+performance/i.test(flat))     { section = 'mileage';     mileageCurrentSeen = false; continue; }

    // Service class detection — appears once near the top of the reliability section
    if (!serviceClass) {
      if (/high\s*frequency/i.test(flat) && /ewt/i.test(flat)) serviceClass = 'high-frequency';
      else if (/low\s*frequency/i.test(flat) && /on\s*time/i.test(flat)) serviceClass = 'low-frequency';
    }

    // Minimum Standard rows: first cell label, remaining cells are numbers (13 periods).
    if (cells.some(c => /^minimum\s*standard$/i.test(c))) {
      let val = null;
      for (const c of cells) {
        const n = parseFloat(c);
        if (Number.isFinite(n) && n > 0) { val = n; break; }
      }
      if (val == null) continue;
      if (section === 'reliability') {
        if (serviceClass === 'high-frequency') out.ewt_mps_minutes = val;
        else if (serviceClass === 'low-frequency') out.otp_mps_percent = val;
      } else if (section === 'mileage') {
        out.mileage_mps_percent = val;
      }
      continue;
    }

    // Mileage current-year readings: the first period-data row (13 numerics)
    // that appears in the mileage section after the section header. The PDF
    // sometimes places the period label and the 13 numerics in the same row
    // (route 1 sample), and sometimes split across consecutive rows (route 1
    // last-year sample shows the split). Either way, the FIRST 13-number row
    // in the mileage section is the current-year reading.
    if (section === 'mileage' && !mileageCurrentSeen) {
      let nums = extractPeriodValues(cells);
      // Split-row fallback: if THIS row is just a period label (no numerics
      // OR a single year number) and the NEXT row has 13 numerics, use the
      // next row.
      if (!nums && rows[i + 1]) {
        const nextNums = extractPeriodValues(rows[i + 1]);
        if (nextNums && /^P\d+\s+\d+\/\d+\s+to\s+P\d+\s+\d+\/\d+$/i.test(cells[0] ?? '')) {
          nums = nextNums;
        }
      }
      if (nums) {
        // Sanity-check the values look like percentages (50-100). Anything
        // outside is almost certainly axis-tick text mistakenly clustered
        // into the row.
        const inRange = nums.filter(v => v >= 50 && v <= 100);
        if (inRange.length === 13) {
          out.mileage_operated_latest_percent = +nums[nums.length - 1].toFixed(2);
          out.mileage_operated_avg_percent    = +(nums.reduce((a, b) => a + b, 0) / 13).toFixed(2);
          mileageCurrentSeen = true;
        }
      }
    }
  }

  out.service_class = serviceClass;
  return out;
}

// ── Cache I/O ──────────────────────────────────────────────────────────────
// Cache load + atomic flush both go through `_lib/cache.js`. The flush
// closes over the running counters so the SIGTERM hook can call it without
// passing args through the signal handler.
function buildOutput(cache, fetchedThisRun, errored) {
  return {
    generatedAt:     new Date().toISOString(),
    mpsTtlDays:      MPS_TTL_DAYS,
    totalRoutes:     Object.keys(cache.routes).length,
    fetchedThisRun,
    errored,
    routes:          cache.routes,
  };
}

function isFresh(cached, cutoffMs) {
  if (!cached?.lastCheckedAt) return false;
  // Entries left in an error state are not "fresh" — they're stuck. Force
  // a retry next run rather than waiting out the full TTL on a broken row.
  // 200 (parsed OK) and 404 (route legitimately has no MPS PDF) are sticky.
  if (cached.status !== 200 && cached.status !== 404) return false;
  const ts = new Date(cached.lastCheckedAt).getTime();
  return Number.isFinite(ts) && ts >= cutoffMs;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ROUTES_IDX)) {
    console.error(`Error: ${ROUTES_IDX} not found. Run fetch-data first.`);
    process.exit(1);
  }
  const idx = JSON.parse(fs.readFileSync(ROUTES_IDX, 'utf8'));
  const allRoutes = (idx.routes ?? []).map(s => String(s).toUpperCase());
  console.log(`Index: ${allRoutes.length} routes`);

  const cache  = loadJsonCache(OUT_PATH, { routes: {} });
  if (!cache.routes) cache.routes = {};   // legacy file shape guard
  const cutoff = Date.now() - MPS_TTL_DAYS * 86_400_000;

  // Order: never-fetched first, then oldest-checked, capped by MAX_PER_RUN.
  const stale = allRoutes.filter(id => !isFresh(cache.routes[id], cutoff));
  stale.sort((a, b) => {
    const ta = cache.routes[a]?.lastCheckedAt ?? '';
    const tb = cache.routes[b]?.lastCheckedAt ?? '';
    return ta.localeCompare(tb);
  });
  const toFetch = stale.slice(0, MAX_PER_RUN);
  console.log(`Stale: ${stale.length} routes; processing ${toFetch.length} this run (cap ${MAX_PER_RUN}, TTL ${MPS_TTL_DAYS}d)`);

  if (!toFetch.length) {
    console.log('Cache fully warm — nothing to fetch.');
    atomicWriteJson(OUT_PATH, buildOutput(cache, 0, 0));
    return;
  }

  let fetched = 0, errored = 0, skippedHead = 0;

  // SIGTERM/SIGINT safe: flush before exit so a CI timeout never loses progress.
  installSignalFlush(() => atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored)));

  const minIntervalMs = Math.ceil(1000 / RPS);
  let nextSlot = Date.now();

  for (const id of toFetch) {
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextSlot = Date.now() + minIntervalMs;

    const url = PDF_URL(id);
    const prev = cache.routes[id] ?? {};

    // HEAD short-circuit — if the PDF hasn't moved since we last parsed it,
    // skip the body. Keeps the fetcher cheap during steady-state runs.
    if (prev.pdf_modified_at) {
      const head = await headLastModified(url, SCRIPT);
      if (head.status === 200 && head.lastModified === prev.pdf_modified_at) {
        cache.routes[id] = { ...prev, lastCheckedAt: new Date().toISOString(), status: 200 };
        skippedHead++;
        continue;
      }
      if (head.status === 404) {
        cache.routes[id] = { ...prev, lastCheckedAt: new Date().toISOString(), status: 404 };
        continue;
      }
    }

    const dl = await fetchPdfBuffer(url);
    const now = new Date().toISOString();
    if (dl.status === 200 && dl.buffer) {
      try {
        const rows = await extractPdfRows(dl.buffer);
        const parsed = parseMps(rows);
        cache.routes[id] = {
          ...parsed,
          pdf_modified_at: dl.lastModified,
          lastCheckedAt:   now,
          status:          200,
        };
        fetched++;
      } catch (err) {
        cache.routes[id] = { ...prev, lastCheckedAt: now, status: 'parse_error', error: err.message };
        errored++;
      }
    } else if (dl.status === 404) {
      // Some routes (e.g. school routes 600-799) genuinely have no MPS PDF
      // published. Cache the 404 so we don't keep hammering.
      cache.routes[id] = { ...prev, lastCheckedAt: now, status: 404 };
    } else {
      cache.routes[id] = { ...prev, lastCheckedAt: now, status: dl.status, error: dl.error ?? null };
      errored++;
    }

    if ((fetched + errored + skippedHead) % FLUSH_EVERY === 0) {
      atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored));
      console.log(`  ${fetched + errored + skippedHead}/${toFetch.length}  ok=${fetched} skip=${skippedHead} err=${errored} (cache flushed)`);
    }
  }

  atomicWriteJson(OUT_PATH, buildOutput(cache, fetched, errored));
  console.log(`Done: ok=${fetched} skip=${skippedHead} err=${errored}  total cached=${Object.keys(cache.routes).length}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
