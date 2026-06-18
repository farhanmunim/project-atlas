/**
 * sources/tfl-performance.js — TfL bus reliability (QSI quarter PDF + per-route MPS PDFs).
 *
 * Two feeds, both PDFs published on TfL's static host (no JSON equivalent — this
 * is the only public per-route bus-reliability dataset):
 *
 *   1. QSI quarter report  http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf
 *      One ~1 MB PDF per ~4-week TfL period carrying every route's headline
 *      reliability: high-frequency routes get SWT/AWT/EWT + mileage, low-frequency
 *      routes get % On-Time/Early/Late/Non-Arrival.
 *
 *   2. Per-route MPS reports  http://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf
 *      A small PDF per route carrying the contractual Minimum Performance Standards
 *      (the EWT/OTP/mileage thresholds the route is graded against) plus the
 *      trailing-13-period actual mileage-operated readings.
 *
 * Ported from ingest/scripts/fetch-route-performance.js + fetch-route-mps.js.
 * Cadence: ~4-weekly (TfL's 13-period year). MPS is contract-defined and only
 * changes on a new tender award, so it is heavily cached (Last-Modified + per-run cap).
 *
 * Parsing rationale (why pdfjs-dist, not pdf-parse): TfL's PDFs are Excel exports
 * with tightly-packed columns. We need each fragment's (x, y) to cluster items
 * into real table rows — see lib/pdf.js (ported from ingest/_lib/pdf.js).
 */

import { extractPdfRowsByPage, extractPdfRows } from "../lib/pdf.js";

const QSI_URL = "http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf";
const MPS_URL = (id) => `http://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-${id}.pdf`;
const UA = "TransitInstruments/0.1 (+london-bus-operator data pipeline)";

// 60s for the QSI PDF (largest single artefact); 30s for the small MPS PDFs.
const QSI_TIMEOUT_MS = 60_000;
const MPS_TIMEOUT_MS = 30_000;
const MPS_RETRIES    = 3;
const MPS_RPS        = 4;       // gentle on TfL's static-PDF host

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── low-level PDF fetch (self-contained: pipeline/lib/http.js has no buffer/HEAD) ── */

async function fetchBuffer(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) return { status: res.status };
    const lm = res.headers.get("last-modified");
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: 200, buffer: buf, lastModified: lm ? new Date(lm).toISOString() : null };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBufferRetry(url, timeoutMs, retries) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetchBuffer(url, timeoutMs);
      if (r.status === 404) return r;
      if (r.status !== 200) {
        if (attempt === retries) return r;
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) return { status: 0, error: err.message };
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  return { status: 0, error: lastErr ? lastErr.message : "fetch failed" };
}

async function headLastModified(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return { status: res.status, lastModified: null };
    const lm = res.headers.get("last-modified");
    return { status: 200, lastModified: lm ? new Date(lm).toISOString() : null };
  } catch {
    return { status: 0, lastModified: null };
  } finally {
    clearTimeout(timer);
  }
}

/* ── QSI quarter PDF parsing (ported from fetch-route-performance.js) ───────── */

function parsePeriod(text) {
  const m = /Quarter\s+0?(\d)\s+(\d{2})\/(\d{2})/i.exec(text);
  if (!m) return { label: null, start: null, end: null };
  const q = parseInt(m[1], 10);
  const fyStart = 2000 + parseInt(m[2], 10);
  const fyEnd = 2000 + parseInt(m[3], 10);
  const ranges = {
    1: [`${fyStart}-04-01`, `${fyStart}-06-30`],
    2: [`${fyStart}-07-01`, `${fyStart}-09-30`],
    3: [`${fyStart}-10-01`, `${fyStart}-12-31`],
    4: [`${fyEnd}-01-01`, `${fyEnd}-03-31`],
  };
  const r = ranges[q];
  return r ? { label: `Q${q} ${m[2]}/${m[3]}`, start: r[0], end: r[1] } : { label: null, start: null, end: null };
}

function detectTableShape(rows) {
  const headerWindow = rows.slice(0, 12).flat().join(" ").toUpperCase();
  if (/EXCESS\s*WAIT|EWT|SWT/.test(headerWindow)) return "high-frequency";
  if (/ON\s*TIME|NON.?ARRIV|DEPART|EARLY|LATE/.test(headerWindow) &&
      !/EWT|SWT|EXCESS/.test(headerWindow)) return "low-frequency";
  return null;
}

