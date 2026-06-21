/**
 * store.js — the STORE SINK abstraction.
 *
 * The pipeline writes normalised, tool-shaped datasets into "the store". Today
 * the store is versioned JSON/GeoJSON files under /data (served straight to the
 * dependency-free HTML tools). Tomorrow it is our own database warehouse
 * (Postgres, likely Supabase) that we ingest into and own end-to-end.
 *
 * Both are the SAME interface — a `sink` with `writeDataset()` / `readDataset()`.
 * Swapping filesystem → DB is changing `makeSink()`, not the builders. Builders
 * depend on this interface only, never on fs or a DB client directly. This is
 * the write-side mirror of the tools' read-side `dataSource` seam: components
 * depend on our shape, never on where the bytes live.
 *
 *   STORE_SINK=fs   (default)  → /data/*.json + *.geojson
 *   STORE_SINK=supabase        → (future) upsert into our warehouse
 *
 * The DB sink must implement the same two methods with the same shapes, so the
 * read API can mirror these dataset names 1:1.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = path.join(ROOT, "data");

/** Atomic write: write to .tmp then rename, so a killed run never leaves a torn file. */
function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, filePath);
}

/* ── Filesystem sink ────────────────────────────────────────────────────── */
const fsSink = {
  kind: "fs",
  /** name → /data/<name>.<ext>. `pretty` only for small/diffable files. */
  async writeDataset(name, data, { ext = "json", pretty = false } = {}) {
    const file = path.join(DATA_DIR, `${name}.${ext}`);
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    atomicWrite(file, text);
    return { file: path.relative(ROOT, file), bytes: Buffer.byteLength(text) };
  },
  /** Read a previously-written dataset, or null (used for last-good fallback). */
  async readDataset(name, { ext = "json" } = {}) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.${ext}`), "utf8")); }
    catch { return null; }
  },
};

/* ── Supabase sink (placeholder for the future warehouse) ───────────────────
   Implement the same interface against our DB. Kept as a stub so the wiring and
   contract are visible now; `STORE_SINK=supabase` will activate it once built. */
const supabaseSink = {
  kind: "supabase",
  async writeDataset() { throw new Error("supabase sink not built yet — set STORE_SINK=fs"); },
  async readDataset() { return null; },
};

export function makeSink() {
  const kind = process.env.STORE_SINK || "fs";
  if (kind === "supabase") return supabaseSink;
  return fsSink;
}
