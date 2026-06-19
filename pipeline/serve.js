/**
 * serve.js — minimal static file server for local development.
 *
 * The tools must be served over http(s) (not file://) so the store fetches
 * (`data/*.json`) and the live TfL API both work. Zero dependencies.
 *
 *   node pipeline/serve.js [port]      # default 8000
 */

import "./lib/env.js";   // load .env first (TFL_APP_KEY / DVLA_API_KEY / BODS_API_KEY) — server-side only
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.js";
import { fetchVehicleActivity, hasKey as hasBodsKey } from "./sources/bods.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8000;

// One warehouse connection for the LIVE capture path. Tools POST what they fetch
// to /ingest; it flows through the same change-data-capture engine the pipeline
// uses, so live refreshes are stored exactly like periodic ones.
const dbx = openDb();

// Live-positions cache: BODS refreshes ~every 10s and asks callers not to poll faster,
// so we cache per-line for 10s. Many clients / rapid refreshes → ≤1 upstream poll/10s.
const liveCache = new Map();
const LIVE_TTL_MS = 10_000;
const liveRunId = dbx.startRun("live", "serve.js ingest endpoint");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ""; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 5e6) { reject(new Error("body too large")); req.destroy(); } b += c; });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
// No CORS headers → same-origin only. The tools are served by this server, so
// they work; a malicious cross-origin site cannot POST to /ingest or read /api.
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

// Live-capture allowlist. ONLY genuinely live/time-series types tools fetch and POST back
// may be written here — never reference data (route, route_meta, route_stops, route_geometry,
// tender, garage, fleet, vehicle): those come exclusively from the trusted pipeline, so a
// client POST can't poison the warehouse `current` that /api/* serves.
const ALLOWED_ENTITIES = new Set(["line_status"]);
// Static allowlist: tool pages + the JSON store only — never the .db, source, or dotfiles.
function staticAllowed(rel, ext) {
  if (/^\/[\w-]+\.html$/.test(rel)) return true;
  if (rel.startsWith("/data/") && (ext === ".json" || ext === ".geojson")) return true;
  return [".svg", ".png", ".ico", ".css", ".webmanifest"].includes(ext);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".xlsx": "application/octet-stream",
};

// Resolve a dataset name → { code, obj } from the warehouse (DB-direct, files for the
// build-only datasets). Shared by /api/<name> (dev DB read) and /api/v1/<name> (public).
function apiData(name) {
  const generatedAt = dbx.latestObservedAt();
  if (name === "routes")        return { code: 200, obj: dbx.allCurrent("route").map((x) => x.data) };
  if (name === "route-meta")    return { code: 200, obj: { generatedAt, routes: Object.fromEntries(dbx.allCurrent("route_meta").map((x) => [x.id, x.data])) } };
  if (name === "route-stops")   return { code: 200, obj: { generatedAt, routes: Object.fromEntries(dbx.allCurrent("route_stops").map((x) => [x.id, x.data])) } };
  if (name === "route-classifications") { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-classifications.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no route-classifications" } }; } }
  if (name === "line-status")   { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "line-status.json"), "utf8")) }; } catch { return { code: 200, obj: { capturedAt: generatedAt, rows: dbx.allCurrent("line_status").map((x) => x.data) } }; } }
  if (name === "garages")       return { code: 200, obj: { generatedAt, garages: dbx.allCurrent("garage").map((x) => x.data) } };
  if (name === "fleet")         return { code: 200, obj: { generatedAt, byRoute: Object.fromEntries(dbx.allCurrent("fleet").map((x) => [x.id, x.data])) } };
  if (name === "vehicles")      return { code: 200, obj: { generatedAt, byReg: Object.fromEntries(dbx.allCurrent("vehicle").map((x) => [x.id, x.data])) } };
  if (name === "manifest")      { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "_manifest.json"), "utf8")) }; } catch { return { code: 200, obj: { generatedAt, source: "database" } }; } }
  if (name === "route-performance") { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-performance.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no route-performance" } }; } }
  if (name === "accidents")     { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "accidents.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no accidents" } }; } }
  if (name === "bridges")       { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "bridges.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no bridges" } }; } }
  if (name === "routes-overview") {
    const features = dbx.allCurrent("route_geometry").map((x) => { const [routeId, direction] = x.id.split(":");
      return { type: "Feature", properties: { routeId, direction, lengthKm: x.data.lengthKm, stops: x.data.stops }, geometry: { type: "LineString", coordinates: x.data.coords } }; });
    return { code: 200, obj: { type: "FeatureCollection", metadata: { generatedAt, featureCount: features.length, partial: false }, features } };
  }
  if (name === "tenders") {
    const byRoute = {}; const parseDate = (s) => { const t = Date.parse(s || ""); return Number.isNaN(t) ? 0 : t; };
    for (const { data } of dbx.allCurrent("tender")) for (const k of String(data.route || "").split(/[\/,]/).map((s) => s.trim()).filter(Boolean)) (byRoute[k] ||= []).push(data);
    for (const k of Object.keys(byRoute)) byRoute[k].sort((a, b) => parseDate(b.awardDate) - parseDate(a.awardDate) || Number(b.btID) - Number(a.btID));
    return { code: 200, obj: { generatedAt, byRoute } };
  }
  return { code: 404, obj: { error: "unknown dataset: " + name } };
}