function parseNumber(s, { max = 1000 } = {}) {
  if (s == null) return null;
  const t = String(s).replace(/[%*†‡§\s,]/g, "");
  if (t === "" || t === "-" || t === "N/A" || t === "n/a") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

const ROUTE_RE = /^(N?[A-Z]{0,2}\d{1,3}[A-Z]?)$/;
function looksLikeRouteId(s) {
  if (!s) return false;
  const t = s.trim().toUpperCase();
  if (/^(Q\d|TOTAL|ALL|AVERAGE|MEAN|GROUP|HIGH|LOW)$/.test(t)) return false;
  return ROUTE_RE.test(t);
}

function parsePage(rows, shape, out) {
  if (!shape) return;
  for (const cells of rows) {
    if (cells.length < 3) continue;
    const idx = cells.findIndex(looksLikeRouteId);
    if (idx === -1) continue;
    const routeId = cells[idx].trim().toUpperCase();
    if (out[routeId]) continue; // first occurrence wins

    const numbers = cells.slice(idx + 1).map((c) => parseNumber(c, { max: 200 }));
    const validNumbers = numbers.filter((v) => v != null);
    if (validNumbers.length < 2) continue;

    if (shape === "high-frequency") {
      // route | SWT | EWT | EWT(prev) | AWT | …
      const [swt, ewt, , awt] = numbers;
      out[routeId] = {
        service_class: "high-frequency",
        swt_minutes: swt != null && swt <= 60 ? swt : null,
        awt_minutes: awt != null && awt <= 60 ? awt : null,
        ewt_minutes: ewt != null && ewt <= 30 ? ewt : null,
        on_time_percent: null,
      };
    } else if (shape === "low-frequency") {
      // route | %on-time | %on-time(prev) | %early | %late | %non-arrival
      const [onTime] = numbers;
      out[routeId] = {
        service_class: "low-frequency",
        swt_minutes: null,
        awt_minutes: null,
        ewt_minutes: null,
        on_time_percent: onTime != null && onTime <= 100 ? onTime : null,
      };
    }
  }
}

/**
 * Fetch + parse the QSI quarter PDF.
 * @param {object} [opts] { prevModifiedAt } — if set and the upstream Last-Modified
 *        matches via HEAD, returns { notModified:true } so the caller keeps last-good.
 * @returns {Promise<{ notModified?:true, periodLabel, periodStart, periodEnd,
 *                      pdfModifiedAt, routes }>}
 */
export async function fetchQsiPerformance(opts = {}) {
  if (opts.prevModifiedAt) {
    const head = await headLastModified(QSI_URL, QSI_TIMEOUT_MS);
    if (head.status === 200 && head.lastModified && head.lastModified === opts.prevModifiedAt) {
      return { notModified: true, pdfModifiedAt: head.lastModified };
    }
  }

  const dl = await fetchBufferRetry(QSI_URL, QSI_TIMEOUT_MS, 2);
  if (dl.status !== 200 || !dl.buffer) {
    throw new Error(`QSI PDF fetch failed: status ${dl.status}${dl.error ? " — " + dl.error : ""}`);
  }

  const pages = await extractPdfRowsByPage(dl.buffer);
  const period = parsePeriod(pages.flat().flat().join(" "));

  // Sticky table-shape state machine: a header sets the active shape, every
  // following page parses with it until a new header appears.
  const routes = {};
  let currentShape = null;
  for (let i = 0; i < pages.length; i++) {
    const detected = detectTableShape(pages[i]);
    if (detected) currentShape = detected;
    if (currentShape) parsePage(pages[i], currentShape, routes);
  }

  return {
    periodLabel: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    pdfModifiedAt: dl.lastModified,
    routes,
  };
}

/* ── per-route MPS PDF parsing (ported from fetch-route-mps.js) ─────────────── */

function parseMps(rows) {
  let serviceClass = null;
  let section = null; // 'reliability' | 'mileage'
  let mileageCurrentSeen = false;
  const out = {
    service_class: null,
    ewt_mps_minutes: null,
    otp_mps_percent: null,
    mileage_mps_percent: null,
    mileage_operated_latest_percent: null,
    mileage_operated_avg_percent: null,
  };

  function extractPeriodValues(cells) {
    const nums = [];
    for (const c of cells) {
      const n = parseFloat(c);
      if (Number.isFinite(n)) nums.push(n);
    }
    return nums.length === 13 ? nums : null;
  }

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.length) continue;
    const flat = cells.join(" ").toLowerCase();

    if (/reliability\s+performance/i.test(flat)) { section = "reliability"; mileageCurrentSeen = false; continue; }
    if (/mileage\s+performance/i.test(flat)) { section = "mileage"; mileageCurrentSeen = false; continue; }

    if (!serviceClass) {
      if (/high\s*frequency/i.test(flat) && /ewt/i.test(flat)) serviceClass = "high-frequency";
      else if (/low\s*frequency/i.test(flat) && /on\s*time/i.test(flat)) serviceClass = "low-frequency";
    }

    if (cells.some((c) => /^minimum\s*standard$/i.test(c))) {
      let val = null;
      for (const c of cells) {
        const n = parseFloat(c);
        if (Number.isFinite(n) && n > 0) { val = n; break; }
      }
      if (val == null) continue;
      if (section === "reliability") {
        if (serviceClass === "high-frequency") out.ewt_mps_minutes = val;
        else if (serviceClass === "low-frequency") out.otp_mps_percent = val;
      } else if (section === "mileage") {
        out.mileage_mps_percent = val;
      }
      continue;
    }

    if (section === "mileage" && !mileageCurrentSeen) {
      let nums = extractPeriodValues(cells);
      if (!nums && rows[i + 1]) {
        const nextNums = extractPeriodValues(rows[i + 1]);
        if (nextNums && /^P\d+\s+\d+\/\d+\s+to\s+P\d+\s+\d+\/\d+$/i.test(cells[0] ?? "")) {
          nums = nextNums;
        }
      }
      if (nums) {
        const inRange = nums.filter((v) => v >= 50 && v <= 100);
        if (inRange.length === 13) {
          out.mileage_operated_latest_percent = +nums[nums.length - 1].toFixed(2);
          out.mileage_operated_avg_percent = +(nums.reduce((a, b) => a + b, 0) / 13).toFixed(2);
          mileageCurrentSeen = true;
        }
      }
    }
  }

  out.service_class = serviceClass;
  return out;
}

