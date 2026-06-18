/**
 * fetch-route-performance.js — Per-route EWT / OTP from TfL's QSI PDF
 *
 * Source: http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf
 * (the only public per-route bus reliability dataset). Updates ~every 4 weeks
 * (TfL operates a 13-period year, so 12-13 PDFs per year).
 *
 * High-frequency routes (≤12 min headway) get EWT-style metrics:
 *   - SWT  Scheduled Waiting Time
 *   - AWT  Actual Waiting Time
 *   - EWT  Excess Waiting Time (= AWT − SWT)
 *   - %    Mileage Operated
 *
 * Low-frequency routes (timetabled) get OTP-style metrics:
 *   - % On-Time / Early / Late / Non-Arrival
 *   - %   Mileage Operated
 *
 * Output: data/source/route-performance.json
 *   {
 *     generatedAt, sourceUrl, pdfModifiedAt, periodLabel,
 *     periodStart, periodEnd,
 *     routes: { [routeId]: { service_class, ewt_minutes, …, on_time_percent, … } }
 *   }
 *
 * Also writes route-performance-raw.txt (positional dump) for parser debugging.
 *
 * Why pdfjs-dist (not pdf-parse): TfL's PDF was exported from Excel and uses
 * tightly-packed columns. pdf-parse extracts text in column-then-row order,
 * splitting headers like "Scheduled / Waiting / Time / (mins)" into separate
 * lines and scrambling rows. pdfjs-dist gives us the (x, y) of every text
 * fragment so we can cluster items into actual rows by y-coordinate.
 *
 * Run: npm run fetch-route-performance
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithTimeout, headLastModified, userAgentHeaders } from './_lib/http.js';
import { extractPdfRowsByPage }                                 from './_lib/pdf.js';
import { sanitizeRecord }                                       from './_lib/sanitize.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.resolve(__dirname, '..');
const OUT_PATH     = path.join(ROOT, 'data', 'source', 'route-performance.json');
const RAW_PATH     = path.join(ROOT, 'data', 'source', 'route-performance-raw.txt');
const SOURCE_URL   = 'http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf';
const SCRIPT       = 'route-performance';
// 60-second timeout vs the 30s default elsewhere — the QSI PDF is the
// largest single artefact in the pipeline (~1 MB) and TfL's static-PDF host
// occasionally serves it slowly.
const TIMEOUT_MS   = 60_000;

// ── HTTP fetch with timeout ─────────────────────────────────────────────────
async function fetchPdfBuffer() {
  const res = await fetchWithTimeout(SOURCE_URL, {
    headers: userAgentHeaders(SCRIPT),
  }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`PDF fetch failed: HTTP ${res.status}`);
  const lastMod = res.headers.get('last-modified');
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, lastModified: lastMod ? new Date(lastMod).toISOString() : null };
}

// HEAD-only check so we can compare Last-Modified before pulling 1+ MB.
async function fetchPdfHead() {
  const r = await headLastModified(SOURCE_URL, SCRIPT, TIMEOUT_MS);
  return r.status === 200 ? r.lastModified : null;
}

// ── Period parsing (header text) ────────────────────────────────────────────
// Cover and table headers print "Quarter 03 25/26" style — map FY quarter to
// UTC dates (TfL FY runs 1 April → 31 March).
function parsePeriod(text) {
  const m = /Quarter\s+0?(\d)\s+(\d{2})\/(\d{2})/i.exec(text);
  if (!m) return { label: null, start: null, end: null };
  const q = parseInt(m[1], 10);
  const fyStart = 2000 + parseInt(m[2], 10);
  const fyEnd   = 2000 + parseInt(m[3], 10);
  const ranges = {
    1: [`${fyStart}-04-01`, `${fyStart}-06-30`],
    2: [`${fyStart}-07-01`, `${fyStart}-09-30`],
    3: [`${fyStart}-10-01`, `${fyStart}-12-31`],
    4: [`${fyEnd}-01-01`,   `${fyEnd}-03-31`],
  };
  const r = ranges[q];
  return r ? { label: `Q${q} ${m[2]}/${m[3]}`, start: r[0], end: r[1] } : { label: null, start: null, end: null };
}

// PDF row extraction now lives in `_lib/pdf.js` — `extractPdfRowsByPage`
// implements the same y-coord clustering used here previously.

// ── Table-shape detection ───────────────────────────────────────────────────
// A page can carry one of two table types — high-frequency or low-frequency —
// detected by the column-header line. We look at the first ~10 rows of each
// page for a header signature.
function detectTableShape(rows) {
  const headerWindow = rows.slice(0, 12).flat().join(' ').toUpperCase();
  if (/EXCESS\s*WAIT|EWT|SWT/.test(headerWindow))                          return 'high-frequency';
  if (/ON\s*TIME|NON.?ARRIV|DEPART|EARLY|LATE/.test(headerWindow) &&
      !/EWT|SWT|EXCESS/.test(headerWindow))                                return 'low-frequency';
  return null;
}

// Parse a single number cell: strip footnote markers, percent signs, etc.
function parseNumber(s, { max = 1000 } = {}) {
  if (s == null) return null;
  const t = String(s).replace(/[%*†‡§\s,]/g, '');
  if (t === '' || t === '-' || t === 'N/A' || t === 'n/a') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

// Route-id cell match. Real bus routes match this; "Q3", "Total", "QSI" etc.
// must NOT — so we explicitly require a digit somewhere and cap letter count.
const ROUTE_RE = /^(N?[A-Z]{0,2}\d{1,3}[A-Z]?)$/;

function looksLikeRouteId(s) {
  if (!s) return false;
  const t = s.trim().toUpperCase();
  // Reject obvious non-routes
  if (/^(Q\d|TOTAL|ALL|AVERAGE|MEAN|GROUP|HIGH|LOW)$/.test(t)) return false;
  return ROUTE_RE.test(t);
}

// Walk a page's rows in visual order and emit per-route records, mapping the
// raw cell values into the right metric slots based on the page's table shape.
function parsePage(rows, shape, out) {
  if (!shape) return;

  for (const cells of rows) {
    if (cells.length < 3) continue;

    // First cell that matches a route-id pattern marks the start of a data row.
    // Some PDFs prefix rows with leading whitespace cells; tolerate that.
    let idx = cells.findIndex(looksLikeRouteId);
    if (idx === -1) continue;
    const routeId = cells[idx].trim().toUpperCase();
    if (out[routeId]) continue;          // first occurrence wins

    // Numeric cells are everything after the route id that parses as a number.
    const numbers = cells.slice(idx + 1).map(c => parseNumber(c, { max: 200 }));
    const validNumbers = numbers.filter(v => v != null);
    if (validNumbers.length < 2) continue;

    if (shape === 'high-frequency') {
      // High-frequency route columns in the current TfL PDF, in order:
      //   route | SWT | EWT | EWT(prev-year) | AWT | AWT:SWT ratio
      //         | %wait<10 | %10-20 | %20-30 | %>30 | LongGaps
      // Note: AWT = SWT + EWT, ratio = AWT/SWT — used as a sanity check.
      // No `% scheduled mileage` in this table, so we leave that column null.
      const [swt, ewt, /* ewtPrev */, awt] = numbers;
      out[routeId] = {
        service_class:       'high-frequency',
        swt_minutes:         (swt != null && swt <= 60) ? swt : null,
        awt_minutes:         (awt != null && awt <= 60) ? awt : null,
        ewt_minutes:         (ewt != null && ewt <= 30) ? ewt : null,
        scheduled_mileage_operated_percent: null,
      };
    } else if (shape === 'low-frequency') {
      // Low-frequency route columns:
      //   route | %on-time | %on-time(prev-year) | %early | %late | %non-arrival
      // Last-year column is sometimes "n/a"; parseNumber drops it to null,
      // and my row-cells slice still keeps positional indexing (the n/a
      // becomes a null in the array, not a removed slot).
      // No `% scheduled mileage` here either.
      const [onTime, /* onTimePrev */, early, late, nonArr] = numbers;
      out[routeId] = {
        service_class:       'low-frequency',
        on_time_percent:     (onTime != null && onTime <= 100) ? onTime : null,
        early_percent:       (early  != null && early  <= 100) ? early  : null,
        late_percent:        (late   != null && late   <= 100) ? late   : null,
        non_arrival_percent: (nonArr != null && nonArr <= 100) ? nonArr : null,
        scheduled_mileage_operated_percent: null,
      };
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Skip-if-unchanged: TfL only republishes the QSI PDF every ~4 weeks (one
  // 13-period reporting cycle). HEAD first; if Last-Modified matches what we
  // already cached, skip the download + parse. `--force` re-runs unconditionally.
  const force = process.argv.includes('--force');
  if (!force && fs.existsSync(OUT_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      const upstreamMod = await fetchPdfHead();
      if (upstreamMod && cached.pdfModifiedAt === upstreamMod) {
        console.log(`PDF unchanged (Last-Modified ${upstreamMod}) — skipping. Use --force to override.`);
        return;
      }
    } catch { /* fall through to a full fetch */ }
  }

  console.log(`Fetching ${SOURCE_URL} ...`);
  const { buffer, lastModified } = await fetchPdfBuffer();
  console.log(`  ${(buffer.length / 1024).toFixed(0)} KB, last-modified ${lastModified ?? 'unknown'}`);

  console.log('Extracting text positions with pdfjs-dist ...');
  const pages = await extractPdfRowsByPage(buffer);
  console.log(`  ${pages.length} pages, ${pages.reduce((n, p) => n + p.length, 0)} rows total`);

  // Persist raw rows for debugging — one row per line, cells tab-separated, page break markers between.
  const rawDump = pages.map((rows, i) =>
    `\n── Page ${i + 1} ──\n` + rows.map(r => r.join('\t')).join('\n')
  ).join('\n');
  fs.mkdirSync(path.dirname(RAW_PATH), { recursive: true });
  fs.writeFileSync(RAW_PATH, rawDump, 'utf8');

  // Period from the first page's text
  const period = parsePeriod(pages.flat().flat().join(' '));
  if (period.label) {
    console.log(`  Period: ${period.label} (${period.start} → ${period.end})`);
  } else {
    console.warn('  Could not detect period label — period_* fields will be null');
  }

  // Walk page by page. The PDF has only TWO header rows total — one at the
  // top of the high-frequency table (page 4) and one at the top of the
  // low-frequency table (page 12). Continuation pages carry no header. So we
  // make the table shape sticky: a header switches the active shape, and
  // every subsequent page parses with that shape until a new header appears.
  const routes = {};
  let currentShape = null;
  for (let i = 0; i < pages.length; i++) {
    const detected = detectTableShape(pages[i]);
    if (detected) currentShape = detected;
    if (currentShape) parsePage(pages[i], currentShape, routes);
  }

  const highFreq = Object.values(routes).filter(r => r.service_class === 'high-frequency').length;
  const lowFreq  = Object.values(routes).filter(r => r.service_class === 'low-frequency').length;
  console.log(`Parsed ${Object.keys(routes).length} routes — high-freq=${highFreq}, low-freq=${lowFreq}`);

  if (Object.keys(routes).length === 0) {
    console.warn('  Zero routes parsed — TfL likely changed PDF format. See route-performance-raw.txt');
  }

  const output = {
    generatedAt:    new Date().toISOString(),
    sourceUrl:      SOURCE_URL,
    pdfModifiedAt:  lastModified,
    periodLabel:    period.label,
    periodStart:    period.start,
    periodEnd:      period.end,
    routeCount:     Object.keys(routes).length,
    routes,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(sanitizeRecord(output)), 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
