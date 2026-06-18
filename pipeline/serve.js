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

  // ── READ the warehouse: tools fetch /api/* (DB) before the static JSON files ──
  if (urlPath.startsWith("/api/")) {
    try {
      const name = urlPath.slice(5);
      const generatedAt = dbx.latestObservedAt();
      if (name === "routes")        return json(res, 200, dbx.allCurrent("route").map((x) => x.data));
      if (name === "route-meta")    return json(res, 200, { generatedAt, routes: Object.fromEntries(dbx.allCurrent("route_meta").map((x) => [x.id, x.data])) });
      if (name === "route-stops")   return json(res, 200, { generatedAt, routes: Object.fromEntries(dbx.allCurrent("route_stops").map((x) => [x.id, x.data])) });
      if (name === "line-status")   return json(res, 200, { capturedAt: generatedAt, rows: dbx.allCurrent("line_status").map((x) => x.data) });
      if (name === "garages")       return json(res, 200, { generatedAt, garages: dbx.allCurrent("garage").map((x) => x.data) });
      if (name === "fleet")         return json(res, 200, { generatedAt, byRoute: Object.fromEntries(dbx.allCurrent("fleet").map((x) => [x.id, x.data])) });
      if (name === "vehicles")      return json(res, 200, { generatedAt, byReg: Object.fromEntries(dbx.allCurrent("vehicle").map((x) => [x.id, x.data])) });
      if (name === "manifest")      return json(res, 200, { generatedAt, source: "database" });
      if (name === "route-performance") { try { return json(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-performance.json"), "utf8"))); } catch { return json(res, 404, { error: "no route-performance" }); } }
      if (name === "accidents") { try { return json(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, "data", "accidents.json"), "utf8"))); } catch { return json(res, 404, { error: "no accidents" }); } }
      if (name === "routes-overview") {
        const features = dbx.allCurrent("route_geometry").map((x) => { const [routeId, direction] = x.id.split(":");
          return { type: "Feature", properties: { routeId, direction, lengthKm: x.data.lengthKm, stops: x.data.stops }, geometry: { type: "LineString", coordinates: x.data.coords } }; });
        return json(res, 200, { type: "FeatureCollection", metadata: { generatedAt, featureCount: features.length, partial: false }, features });
      }
      if (name === "tenders") {
        const byRoute = {}; const parseDate = (s) => { const t = Date.parse(s || ""); return Number.isNaN(t) ? 0 : t; };
        for (const { data } of dbx.allCurrent("tender")) for (const k of String(data.route || "").split(/[\/,]/).map((s) => s.trim()).filter(Boolean)) (byRoute[k] ||= []).push(data);
        for (const k of Object.keys(byRoute)) byRoute[k].sort((a, b) => parseDate(b.awardDate) - parseDate(a.awardDate) || Number(b.btID) - Number(a.btID));
        return json(res, 200, { generatedAt, byRoute });
      }
      return json(res, 404, { error: "unknown dataset: " + name });
    } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
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
