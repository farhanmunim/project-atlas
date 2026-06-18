/**
 * http.js — Shared HTTP helpers for the pipeline.
 *
 * Every fetcher needs: a `fetch` with a hard timeout (so a slow upstream
 * can't hang the weekly CI run), a HEAD-only variant (so we can compare
 * `Last-Modified` before pulling a multi-MB body), and a default User-Agent
 * stamped with the package version. This module provides all three so
 * scripts don't reimplement them inconsistently.
 *
 * Usage:
 *   import { fetchWithTimeout, headLastModified, userAgentHeaders } from './_lib/http.js';
 *
 *   const r   = await fetchWithTimeout(url, { headers: userAgentHeaders('route-mps') }, 30_000);
 *   const lm  = await headLastModified(url, 'route-mps');
 */

import { userAgent } from './env.js';

/** Default request timeout in ms when the caller doesn't specify. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Convenience: build a headers object with the canonical User-Agent stamp.
 * @param {string} scriptName  Short label for the caller (e.g. "tenders").
 * @param {object} [extra]     Additional headers merged on top.
 */
export function userAgentHeaders(scriptName, extra = {}) {
  return { 'User-Agent': userAgent(scriptName), ...extra };
}

/**
 * Wrap `fetch` with an `AbortController`-backed timeout. The Promise rejects
 * with the underlying AbortError if `timeoutMs` elapses before the response
 * resolves. The timer is always cleared in a `finally` to prevent the Node
 * process keeping itself alive on a stray timer.
 *
 * @param {string|URL} url
 * @param {RequestInit} [opts]   Standard fetch options. `signal` here is
 *                                ignored — we always wire our own controller.
 * @param {number}     [timeoutMs=30000]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue a HEAD request and return the upstream `Last-Modified` as an ISO
 * timestamp. Used by every "skip-if-unchanged" short-circuit (geometry ZIP,
 * QSI PDF, programme PDFs, per-route MPS PDFs). Returns null on any error
 * or if the header is absent — callers should treat null as "unknown" and
 * fall through to a full fetch.
 *
 * @param {string|URL} url
 * @param {string}     scriptName     For the User-Agent stamp.
 * @param {number}    [timeoutMs]
 * @returns {Promise<{ status: number, lastModified: string|null }>}
 */
export async function headLastModified(url, scriptName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(url, {
      method:  'HEAD',
      headers: userAgentHeaders(scriptName),
    }, timeoutMs);
    if (!res.ok) return { status: res.status, lastModified: null };
    const lm = res.headers.get('last-modified');
    return { status: 200, lastModified: lm ? new Date(lm).toISOString() : null };
  } catch {
    return { status: 0, lastModified: null };
  }
}
