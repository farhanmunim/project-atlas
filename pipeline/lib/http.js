/**
 * http.js — the one HTTP client every source uses.
 *
 * Guarantees the pipeline contract (see claude.md → Pipelines):
 *   • hard timeout on every request (a slow upstream can't hang CI)
 *   • retries with exponential backoff + jitter on 429 / 5xx / network errors,
 *     honouring Retry-After when present
 *   • conditional requests via the persistent validator cache (304 → notModified)
 *   • a canonical User-Agent so upstreams can identify us
 *
 * Sources never call global fetch() directly — they go through here, so retry/
 * timeout/caching policy lives in exactly one place.
 */

import { getValidators, setValidators } from "./httpcache.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
const UA = "TransitInstruments/0.1 (+london-bus-operator data pipeline)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoff(attempt, retryAfter) {
  if (retryAfter) { const s = Number(retryAfter); if (!Number.isNaN(s)) return s * 1000; }
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  return base / 2 + Math.random() * (base / 2); // full-ish jitter
}

async function once(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/**
 * Core request with retries. Returns the Response (caller reads the body).
 * Throws after exhausting retries.
 */
async function request(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES } = {}) {
  const h = { "User-Agent": UA, ...headers };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await once(url, { headers: h }, timeoutMs);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) { await sleep(backoff(attempt, res.headers.get("retry-after"))); continue; }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw err;
    }
  }
  throw lastErr || new Error("request failed");
}

/**
 * Conditional JSON GET.
 * Returns { notModified:true } if the upstream answered 304, else
 * { data, status, fromCache:false }. Records validators on 200.
 * Set opts.conditional=false to always pull a fresh body.
 */
export async function getJson(url, opts = {}) {
  const { conditional = true, timeoutMs, retries } = opts;
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  if (conditional) {
    const v = getValidators(url);
    if (v?.etag) headers["If-None-Match"] = v.etag;
    if (v?.lastModified) headers["If-Modified-Since"] = v.lastModified;
  }
  const res = await request(url, { headers, timeoutMs, retries });
  if (res.status === 304) return { notModified: true, status: 304 };
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  setValidators(url, { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") });
  return { data: await res.json(), status: res.status, notModified: false };
}

/** Plain text GET with the same retry/timeout policy (for CSV/HTML sources).
 *  opts.encoding (e.g. "windows-1252") decodes legacy pages correctly. */
export async function getText(url, opts = {}) {
  const res = await request(url, { headers: { ...(opts.headers || {}) }, timeoutMs: opts.timeoutMs, retries: opts.retries });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  if (opts.encoding) return new TextDecoder(opts.encoding).decode(await res.arrayBuffer());
  return await res.text();
}

/** Run async `fn` over `items` with bounded concurrency (politeness + speed). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}
