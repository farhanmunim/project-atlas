/**
 * sources/ibus.js — TfL iBus static data drops (ibus.data.tfl.gov.uk).
 *
 * The portal is a public S3 bucket of dated, immutable schedule releases
 * (`Base_Version_YYYYMMDD/`, roughly fortnightly, back to mid-2025 plus a
 * "Previous Versions/" archive). Each version ships `Route_Geometry_<ver>.zip`
 * — one XML per route of ordered lat/lng points per direction per LBSL run:
 * TfL's own scheduling-system (AVL) path, denser than the Unified API's
 * lineStrings and, crucially, DATED — so past versions are authoritative
 * pre-diversion baselines (verified: the 20260703 drop passes W12's Selborne
 * Walk at 7 m; 20260731 carries the diverted line 207 m away).
 *
 * Keyless, cadence fortnightly. Used by build/diversions.js as the recovery
 * baseline when a flagged route's stored baseline was already polluted by an
 * advance redraw. Cadence-polite: nothing here is fetched unless a recovery
 * is actually needed, and results are cached per run.
 */

import { inflateRawSync } from "node:zlib";

const BUCKET = "https://s3-eu-west-1.amazonaws.com/ibus.data.tfl.gov.uk";
const TIMEOUT_MS = 60_000;

async function fetchBuf(url) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((res) => setTimeout(res, 1500));
    } finally { clearTimeout(t); }
  }
}

/** Dated Base_Version stamps in the bucket, newest first. */
export async function listVersions() {
  const xml = (await fetchBuf(`${BUCKET}/?list-type=2&delimiter=/`)).toString("utf8");
  return [...xml.matchAll(/<Prefix>Base_Version_(\d{8})\/<\/Prefix>/g)].map((m) => m[1])
    .sort().reverse();
}

/* ── minimal ZIP reader (store + deflate entries) — no dependencies ─────────
   Parses the End-of-Central-Directory record, walks the central directory for
   filenames + local-header offsets, and inflates each entry with zlib. */
export function* zipEntries(buf) {
  // EOCD signature 0x06054b50, within the last 64KB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);   // central directory offset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    // local header: sig(4) ver(2) flags(2) method(2) time(4) crc(4) csize(4) usize(4) nameLen(2) extraLen(2)
    const lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    yield { name, data: () => (method === 8 ? inflateRawSync(raw) : method === 0 ? raw : (() => { throw new Error(`unsupported zip method ${method}`); })()) };
    off += 46 + nameLen + extraLen + cmtLen;
  }
}

/** Parse one Route_Geometry_<route>_<ver>.xml → { "1": [[lng,lat]…], "2": […] }.
 *  aLBSL_Run_No maps runs to directions (run 1 = dir 1, run 2 = dir 2; higher runs
 *  are variants) — group by <Direction> and keep the LOWEST run per direction. */
export function parseRouteGeometry(xml) {
  const byDirRun = { 1: new Map(), 2: new Map() };   // dir → run → [{seq,p}]
  for (const m of xml.matchAll(/<Route_Geometry\s+([^>]*)>([\s\S]*?)<\/Route_Geometry>/g)) {
    const attrs = m[1], body = m[2];
    const run = +(/aLBSL_Run_No="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    const seq = +(/aSequence_No="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    const dir = +(/<Direction>(\d)<\/Direction>/.exec(body)?.[1] ?? NaN);
    const lng = parseFloat(/<Location_Longitude>([-\d.]+)<\/Location_Longitude>/.exec(body)?.[1]);
    const lat = parseFloat(/<Location_Latitude>([-\d.]+)<\/Location_Latitude>/.exec(body)?.[1]);
    if (!byDirRun[dir] || !Number.isFinite(run) || !Number.isFinite(seq) || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (!byDirRun[dir].has(run)) byDirRun[dir].set(run, []);
    byDirRun[dir].get(run).push({ seq, p: [lng, lat] });
  }
  const out = {};
  for (const d of [1, 2]) {
    const runs = [...byDirRun[d].keys()].sort((a, b) => a - b);
    if (!runs.length) continue;
    const pts = byDirRun[d].get(runs[0]).sort((a, b) => a.seq - b.seq).map((x) => x.p);
    if (pts.length >= 2) out[String(d)] = pts;
  }
  return out;
}

/** Whole-network geometry for one dated version: { [routeName]: { "1": coords, "2": coords } }.
 *  ~7 MB download; call through a per-run cache (build/diversions.js does). */
export async function fetchRouteGeometry(version) {
  const buf = await fetchBuf(`${BUCKET}/Base_Version_${version}/Route_Geometry_${version}.zip`);
  const out = {};
  for (const entry of zipEntries(buf)) {
    const m = /^Route_Geometry_(.+)_\d{8}\.xml$/.exec(entry.name.split("/").pop() || "");
    if (!m) continue;
    try {
      const g = parseRouteGeometry(entry.data().toString("utf8"));
      if (Object.keys(g).length) out[m[1]] = g;
    } catch { /* one bad entry must not sink the version */ }
  }
  return out;
}
