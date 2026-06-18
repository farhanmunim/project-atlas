/**
 * cache.js — Sticky-cache helpers shared by long-running fetchers.
 *
 * `fetch-vehicle-fleet`, `fetch-route-mps`, `fetch-tenders` all maintain a
 * JSON cache they update incrementally over a single run, with a periodic
 * flush + SIGTERM handler so a CI timeout never throws away progress. This
 * module factors that pattern into three functions so each fetcher just
 * declares its config and calls into here.
 *
 * Usage:
 *   import { loadJsonCache, atomicWriteJson, installSignalFlush } from './_lib/cache.js';
 *
 *   const cache = loadJsonCache(CACHE_PATH, { vehicles: {} });
 *   installSignalFlush(() => atomicWriteJson(CACHE_PATH, buildOutput(cache)));
 *   ...
 *   atomicWriteJson(CACHE_PATH, buildOutput(cache));   // periodic + final flush
 */

import fs from 'fs';
import path from 'path';
import { sanitizeRecord } from './sanitize.js';

/**
 * Atomic-ish JSON write: writes to `<path>.tmp` first, then renames over
 * the target. Prevents a torn cache file if the process is killed mid-write
 * (e.g. CI timeout, Ctrl-C). Also runs the payload through sanitizeRecord
 * by default so cached files can never carry hostile markup — pass
 * `{ sanitize: false }` to skip on a code path that's already sanitised
 * upstream (negligible perf benefit; only turn off if you have a reason).
 *
 * @param {string} filePath
 * @param {*}      data
 * @param {object} [opts]
 * @param {boolean}[opts.sanitize=true]
 * @param {number} [opts.indent]            Optional pretty-print indent.
 */
export function atomicWriteJson(filePath, data, opts = {}) {
  const { sanitize = true, indent } = opts;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const cleaned = sanitize ? sanitizeRecord(data) : data;
  const tmp = filePath + '.tmp';
  const json = indent ? JSON.stringify(cleaned, null, indent) : JSON.stringify(cleaned);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Try to load + parse an existing JSON cache file. If the file is missing,
 * unreadable, or malformed, return `defaultValue` and emit a single warning
 * line — the next run will rebuild the cache from scratch (each fetcher's
 * upstream is the source of truth). Never throws.
 *
 * @param {string} filePath
 * @param {*}      defaultValue   Returned on any failure.
 * @returns {*}
 */
export function loadJsonCache(filePath, defaultValue = {}) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`  Cache unreadable at ${filePath} (${err.message}) — starting fresh`);
    return defaultValue;
  }
}

/**
 * Wire a callback into SIGINT / SIGTERM so a CI runner timeout (or local
 * Ctrl-C) flushes the in-memory cache before the process exits with code
 * 130 (the standard "terminated by signal" exit). Idempotent — safe to call
 * once at startup.
 *
 * @param {() => void|Promise<void>} flushFn
 */
export function installSignalFlush(flushFn) {
  const handler = () => {
    try { flushFn(); } catch {}
    process.exit(130);
  };
  process.once('SIGINT',  handler);
  process.once('SIGTERM', handler);
}
