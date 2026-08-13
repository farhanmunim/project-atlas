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
  if (rel === "/v2/index.html") return true;   // the v2 (Route Lens) page
  if (rel === "/docs/index.html") return true; // the API documentation page
  if (rel === "/llms.txt") return true;        // machine-readable API summary (llms.txt convention)

  if (rel.startsWith("/data/") && (ext === ".json" || ext === ".geojson")) return true;
  return [".svg", ".png", ".ico", ".css", ".webmanifest"].includes(ext);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".txt": "text/plain; charset=utf-8",
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
  if (name === "crowding")      { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "crowding.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no crowding" } }; } }
  if (name === "crowding-profile") { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "crowding-profile.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no crowding-profile" } }; } }
  if (name === "localities")    { try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "localities.json"), "utf8")) }; } catch { return { code: 404, obj: { error: "no localities" } }; } }
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
  "routes-overview":   { file: "routes-overview.geojson", desc: "Route line geometry as a GeoJSON FeatureCollection — simplified (~11 m tolerance) for the whole-network layer. For the road-faithful line of one route use route-geometry/<id>." },
  "garages":           { file: "garages.json",            desc: "Bus garages — code, name, operator, lat/lng, PVR, routes served." },
  "fleet":             { file: "fleet.json",              desc: "Fleet profile per route — vehicle count, average age, propulsion mix, makes." },
  "vehicles":          { file: "vehicles.json",           desc: "Vehicle register keyed by registration — routes, operator, make, year, fuel." },
  "tenders":           { file: "tenders.json",            desc: "Tender / contract award history per route — bids (low/won/high), operator, dates, contracted miles, plus derived joint-bid (partner routes + total), awarded vehicle (deck/propulsion/basis) and tranche." },
  "route-performance": { file: "route-performance.json",  desc: "Reliability per route — EWT/OTP vs the MPS benchmark, % mileage operated." },
  "accidents":         { file: "accidents.json",          desc: "STATS19 bus collisions — lat/lng, severity, date, borough, vehicles, casualties, plus decoded context: roadType, speedLimit, junction, light, weather, roadSurface, day, timeBand." },
  "bridges":           { file: "bridges.json",            desc: "Low bridges / height restrictions — lat/lng, clearance (m + imperial), name, road." },
  "crowding":          { file: "crowding.json",           desc: "Bus crowding per route (TfL BUSTO) — peak V/C (load÷capacity at the max-demand hour), band (comfortable→crowded), busiest stop/time/day, and the per-day-type peak." },
  "crowding-profile":  { file: "crowding-profile.json",   desc: "Per-route crowding detail (TfL BUSTO) — load-along-route (V/C by stop in sequence) and the time-of-day curve (V/C per timeband, per day type). Powers the corridor gradient + dossier charts." },
  "localities":        { file: "localities.json",         desc: "London locality labels for the map — towns & suburbs (name, lat/lng, kind). Source: OpenStreetMap (ODbL)." },
  "route-diversions":  { file: "route-diversions.json",   desc: "Active route diversions keyed by route — status/reason/validity from TfL live status, plus the diff of TfL's current Route/Sequence against our canonical baseline: missed stops, temporary added stops, and (when TfL has redrawn the line) the diverted geometry segments + bypassed baseline segments. Refreshed daily." },
  "manifest":          { file: "_manifest.json",          desc: "Pipeline run manifest — per-dataset fetchedAt timestamps and row counts." },
};
// Read a v1 dataset straight from its committed file (mirrors the prod function).
function v1File(name) {
  const ds = V1_SETS[name]; if (!ds) return { code: 404, obj: { error: "unknown dataset: " + name, available: Object.keys(V1_SETS) } };
  try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", ds.file), "utf8")) }; }
  catch { return { code: 404, obj: { error: "dataset unavailable: " + name } }; }
}
// /api/v1/route-geometry/<id> — per-route full-fidelity geometry (mirrors the prod function).
function v1RouteGeometry(id) {
  if (!/^[a-z0-9-]{1,12}$/.test(id)) return { code: 400, obj: { error: "usage: /api/v1/route-geometry/<route id>, e.g. /api/v1/route-geometry/w12" } };
  try { return { code: 200, obj: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "route-geometry", `${id}.json`), "utf8")) }; }
  catch { return { code: 404, obj: { error: "no detailed geometry for route: " + id, fallback: "/api/v1/routes-overview" } }; }
}
const V1_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
function jsonCors(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", ...V1_CORS }); res.end(JSON.stringify(obj)); }
function v1Discovery(req) {
  const origin = `http://${req.headers.host || "localhost:" + PORT}`;
  return {
    service: "Atlas — London Bus Network API", version: "v1",
    description: "Open, read-only API for the London bus network: routes, stops, garages, fleet, tenders, reliability, collisions and low bridges. CORS-open, no key required.",
    attribution: "Derived from open sources — TfL Unified API, DfT/STATS19, London Datastore (EPOWR), DVLA VES, londonbusroutes.net. Respect the upstream licences when reusing.",
    livePositions: { path: "/api/live/vehicles?line=<route>", note: "Real-time bus GPS (BODS SIRI-VM) — a separate, volatile endpoint (10s edge cache)." },
    groups: {
      current: { path: "/api/v1", note: "Current snapshot of the warehouse (the datasets below)." },
      history: { path: "/api/v1/history", url: `${origin}/api/v1/history`, note: "Time-series from the Supabase warehouse — daily reliability, performance history, schedule, tender programme, vehicle sightings." },
      live: { path: "/api/v1/live", url: `${origin}/api/v1/live`, note: "Live bus + road feeds proxied from TfL — status, arrivals, disruptions, road incidents." },
    },
    endpoints: [
      ...Object.entries(V1_SETS).map(([k, v]) => ({ name: k, path: `/api/v1/${k}`, url: `${origin}/api/v1/${k}`, description: v.desc })),
      { name: "route-geometry", path: "/api/v1/route-geometry/<id>", url: `${origin}/api/v1/route-geometry/w12`, description: "Full-fidelity geometry for ONE route (TfL's raw ring, 5 dp, both directions + lengthKm) — the road-faithful line the apps draw on selection. 404 when no detailed file exists (fall back to routes-overview)." },
    ],
  };
}
// ── Live API (TfL proxy) — mirrors functions/api/v1/live/[[path]].js. Keyless TfL.
const TFL_BASE = "https://api.tfl.gov.uk";
const LIVE_EP = {
  "status":          { ttl: 30, url: (p) => { const r = (p.get("route") || "").trim(); return r ? `/Line/${encodeURIComponent(r)}/Status` : `/Line/Mode/bus/Status`; }, desc: "Live bus line status. ?route=25 or 25,86, else whole network." },
  "disruptions":     { ttl: 60, url: () => `/Line/Mode/bus/Disruption`, desc: "Active bus line disruptions." },
  "arrivals":        { ttl: 30, url: (p) => { const r = (p.get("route") || "").trim(), s = (p.get("stop") || "").trim(); return s ? `/StopPoint/${encodeURIComponent(s)}/Arrivals` : r ? `/Line/${encodeURIComponent(r)}/Arrivals` : null; }, desc: "Live arrivals. ?stop=<naptan> or ?route=<id>." },
  "road-disruptions":{ ttl: 60, url: () => `/Road/all/Disruption`, desc: "Live London road incidents / closures (TfL control centre, ~5 min)." },
  "national-highways":{ ttl: 86400, retired: true, desc: "RETIRED — National Highways withdrew the keyless RSS feed this endpoint proxied (every legacy URL now 404s; the replacement API requires a registered key). Returns 410 Gone. Use /api/v1/live/road-disruptions for London road incidents." },
  "vehicles":        { ttl: 10, custom: true, desc: "Live bus GPS positions (BODS SIRI-VM), Greater London. ?line=25 or ?route=25 filters to a route; omit for the whole network." },
};
// ── History API (Supabase proxy) — mirrors functions/api/v1/history/[[path]].js.
const HIST_EP = {
  "reliability-daily":   { table: "route_reliability_daily", filters: { route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"] }, defaultOrder: "day.desc", desc: "Our daily reliability per route (EWT/OTD/lost mileage)." },
  "performance-history": { table: "route_performance", filters: { route: ["route_id", "eq"] }, defaultOrder: "period_end.desc", desc: "TfL quarterly performance per route, all periods." },
  "schedule":            { table: "route_schedule", filters: { route: ["route_id", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"] }, defaultOrder: "snapshot_date.desc", desc: "Scheduled service per route over time." },
  "tender-programme":    { table: "tender_programme", filters: { route: ["route_id", "eq"], year: ["programme_year", "eq"] }, defaultOrder: "contract_start_date.asc", desc: "TfL forward tendering programme per route." },
  "route-snapshots":     { table: "route_snapshots", filters: { route: ["route_id", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"], operator: ["operator", "eq"], propulsion: ["propulsion", "eq"], garage: ["garage_code", "eq"] }, defaultOrder: "snapshot_date.desc", desc: "Per-route CDC snapshots over time (PVR, propulsion, operator, garage, fleet, MPS)." },
  "garage-snapshots":    { table: "garage_snapshots", filters: { garage: ["garage_code", "eq"], operator: ["operator", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"] }, defaultOrder: "snapshot_date.desc", desc: "Per-garage snapshots over time (total PVR, route count, routes)." },
  "vehicle-sightings":   { table: "route_vehicle_observations", filters: { route: ["route_id", "eq"], reg: ["registration", "eq"], from: ["observed_at", "gte"], to: ["observed_at", "lte"] }, defaultOrder: "observed_at.desc", desc: "Vehicle-on-route observations over time (months of history)." },
  "accidents":           { table: "accidents", filters: { from: ["collision_date", "gte"], to: ["collision_date", "lte"], severity: ["severity", "eq"], borough: ["borough", "eq"], road_type: ["road_type", "eq"], speed_limit: ["speed_limit", "eq"], day: ["day", "eq"], time_band: ["time_band", "eq"] }, defaultOrder: "collision_date.desc", desc: "STATS19 bus collisions over time — filter by from/to date, severity, borough, road_type, speed_limit, day, time_band; rows also carry junction/light/weather/road_surface." },
  "crowding":            { table: "bus_crowding", filters: { route: ["route_id", "eq"], band: ["band", "eq"], year: ["busto_year", "eq"], day_type: ["day_type", "eq"] }, defaultOrder: "peak_vc.desc", desc: "Bus crowding per route per year (TfL BUSTO) — peak V/C, band, busiest stop/time/day; filter by route, band, year, day_type." },
  "lost-mileage":        { table: "route_lost_mileage_daily", filters: { route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"], day_type: ["day_type", "eq"], confidence: ["confidence", "eq"] }, defaultOrder: "day.desc", desc: "Atlas's own daily GROSS lost-mileage estimate per route — EXPERIMENTAL. Observed BODS trips matched vs scheduled departures; feed-unhealthy hours are unmeasured, never lost." },
};
function liveDiscovery(req) { const origin = `http://${req.headers.host || "localhost:" + PORT}`;
  return { group: "live", version: "v1", description: "Live bus + road feeds proxied from the TfL Unified API, edge-cached. Read-only, CORS-open.",
    livePositions: { path: "/api/live/vehicles?line=<route>", note: "Real-time bus GPS (BODS SIRI-VM) — separate keyed endpoint." },
    endpoints: Object.entries(LIVE_EP).map(([k, v]) => ({ name: k, path: `/api/v1/live/${k}`, url: `${origin}/api/v1/live/${k}`, description: v.desc, ...(v.retired ? { retired: true } : {}) })) }; }
function histDiscovery(req) { const origin = `http://${req.headers.host || "localhost:" + PORT}`;
  return { group: "history", version: "v1", description: "Historical / time-series data from the Atlas Supabase warehouse. Params: route, from, to, reg, year, limit (max 1000), order.",
    endpoints: Object.entries(HIST_EP).map(([k, v]) => ({ name: k, path: `/api/v1/history/${k}`, url: `${origin}/api/v1/history/${k}`, description: v.desc })) }; }
async function serveLive(req, res, name) {
  const ep = LIVE_EP[name]; if (!ep) return jsonCors(res, 404, { error: "unknown live feed: " + name, available: Object.keys(LIVE_EP) });
  if (ep.retired) return jsonCors(res, 410, { error: "live feed retired: " + name,
    note: "National Highways withdrew the keyless RSS this endpoint proxied; its replacement API requires a registered key.",
    alternative: "/api/v1/live/road-disruptions" });
  // Live bus GPS — shares the /api/live/vehicles cached London snapshot (liveCache "_london").
  if (ep.custom && name === "vehicles") {
    if (!hasBodsKey()) return jsonCors(res, 200, { feed: name, live: false, count: 0, data: [], note: "no BODS key — live positions unavailable" });
    const sp = new URL(req.url, "http://x").searchParams;
    const lines = new Set((sp.get("line") || sp.get("route") || "").split(",").map((s) => s.trim()).filter(Boolean));
    const filt = (v) => !lines.size || lines.has(String(v.publishedLine));
    const reply = (rec, cached) => { const data = rec.vehicles.filter(filt); return jsonCors(res, 200, { feed: name, live: true, cached, capturedAt: rec.at, count: data.length, data }); };
    const hit = liveCache.get("_london"); if (hit && Date.now() - hit.at < LIVE_TTL_MS) return reply(hit, true);
    try { const rec = { at: Date.now(), vehicles: await fetchVehicleActivity({}) }; liveCache.set("_london", rec); return reply(rec, false); }
    catch (e) { if (hit) return reply(hit, true); return jsonCors(res, 502, { feed: name, live: false, data: [], error: String(e.message || e) }); }
  }
  const sp = new URL(req.url, "http://x").searchParams; const tflPath = ep.url(sp);
  if (!tflPath) return jsonCors(res, 400, { error: "missing required param (stop or route)" });
  let url = `${TFL_BASE}${tflPath}`; if (process.env.TFL_APP_KEY) url += (url.includes("?") ? "&" : "?") + `app_key=${process.env.TFL_APP_KEY}`;
  try { const r = await fetch(url, { headers: { Accept: "application/json" } }); if (!r.ok) return jsonCors(res, 502, { error: `live feed failed (${r.status})` });
    return jsonCors(res, 200, { feed: name, capturedAt: new Date().toISOString(), data: await r.json() }); }
  catch (e) { return jsonCors(res, 502, { error: "live feed unreachable" }); }
}
// Accidents fallback (mirrors functions/api/v1/history/[[path]].js): the full enriched STATS19
// set also lives in the static snapshot, so when Supabase can't serve it (unconfigured here, or a
// filter hits a not-yet-migrated column) we filter the snapshot so the documented filters still work.
const ACC_SNAP_FILTERS = { from: ["date", "gte"], to: ["date", "lte"], severity: ["severity", "eq"], borough: ["borough", "eq"], road_type: ["roadType", "eq"], speed_limit: ["speedLimit", "eq"], day: ["day", "eq"], time_band: ["timeBand", "eq"] };
function accidentsSnapshot(q, limit, order) {
  let snap;
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "accidents.json"), "utf8")); snap = Array.isArray(d) ? d : (d && d.accidents) || null; } catch { return null; }
  if (!Array.isArray(snap)) return null;
  let rows = snap.filter((a) => {
    for (const [param, [col, op]] of Object.entries(ACC_SNAP_FILTERS)) {
      const v = q.get(param); if (v == null || v === "") continue;
      const cell = a[col] == null ? "" : String(a[col]);
      if (op === "eq" && cell !== v) return false;
      if (op === "gte" && !(cell >= v)) return false;
      if (op === "lte" && !(cell <= v)) return false;
    }
    return true;
  });
  const ORDER_MAP = { collision_date: "date", severity: "severity", borough: "borough", vehicles: "vehicles", casualties: "casualties", road_type: "roadType", speed_limit: "speedLimit", junction: "junction", light: "light", weather: "weather", road_surface: "roadSurface", day: "day", time_band: "timeBand" };
  const om = /^([a-z_]+)\.(asc|desc)$/.exec(order || "");
  const ocol = (om && ORDER_MAP[om[1]]) || "date", desc = om ? om[2] === "desc" : true;
  rows.sort((a, b) => { const av = a[ocol], bv = b[ocol]; const c = (typeof av === "number" && typeof bv === "number") ? (av - bv) : String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv)); return desc ? -c : c; });
  rows = rows.slice(0, limit).map((a) => ({ collision_id: a.id, lat: a.lat, lng: a.lng, severity: a.severity, collision_date: a.date, borough: a.borough, vehicles: a.vehicles, casualties: a.casualties, road_type: a.roadType, speed_limit: a.speedLimit, junction: a.junction, light: a.light, weather: a.weather, road_surface: a.roadSurface, day: a.day, time_band: a.timeBand }));
  return { dataset: "accidents", table: "accidents", source: "snapshot (data/accidents.json — warehouse migration pending)", count: rows.length, limit, rows };
}
// Crowding fallback (mirrors functions/api/v1/history/[[path]].js): flatten the per-route crowding
// snapshot into warehouse-shaped rows so /api/v1/history/crowding works before the migration lands.
function crowdingSnapshot(q, limit, order) {
  let snap, year;
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "crowding.json"), "utf8")); snap = d && d.routes; year = d && d.year; } catch { return null; }
  if (!snap || typeof snap !== "object") return null;
  const byDayVC = (c, day) => (c.byDay && c.byDay[day] && c.byDay[day].vc != null ? c.byDay[day].vc : null);
  let rows = Object.keys(snap).map((route) => { const c = snap[route]; return {
    route_id: route, busto_year: year, peak_vc: c.peakVC, band: c.band, load: c.load, capacity: c.capacity,
    seats: c.seats, boardings: c.boardings, day_type: c.dayType, peak_time: c.time, timeband: c.timeband,
    direction: c.direction, stopcode: c.stopcode, stopname: c.stopname, stop_sequence: c.stopSeq,
    max_load: c.maxLoad, max_capacity: c.maxCapacity,
    weekday_vc: byDayVC(c, "Weekday"), saturday_vc: byDayVC(c, "Saturday"), sunday_vc: byDayVC(c, "Sunday") }; });
  const f = { route: "route_id", band: "band", year: "busto_year", day_type: "day_type" };
  for (const [param, col] of Object.entries(f)) { const v = q.get(param); if (v != null && v !== "") rows = rows.filter((x) => String(x[col]) === v); }
  const om = /^([a-z_]+)\.(asc|desc)$/.exec(order || ""); const ocol = om ? om[1] : "peak_vc", desc = om ? om[2] === "desc" : true;
  rows.sort((a, b) => { const av = a[ocol], bv = b[ocol]; const c = (typeof av === "number" && typeof bv === "number") ? (av - bv) : String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv)); return desc ? -c : c; });
  rows = rows.slice(0, limit);
  return { dataset: "crowding", table: "bus_crowding", source: "snapshot (data/crowding.json — warehouse migration pending)", count: rows.length, limit, rows };
}
const HIST_SNAPSHOTS = { accidents: accidentsSnapshot, crowding: crowdingSnapshot };
async function serveHistory(req, res, name) {
  const ep = HIST_EP[name]; if (!ep) return jsonCors(res, 404, { error: "unknown history dataset: " + name, available: Object.keys(HIST_EP) });
  const q = new URL(req.url, "http://x").searchParams;
  let limit = parseInt(q.get("limit"), 10); limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
  const order = /^[a-z_]+\.(asc|desc)$/.test(q.get("order") || "") ? q.get("order") : ep.defaultOrder;
  const snapshot = HIST_SNAPSHOTS[name];
  const canSnapshot = !!snapshot;
  const base = process.env.WAREHOUSE_URL, key = process.env.WAREHOUSE_ANON_KEY || process.env.WAREHOUSE_SERVICE_KEY;
  if (!base || !key) {
    if (canSnapshot) { const fb = snapshot(q, limit, order); if (fb) return jsonCors(res, 200, fb); }
    return jsonCors(res, 503, { error: "historical store not configured (WAREHOUSE_URL / WAREHOUSE_ANON_KEY not set locally)" });
  }
  const parts = [];
  for (const [param, [col, op]] of Object.entries(ep.filters)) { const v = q.get(param); if (v) parts.push(`${col}=${op}.${encodeURIComponent(v)}`); }
  parts.push(`order=${order}`, `limit=${limit}`);
  let warehouseOrigin; try { warehouseOrigin = new URL(base).origin; } catch { return jsonCors(res, 503, { error: "WAREHOUSE_URL is not a valid URL" }); }
  const url = `${warehouseOrigin}/rest/v1/${ep.table}?select=*&${parts.join("&")}`;
  try { const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) {
      if (canSnapshot) { const fb = snapshot(q, limit, order); if (fb) return jsonCors(res, 200, fb); }
      return jsonCors(res, (r.status >= 400 && r.status < 500) ? r.status : 502, { error: `historical query failed (${r.status})`, detail: (await r.text()).slice(0, 300) });
    }
    const rows = await r.json(); return jsonCors(res, 200, { dataset: name, table: ep.table, count: Array.isArray(rows) ? rows.length : 0, limit, rows }); }
  catch (e) { if (canSnapshot) { const fb = snapshot(q, limit, order); if (fb) return jsonCors(res, 200, fb); } return jsonCors(res, 502, { error: "historical store unreachable" }); }
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
  if (req.method === "OPTIONS" && urlPath.startsWith("/api/v1")) { res.writeHead(204, { ...V1_CORS, "Access-Control-Max-Age": "86400" }); return res.end(); }
  if (urlPath === "/api/v1" || urlPath === "/api/v1/") return jsonCors(res, 200, v1Discovery(req));
  // live sub-group (TfL proxy) and history sub-group (Supabase proxy)
  if (urlPath === "/api/v1/live" || urlPath === "/api/v1/live/") return jsonCors(res, 200, liveDiscovery(req));
  if (urlPath.startsWith("/api/v1/live/")) return serveLive(req, res, urlPath.slice("/api/v1/live/".length));
  if (urlPath === "/api/v1/history" || urlPath === "/api/v1/history/") return jsonCors(res, 200, histDiscovery(req));
  if (urlPath.startsWith("/api/v1/history/")) return serveHistory(req, res, urlPath.slice("/api/v1/history/".length));
  if (urlPath.startsWith("/api/v1/route-geometry/")) {
    const { code, obj } = v1RouteGeometry(urlPath.slice("/api/v1/route-geometry/".length).toLowerCase());
    return jsonCors(res, code, obj);
  }
  if (urlPath.startsWith("/api/v1/")) {
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
  // directory-index pages (mirrors Cloudflare Pages): /v2 and /v2/ → /v2/index.html.
  if (/^\/v2\/?$/.test(rel)) rel = "/v2/index.html";
  if (/^\/docs\/?$/.test(rel)) rel = "/docs/index.html";
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
