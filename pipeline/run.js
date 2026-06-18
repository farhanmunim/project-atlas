/**
 * run.js — the pipeline orchestrator.
 *
 * Runs each registered dataset builder in order, honouring the contract in
 * claude.md (Pipelines): robust, idempotent, graceful-degrading, observable.
 *
 *   • TTL skip      — a dataset still within its TTL is skipped (cache layer 2),
 *                     unless --force.
 *   • soft-fail     — a fetch/build failure keeps the LAST-GOOD store file and
 *                     continues; the run still ends, the manifest marks it failed.
 *   • idempotent    — same inputs → same store; safe to re-run after a crash.
 *   • observable    — per-step timing, a final summary, manifest with status,
 *                     and a non-zero exit code if any HARD dataset failed.
 *
 * Flags:
 *   --force            ignore TTLs, rebuild everything selected
 *   --only=a,b         run only these datasets
 *   --limit=N          cap per-route geometry fetches (dev; routes builder)
 *
 * Usage:  node pipeline/run.js [--force] [--only=routes,status] [--limit=30]
 */

import { keySummary } from "./lib/env.js";   // load .env FIRST, before any source reads process.env
import { DATASETS } from "./config.js";
import { makeSink } from "./lib/store.js";
import { readManifest, writeManifest, setDataset, isFresh } from "./lib/manifest.js";
import { flush as flushHttpCache } from "./lib/httpcache.js";
import { log } from "./lib/log.js";

function parseArgs(argv) {
  const a = { force: false, only: null, limit: null };
  for (const arg of argv) {
    if (arg === "--force") a.force = true;
    else if (arg.startsWith("--only=")) a.only = arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--limit=")) a.limit = arg.slice(8);
  }
  return a;
}

function cmpRoute(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b), "en");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sink = makeSink();
  const manifest = readManifest();
  const ctx = { sink, log, args, cmpRoute };

  const selected = DATASETS.filter((d) => !args.only || args.only.includes(d.name));
  if (!selected.length) { log.err(`no datasets match --only=${args.only}`); process.exitCode = 2; return; }

  log.info(`=== Transit Instruments — data refresh (sink: ${sink.kind}${args.force ? ", forced" : ""}) · ${keySummary()} ===`);
  const started = Date.now();
  const results = [];

  for (const ds of selected) {
    if (!args.force && isFresh(manifest, ds.name, ds.ttlMs)) {
      log.info(`skip ${ds.name} — still fresh (TTL ${Math.round(ds.ttlMs / 60000)}m)`);
      results.push({ name: ds.name, outcome: "skipped" });
      continue;
    }
    const done = log.step(`build ${ds.name}`);
    try {
      const r = await ds.build(ctx);
      setDataset(manifest, ds.name, {
        source: r.source, fetchedAt: new Date().toISOString(), status: "ok",
        rows: r.rows ?? null, files: r.files ?? [], cadence: ds.cadence, note: r.note,
      });
      results.push({ name: ds.name, outcome: "ok", rows: r.rows });
      done(`${r.rows ?? "?"} rows`);
    } catch (err) {
      const prev = manifest.datasets?.[ds.name];
      setDataset(manifest, ds.name, {
        ...(prev || {}), status: "failed", lastError: String(err.message || err), lastAttempt: new Date().toISOString(),
      });
      results.push({ name: ds.name, outcome: "failed", soft: ds.soft, error: err.message });
      if (ds.soft) log.warn(`${ds.name} failed (${err.message}) — keeping last-good, continuing`);
      else log.err(`${ds.name} failed (${err.message}) — HARD`);
    }
  }

  const file = writeManifest(manifest);
  flushHttpCache();

  // summary
  const ok = results.filter((r) => r.outcome === "ok").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed");
  log.info(`=== done in ${((Date.now() - started) / 1000).toFixed(1)}s · ${ok} built, ${skipped} skipped, ${failed.length} failed · manifest: ${file} ===`);
  for (const r of results) {
    const tag = r.outcome === "ok" ? "✓" : r.outcome === "skipped" ? "–" : "✗";
    log.info(`  ${tag} ${r.name}${r.rows != null ? ` (${r.rows})` : ""}${r.error ? " — " + r.error : ""}`);
  }

  const hardFail = failed.some((r) => !r.soft);
  // Set the code and let the event loop drain naturally. Forcing process.exit()
  // here races fetch's keep-alive sockets and trips a libuv assert on Windows.
  process.exitCode = hardFail ? 1 : 0;
}

main().catch((err) => { log.err(`fatal: ${err.stack || err.message}`); process.exitCode = 1; });
