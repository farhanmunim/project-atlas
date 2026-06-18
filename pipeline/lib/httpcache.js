/**
 * httpcache.js — persistent validator cache for conditional requests.
 *
 * Stores per-URL `ETag` / `Last-Modified` between runs in `.cache/http.json`,
 * so the next run can send `If-None-Match` / `If-Modified-Since` and the
 * upstream can answer `304 Not Modified` — no body re-downloaded, no quota
 * burned. This is layer 1 of the pipeline's caching (see README → Caching).
 *
 * Deliberately filesystem-local and dependency-free. It is a *validator*
 * cache only: it never stores response bodies (the normalised store holds the
 * last-good data), so it stays tiny and can be wiped safely at any time.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE_PATH = path.join(ROOT, ".cache", "http.json");

let mem = null;

function load() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); }
  catch { mem = {}; }
  return mem;
}

/** Validators for a URL, or null. → { etag?, lastModified? } */
export function getValidators(url) {
  return load()[url] || null;
}

/** Record validators returned by a 200 response. */
export function setValidators(url, { etag, lastModified }) {
  const c = load();
  if (!etag && !lastModified) return;
  c[url] = { etag: etag || c[url]?.etag, lastModified: lastModified || c[url]?.lastModified, at: new Date().toISOString() };
}

/** Persist the cache to disk (call once at end of run). */
export function flush() {
  if (!mem) return;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(mem, null, 2), "utf8");
}
