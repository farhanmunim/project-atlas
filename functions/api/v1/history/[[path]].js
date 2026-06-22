/**
 * /api/v1/history/* — Atlas historical/time-series API (Supabase-backed).
 *
 * The static /api/v1/* datasets are "today's values". This exposes the time-series
 * that accrues in our Supabase warehouse (the decoupled `ingest/` pipeline): our own
 * daily reliability, TfL's quarterly performance history, scheduled service, the
 * forward tender programme, and vehicle-on-route sightings over time.
 *
 * Read-only, CORS-open, no caller key. The Supabase key is a server-side Cloudflare
 * secret (SUPABASE_URL + SUPABASE_KEY) — it NEVER reaches the browser. Each endpoint
 * is a strict whitelist (table + allowed filters + capped page size), so the Function
 * can only ever SELECT the columns we intend.
 *
 * Query params (all optional): route=<id>, from=<date>, to=<date>, reg=<plate>,
 * year=<programme year>, limit=<n, max 1000>, order=<col.asc|col.desc>.
 */

// endpoint → { table, filters: param→[column,op], defaultOrder, desc }
const ENDPOINTS = {
  "reliability-daily": {
    table: "route_reliability_daily",
    filters: { route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"] },
    defaultOrder: "day.desc",
    desc: "Our own daily reliability per route — AWT/SWT/EWT (high-freq), OTD (low-freq), scheduled vs operated km (lost mileage). Estimate; improves with sampling.",
  },
  "performance-history": {
    table: "route_performance",
    filters: { route: ["route_id", "eq"] },
    defaultOrder: "period_end.desc",
    desc: "TfL's published quarterly performance per route across all captured periods — EWT/SWT/AWT, on-time %, mileage operated %.",
  },
  "schedule": {
    table: "route_schedule",
    filters: { route: ["route_id", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"] },
    defaultOrder: "snapshot_date.desc",
    desc: "Scheduled service per route over time — service class, SWT, scheduled trips/km, representative headway.",
  },
  "tender-programme": {
    table: "tender_programme",
    filters: { route: ["route_id", "eq"], year: ["programme_year", "eq"] },
    defaultOrder: "contract_start_date.asc",
    desc: "TfL's forward LBSL tendering programme — issue/return/award/start dates, vehicle type, extension flag, per route.",
  },
  "vehicle-sightings": {
    table: "route_vehicle_observations",
    filters: { route: ["route_id", "eq"], reg: ["registration", "eq"], from: ["observed_at", "gte"], to: ["observed_at", "lte"] },
    defaultOrder: "observed_at.desc",
    desc: "Vehicle-on-route observations over time (reg ↔ route ↔ timestamp) — months of history; the basis for fleet movement analysis.",
  },
  "accidents": {
    table: "accidents",
    filters: { from: ["collision_date", "gte"], to: ["collision_date", "lte"], severity: ["severity", "eq"], borough: ["borough", "eq"], road_type: ["road_type", "eq"], speed_limit: ["speed_limit", "eq"], day: ["day", "eq"], time_band: ["time_band", "eq"] },
    defaultOrder: "collision_date.desc",
    desc: "STATS19 bus/coach-involved collisions over time — lat/lng, severity, date, borough (ONS code), vehicle count, plus decoded context: road_type, speed_limit, junction, light, weather, road_surface, day, time_band. Filter by from/to date, severity, borough, road_type, speed_limit, day, time_band. The temporal source behind the /api/v1/accidents snapshot.",
  },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
const json = (obj, { status = 200, cache = "public, max-age=300" } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...CORS } });

const MAX_LIMIT = 1000, DEFAULT_LIMIT = 200;

// Accidents fallback: the full multi-year enriched STATS19 set also ships as the static
// snapshot (/api/v1/accidents — all of 2020–2024 with every decoded field). When Supabase
// can't serve it (unconfigured, or a filter hits a column whose migration is still pending),
// filter the snapshot in-memory so the documented filters still return enriched rows. Same
// filter/limit/order contract, normalised to the warehouse (snake_case) shape.
const ACC_SNAP_FILTERS = {
  from: ["date", "gte"], to: ["date", "lte"], severity: ["severity", "eq"], borough: ["borough", "eq"],
  road_type: ["roadType", "eq"], speed_limit: ["speedLimit", "eq"], day: ["day", "eq"], time_band: ["timeBand", "eq"],
};
async function accidentsSnapshot(origin, q, limit, order) {
  let snap;
  try {
    // fetch the static asset directly (edge-cached) — not /api/v1/accidents, which would add a
    // Function-to-Function subrequest hop (and can time the Function out).
    const r = await fetch(`${origin}/data/accidents.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return null;
    const d = await r.json();
    snap = Array.isArray(d) ? d : (d && d.accidents) || null;
  } catch { return null; }
  if (!Array.isArray(snap)) return null;
  let rows = snap.filter((a) => {
    for (const [param, [col, op]] of Object.entries(ACC_SNAP_FILTERS)) {
      const v = q.get(param);
      if (v == null || v === "") continue;
      const cell = a[col] == null ? "" : String(a[col]);
      if (op === "eq" && cell !== v) return false;
      if (op === "gte" && !(cell >= v)) return false;     // ISO dates compare lexicographically
      if (op === "lte" && !(cell <= v)) return false;
    }
    return true;
  });
  const desc = !/\.asc$/.test(order);                      // default / collision_date.desc → newest first
  rows.sort((a, b) => desc ? String(b.date).localeCompare(String(a.date)) : String(a.date).localeCompare(String(b.date)));
  rows = rows.slice(0, limit).map((a) => ({
    collision_id: a.id, lat: a.lat, lng: a.lng, severity: a.severity, collision_date: a.date,
    borough: a.borough, vehicles: a.vehicles, casualties: a.casualties, road_type: a.roadType,
    speed_limit: a.speedLimit, junction: a.junction, light: a.light, weather: a.weather,
    road_surface: a.roadSurface, day: a.day, time_band: a.timeBand,
  }));
  return json({ dataset: "accidents", table: "accidents", source: "snapshot (data/accidents.json — warehouse migration pending)", count: rows.length, limit, rows });
}

export async function onRequest(context) {
  const { request, params, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed — GET only" }, { status: 405 });

  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const name = (segs[0] || "").toLowerCase();
  const origin = new URL(request.url).origin;

  // index of historical endpoints
  if (!name) {
    return json({
      group: "history", version: "v1",
      description: "Historical / time-series data from the Atlas Supabase warehouse. Read-only, CORS-open. Params: route, from, to, reg, year, limit (max 1000), order.",
      endpoints: Object.entries(ENDPOINTS).map(([k, v]) => ({ name: k, path: `/api/v1/history/${k}`, url: `${origin}/api/v1/history/${k}`, description: v.desc })),
    });
  }

  const ep = ENDPOINTS[name];
  if (!ep) return json({ error: `unknown history dataset: ${name}`, available: Object.keys(ENDPOINTS) }, { status: 404 });

  // Parse the (whitelisted) query first — shared by the Supabase path and the snapshot fallback.
  const q = new URL(request.url).searchParams;
  let limit = parseInt(q.get("limit"), 10);
  limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  const order = /^[a-z_]+\.(asc|desc)$/.test(q.get("order") || "") ? q.get("order") : ep.defaultOrder;
  const canSnapshot = name === "accidents";   // accidents' full enriched set also lives in the static snapshot

  const base = env.SUPABASE_URL, key = env.SUPABASE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !key) {
    if (canSnapshot) { const fb = await accidentsSnapshot(origin, q, limit, order); if (fb) return fb; }
    return json({ error: "historical store not configured (SUPABASE_URL / SUPABASE_KEY not set)" }, { status: 503 });
  }

  // Build a strict PostgREST query from whitelisted params only.
  const parts = [];
  for (const [param, [col, op]] of Object.entries(ep.filters)) {
    const v = q.get(param);
    if (v != null && v !== "") parts.push(`${col}=${op}.${encodeURIComponent(v)}`);
  }
  parts.push(`order=${order}`, `limit=${limit}`);

  // Use only the origin of SUPABASE_URL, so a pasted trailing path/slash (e.g. ".../rest/v1")
  // can't produce a malformed "/rest/v1/rest/v1/..." path (PostgREST PGRST125).
  let supaOrigin;
  try { supaOrigin = new URL(base).origin; } catch { return json({ error: "SUPABASE_URL is not a valid URL" }, { status: 503 }); }
  const url = `${supaOrigin}/rest/v1/${ep.table}?select=*&${parts.join("&")}`;
  // NB: no `cacheEverything` here — Cloudflare rejects force-caching a subrequest that
  // carries an Authorization header (throws), so cache via our own Cache-Control instead.
  try {
    const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const body = await r.text();
    // Map upstream client errors (e.g. PostgREST 400 "column does not exist" when a filter
    // targets a column whose migration hasn't been applied yet) to a client status, not a 502 —
    // a bad/unsupported query param is the caller's error, not a server failure.
    if (!r.ok) {
      // e.g. PostgREST 400 because a filter targets a column whose migration is still pending —
      // serve the enriched snapshot instead of erroring, then fall back to a client status.
      if (canSnapshot) { const fb = await accidentsSnapshot(origin, q, limit, order); if (fb) return fb; }
      return json({ error: `historical query failed (${r.status})`, detail: body.slice(0, 300) }, { status: (r.status >= 400 && r.status < 500) ? r.status : 502 });
    }
    let rows; try { rows = JSON.parse(body); } catch { return json({ error: "historical store returned non-JSON", detail: body.slice(0, 200) }, { status: 502 }); }
    return json({ dataset: name, table: ep.table, count: Array.isArray(rows) ? rows.length : 0, limit, rows });
  } catch (e) {
    return json({ error: "historical store error", detail: String(e && e.message || e) }, { status: 502 });
  }
}