/**
 * Fetch + parse the per-route MPS PDFs.
 *
 * Sticky cache: MPS is contract-defined, so a route already parsed (200) or
 * legitimately absent (404) within `ttlMs` is skipped; a HEAD short-circuit skips
 * the body when Last-Modified hasn't moved. Capped at `maxPerRun` to keep any one
 * run cheap and polite. One route failing never aborts the batch.
 *
 * @param {string[]} routeIds      uppercased route ids to consider
 * @param {object}   [opts]        { prevCache, ttlMs, maxPerRun, onProgress, log }
 * @returns {Promise<{ routes:Record<string,object>, fetched:number, errored:number, skipped:number }>}
 *          routes is the merged cache (prev + this run) keyed by route id.
 */
export async function fetchRouteMps(routeIds, opts = {}) {
  const ttlMs = opts.ttlMs ?? 28 * 86_400_000;
  const maxPerRun = opts.maxPerRun ?? 1000;
  const log = opts.log;
  const cache = { ...(opts.prevCache || {}) };
  const cutoff = Date.now() - ttlMs;

  const isFresh = (c) => {
    if (!c?.lastCheckedAt) return false;
    if (c.status !== 200 && c.status !== 404) return false; // errors retry next run
    const ts = new Date(c.lastCheckedAt).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  };

  const stale = routeIds.filter((id) => !isFresh(cache[id]));
  stale.sort((a, b) => (cache[a]?.lastCheckedAt ?? "").localeCompare(cache[b]?.lastCheckedAt ?? ""));
  const toFetch = stale.slice(0, maxPerRun);
  if (log) log.info(`route-mps: ${stale.length} stale, processing ${toFetch.length} (cap ${maxPerRun})`);

  let fetched = 0, errored = 0, skipped = 0;
  const minIntervalMs = Math.ceil(1000 / MPS_RPS);
  let nextSlot = Date.now();

  for (const id of toFetch) {
    const wait = nextSlot - Date.now();
    if (wait > 0) await sleep(wait);
    nextSlot = Date.now() + minIntervalMs;

    const url = MPS_URL(id);
    const prev = cache[id] ?? {};
    const now = new Date().toISOString();

    // HEAD short-circuit when we already have a parsed PDF and it hasn't moved.
    if (prev.pdf_modified_at) {
      const head = await headLastModified(url, MPS_TIMEOUT_MS);
      if (head.status === 200 && head.lastModified === prev.pdf_modified_at) {
        cache[id] = { ...prev, lastCheckedAt: now, status: 200 };
        skipped++;
        continue;
      }
      if (head.status === 404) {
        cache[id] = { ...prev, lastCheckedAt: now, status: 404 };
        continue;
      }
    }

    const dl = await fetchBufferRetry(url, MPS_TIMEOUT_MS, MPS_RETRIES);
    if (dl.status === 200 && dl.buffer) {
      try {
        const rows = await extractPdfRows(dl.buffer);
        const parsed = parseMps(rows);
        cache[id] = { ...parsed, pdf_modified_at: dl.lastModified, lastCheckedAt: now, status: 200 };
        fetched++;
      } catch (err) {
        cache[id] = { ...prev, lastCheckedAt: now, status: "parse_error", error: err.message };
        errored++;
      }
    } else if (dl.status === 404) {
      // School routes (600-799) etc. genuinely have no MPS PDF — cache the 404.
      cache[id] = { ...prev, lastCheckedAt: now, status: 404 };
    } else {
      cache[id] = { ...prev, lastCheckedAt: now, status: dl.status, error: dl.error ?? null };
      errored++;
    }

    if (opts.onProgress && (fetched + errored + skipped) % 50 === 0) {
      opts.onProgress({ cache, fetched, errored, skipped, done: fetched + errored + skipped, total: toFetch.length });
    }
  }

  return { routes: cache, fetched, errored, skipped };
}
