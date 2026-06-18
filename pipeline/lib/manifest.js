/**
 * manifest.js — the store's index of freshness & health.
 *
 * Every dataset records: which source backs it, when it was last fetched, the
 * outcome (ok | stale | failed), row count, and the output file(s). Two jobs:
 *   1. The orchestrator reads `fetchedAt` + `ttlMs` to SKIP work that is still
 *      fresh (caching layer 2 — don't re-pull a weekly feed every hour).
 *   2. The tools read `_manifest.json` to drive their "Updated / stale / offline"
 *      badge honestly — staleness is data, not a guess.
 *
 * Written to /data/_manifest.json (small, pretty, diffable).
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "./store.js";

const MANIFEST = path.join(DATA_DIR, "_manifest.json");

export function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch { return { generatedAt: null, datasets: {} }; }
}

/** Is `name` still within its TTL (so the orchestrator can skip it)? */
export function isFresh(manifest, name, ttlMs, now = Date.now()) {
  const d = manifest.datasets?.[name];
  if (!d || d.status === "failed" || !d.fetchedAt) return false;
  if (!ttlMs) return false;
  return now - new Date(d.fetchedAt).getTime() < ttlMs;
}

/** Merge one dataset's result into the manifest (in memory). */
export function setDataset(manifest, name, entry) {
  manifest.datasets = manifest.datasets || {};
  manifest.datasets[name] = { ...(manifest.datasets[name] || {}), ...entry };
  return manifest;
}

export function writeManifest(manifest, nowIso = new Date().toISOString()) {
  manifest.generatedAt = nowIso;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = MANIFEST + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, MANIFEST);
  return path.relative(ROOT, MANIFEST);
}