// Public-API surface (mirrors functions/api/v1/[[path]].js DATASETS — keep in sync).
// v1 reads the committed data/*.json FILES (exactly what the prod Pages Function
// re-serves), NOT the warehouse DB — so dev mirrors prod precisely and picks up
// build-time fixes (e.g. garage dedup) that CDC wouldn't tombstone from the DB.
const V1_SETS = {
  "routes":            { file: "routes.json",             desc: "All London bus routes — [{ id, name }]." },
  "route-meta":        { file: "route-meta.json",         desc: "Per-route metadata keyed by route name (operator, propulsion, garage, type, PVR)." },
  "route-classifications": { file: "route-classifications.json", desc: "Route type classification keyed by route name (day, night, 24-hour, school, prefix/lettered)." },
  "route-stops":       { file: "route-stops.json",        desc: "Ordered stop sequences per route and direction." },
  "line-status":       { file: "line-status.json",        desc: "Most recent line-status snapshot — per-route service status + a network summary (capturedAt)." },
  "routes-overview":   { file: "routes-overview.geojson", desc: "Route line geometry as a GeoJSON FeatureCollection." },
  "garages":           { file: "garages.json",            desc: "Bus garages — code, name, operator, lat/lng, PVR, routes served." },
  "fleet":             { file: "fleet.json",              desc: "Fleet profile per route — vehicle count, average age, propulsion mix, makes." },
  "vehicles":          { file: "vehicles.json",           desc: "Vehicle register keyed by registration — routes, operator, make, year, fuel." },
  "tenders":           { file: "tenders.json",            desc: "Tender / contract award history per route — bids (low/won/high), operator, dates, contracted miles." },
  "route-performance": { file: "route-performance.json",  desc: "Reliability per route — EWT/OTP vs the MPS benchmark, % mileage operated." },
  "accidents":         { file: "accidents.json",          desc: "STATS19 bus collisions — lat/lng, severity, date, borough." },
  "bridges":           { file: "bridges.json",            desc: "Low bridges / height restrictions — lat/lng, clearance (m + imperial), name, road." },
  "manifest":          { file: "_manifest.json",          desc: "Pipeline run manifest — per-dataset fetchedAt timestamps and row counts." },
};
// Read a v1 dataset straight from its committed file (mirrors the prod function).
function v1File(name) {
  const ds = V1_SETS[name]; if (!ds) return { code: 404, obj: { error: "unknown dataset: " + name, available: Object.keys(V1_SETS) } };
  try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", ds.file), "utf8")) }; }
  catch { return { code: 404, obj: { error: "dataset unavailable: " + name } }; }
}
const V1_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
function jsonCors(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", ...V1_CORS }); res.end(JSON.stringify(obj)); }
function v1Discovery(req) {
  const origin = `http://${req.headers.host || "localhost:" + PORT}`;
  return {
    service: "Atlas — London Bus Network API", version: "v1",
    description: "Open, read-only API for the London bus network: routes, stops, garages, fleet, tenders, reliability, collisions and low bridges. CORS-open, no key required.",
    attribution: "Derived from open sources — TfL Unified API, DfT/STATS19, London Datastore (EPOWR), DVLA VES, londonbusroutes.net. Respect the upstream licences when reusing.",
    livePositions: { path: "/api/live/vehicles?line=<route>", note: "Real-time bus GPS (BODS SIRI-VM) — a separate, volatile endpoint (10s edge cache), not part of v1." },
    endpoints: Object.entries(V1_SETS).map(([k, v]) => ({ name: k, path: `/api/v1/${k}`, url: `${origin}/api/v1/${k}`, description: v.desc })),
  };
}

http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  // ── LIVE capture: POST /ingest { entityType, items:[{id,data}], kind? } ──────
  if (urlPath === "/ingest") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    try {
      const { entityType, items } = JSON.parse(await readBody(req) || "{}");
      if (!ALLOWED_ENTITIES.has(entityType)) return json(res, 400, { error: "unknown entityType" });
      if (!Array.isArray(items) || items.length > 5000) return json(res, 400, { error: "items[] required (max 5000)" });
      for (const it of items) if (!it || it.id == null || typeof it.data !== "object" || it.data == null)
        return json(res, 400, { error: "each item needs { id, data:object }" });
      const r = dbx.observeMany(entityType, items, { kind: "live", runId: liveRunId });  // kind forced; never trusted from client
      return json(res, 200, { ok: true, ...r });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }
  if (urlPath === "/db/stats") return json(res, 200, dbx.stats());

  // ── LIVE vehicle positions (BODS SIRI-VM), proxied + CACHED. We pull the whole
  //    London feed ONCE per 10s (BODS rate-limit; key stays server-side) and serve
  //    every route from that single cached snapshot. NOTE: BODS LineRef is an internal
  //    id (≠ the public route), so we filter by PublishedLineName (?line=<route>). ────
  if (urlPath === "/api/live/vehicles") {
    if (!hasBodsKey()) return json(res, 200, { live: false, vehicles: [], note: "no BODS key — live positions unavailable" });
    // ?line=25 or ?line=25,86 — filter the cached London snapshot by PublishedLineName(s)
    const lines = new Set((new URL(req.url, "http://x").searchParams.get("line") || "").split(",").map(s => s.trim()).filter(Boolean));
    const hit = liveCache.get("_london");
    const fresh = hit && Date.now() - hit.at < LIVE_TTL_MS;
    const reply = (rec, cached) => { const vehicles = lines.size ? rec.vehicles.filter(v => lines.has(String(v.publishedLine))) : rec.vehicles;
      return json(res, 200, { live: true, cached, capturedAt: rec.at, vehicles }); };
    if (fresh) return reply(hit, true);
    try {
      const vehicles = await fetchVehicleActivity({});   // whole London bbox, no (broken) lineRef filter
      const rec = { at: Date.now(), vehicles }; liveCache.set("_london", rec);
      return reply(rec, false);
    } catch (e) {
      if (hit) return reply(hit, true);   // serve last-good
      return json(res, 502, { live: false, vehicles: [], error: String(e.message || e) });
    }
  }

  // ── PUBLIC API: /api/v1/* — CORS-open, versioned mirror of the prod Pages Function
  //    (functions/api/v1/[[path]].js). Same dataset names + shapes; keep both in sync. ──
  if (urlPath === "/api/v1" || urlPath === "/api/v1/") return jsonCors(res, 200, v1Discovery(req));
  if (urlPath.startsWith("/api/v1/")) {
    if (req.method === "OPTIONS") { res.writeHead(204, { ...V1_CORS, "Access-Control-Max-Age": "86400" }); return res.end(); }
    const name = urlPath.slice("/api/v1/".length);
    if (!V1_SETS[name]) return jsonCors(res, 404, { error: "unknown dataset: " + name, available: Object.keys(V1_SETS) });
    try { const { code, obj } = v1File(name); return jsonCors(res, code, obj); }
    catch (e) { return jsonCors(res, 500, { error: String(e.message || e) }); }
  }

  // ── READ the warehouse: tools fetch /api/* (DB) before the static JSON files ──
  if (urlPath.startsWith("/api/")) {
    try { const { code, obj } = apiData(urlPath.slice(5)); return json(res, code, obj); }
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  // ── static files (allowlisted: tool pages + JSON store only) ─────────────────
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const fp = path.join(ROOT, path.normalize(rel));
  const ext = path.extname(fp).toLowerCase();
  if (!fp.startsWith(ROOT) || !staticAllowed(rel, ext)) { res.writeHead(404).end("not found"); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end("404 " + rel); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Atlas — Transit Instruments at http://localhost:${PORT}/  (Ctrl-C to stop)`);
  console.log(`  live positions → GET /api/live/vehicles · live capture → POST /ingest · stats → GET /db/stats`);
});
