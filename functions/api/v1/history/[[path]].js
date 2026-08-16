/**
 * /api/v1/history/* — Atlas historical/time-series API (PostgREST-backed).
 *
 * The static /api/v1/* datasets are "today's values". This exposes the time-series
 * that accrues in our warehouse (the decoupled `ingest/` pipeline, self-hosted Postgres
 * + PostgREST): our own daily reliability, TfL's quarterly performance history,
 * scheduled service, the forward tender programme, and vehicle-on-route sightings
 * over time.
 *
 * Read-only, CORS-open, no caller key. The warehouse key is a server-side Cloudflare
 * secret (WAREHOUSE_URL + WAREHOUSE_ANON_KEY) — it NEVER reaches the browser. Each
 * endpoint is a strict whitelist (table + allowed filters + capped page size), so the
 * Function can only ever SELECT the columns we intend.
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
  "route-snapshots": {
    table: "route_snapshots",
    filters: { route: ["route_id", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"], operator: ["operator", "eq"], propulsion: ["propulsion", "eq"], garage: ["garage_code", "eq"] },
    defaultOrder: "snapshot_date.desc",
    desc: "Per-route daily/weekly CDC snapshots — PVR, propulsion, deck, vehicle type, operator, garage, fleet size/age, MPS benchmarks. The change-over-time record behind fleet-move / propulsion-change / PVR-change analysis. Filter by route, from/to date, operator, propulsion, garage.",
  },
  "garage-snapshots": {
    table: "garage_snapshots",
    filters: { garage: ["garage_code", "eq"], operator: ["operator", "eq"], from: ["snapshot_date", "gte"], to: ["snapshot_date", "lte"] },
    defaultOrder: "snapshot_date.desc",
    desc: "Per-garage snapshots over time — total PVR, route count, routes served, operator. Capacity/allocation change analysis. Filter by garage (code), operator, from/to date.",
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
  "lost-mileage": {
    table: "route_lost_mileage_daily",
    filters: { route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"], day_type: ["day_type", "eq"], confidence: ["confidence", "eq"] },
    defaultOrder: "day.desc",
    desc: "Atlas's own daily GROSS lost-mileage estimate per route — EXPERIMENTAL. Scheduled trips (route_schedule) matched against continuously-observed BODS trips; hours with an unhealthy operator feed count as unmeasured, never lost. Gross: cause split (in/out of operator control) is invisible externally — TfL's contractual figure will differ. Filter by route, from/to day, day_type, confidence.",
  },
  "vehicle-assignments": {
    table: "vehicle_route_assignments_daily",
    filters: { reg: ["registration", "eq"], route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"] },
    defaultOrder: "day.desc",
    desc: "Per-vehicle DAILY route assignments from continuous BODS trip tracking — one row per (registration, route, day) with first/last-seen, trip count and observed km, so a bus reallocated mid-day (route A morning, route B evening) shows one row per route. Complements vehicle-sightings (the once-daily sample). Filter by reg, route, from/to day.",
  },
  "reliability-tracked": {
    table: "route_reliability_tracked_daily",
    filters: { route: ["route_id", "eq"], from: ["day", "gte"], to: ["day", "lte"], day_type: ["day_type", "eq"], confidence: ["confidence", "eq"] },
    defaultOrder: "day.desc",
    desc: "Atlas's own daily TRACKED reliability estimate per route (EWT/OTD v2) — EXPERIMENTAL. Passing times from continuous BODS trip tracking give COMPLETE observed headways within feed-healthy windows, removing the sampling bias of reliability-daily. EWT = AWT − SWT (Σh²/2Σh, high-frequency); OTD = % departures −2…+5 min with non-arrivals counted (low-frequency). Feed outages are unmeasured, never late/lost. Calibrating against TfL's quarterly QSI before promotion. Filter by route, from/to day, day_type, confidence.",
  },
  "crowding": {
    table: "bus_crowding",
    filters: { route: ["route_id", "eq"], band: ["band", "eq"], year: ["busto_year", "eq"], day_type: ["day_type", "eq"] },
    defaultOrder: "peak_vc.desc",
    desc: "Bus crowding per route over time (TfL BUSTO, one row per route per year) — peak V/C (load÷capacity at the max-demand hour), band, busiest stop/time/day, per-day-type peak. Filter by route, band, year, day_type. The temporal source behind the /api/v1/crowding snapshot.",
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
    // Function-to-Function subrequest hop. Bounded by an 8s abort so a slow/hanging fetch fails
    // FAST to the graceful 400 below rather than hanging the Function to a 524 gateway timeout.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try { r = await fetch(`${origin}/data/accidents.json`, { cf: { cacheTtl: 600, cacheEverything: true }, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
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
  // honour the requested order column (mapped warehouse snake_case → snapshot camelCase), so the
  // fallback's ordering matches the Supabase path rather than always sorting by date.
  const ORDER_MAP = { collision_date: "date", severity: "severity", borough: "borough", vehicles: "vehicles", casualties: "casualties", road_type: "roadType", speed_limit: "speedLimit", junction: "junction", light: "light", weather: "weather", road_surface: "roadSurface", day: "day", time_band: "timeBand" };
  const om = /^([a-z_]+)\.(asc|desc)$/.exec(order || "");
  const ocol = (om && ORDER_MAP[om[1]]) || "date", desc = om ? om[2] === "desc" : true;
  rows.sort((a, b) => {
    const av = a[ocol], bv = b[ocol];
    const c = (typeof av === "number" && typeof bv === "number") ? (av - bv) : String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv));
    return desc ? -c : c;
  });
  rows = rows.slice(0, limit).map((a) => ({
    collision_id: a.id, lat: a.lat, lng: a.lng, severity: a.severity, collision_date: a.date,
    borough: a.borough, vehicles: a.vehicles, casualties: a.casualties, road_type: a.roadType,
    speed_limit: a.speedLimit, junction: a.junction, light: a.light, weather: a.weather,
    road_surface: a.roadSurface, day: a.day, time_band: a.timeBand,
  }));
  return json({ dataset: "accidents", table: "accidents", source: "snapshot (data/accidents.json — warehouse migration pending)", count: rows.length, limit, rows });
}

// Crowding fallback: the per-route crowding snapshot also ships statically (/api/v1/crowding —
// keyed by route). When the warehouse can't serve it (unconfigured, or the bus_crowding migration
// is still pending), flatten the snapshot's routes into warehouse-shaped (snake_case) rows so the
// documented filters still return data. Supports route/band/year/day_type filters + the order column.
async function crowdingSnapshot(origin, q, limit, order) {
  let snap, year;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try { r = await fetch(`${origin}/data/crowding.json`, { cf: { cacheTtl: 600, cacheEverything: true }, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    if (!r.ok) return null;
    const d = await r.json();
    snap = d && d.routes; year = d && d.year;
  } catch { return null; }
  if (!snap || typeof snap !== "object") return null;
  const byDayVC = (c, day) => (c.byDay && c.byDay[day] && c.byDay[day].vc != null ? c.byDay[day].vc : null);
  let rows = Object.keys(snap).map((route) => {
    const c = snap[route];
    return {
      route_id: route, busto_year: year, peak_vc: c.peakVC, band: c.band, load: c.load, capacity: c.capacity,
      seats: c.seats, boardings: c.boardings, day_type: c.dayType, peak_time: c.time, timeband: c.timeband,
      direction: c.direction, stopcode: c.stopcode, stopname: c.stopname, stop_sequence: c.stopSeq,
      max_load: c.maxLoad, max_capacity: c.maxCapacity,
      weekday_vc: byDayVC(c, "Weekday"), saturday_vc: byDayVC(c, "Saturday"), sunday_vc: byDayVC(c, "Sunday"),
    };
  });
  const f = { route: "route_id", band: "band", year: "busto_year", day_type: "day_type" };
  for (const [param, col] of Object.entries(f)) { const v = q.get(param); if (v != null && v !== "") rows = rows.filter((x) => String(x[col]) === v); }
  const om = /^([a-z_]+)\.(asc|desc)$/.exec(order || "");
  const ocol = om ? om[1] : "peak_vc", desc = om ? om[2] === "desc" : true;
  rows.sort((a, b) => {
    const av = a[ocol], bv = b[ocol];
    const c = (typeof av === "number" && typeof bv === "number") ? (av - bv) : String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv));
    return desc ? -c : c;
  });
  rows = rows.slice(0, limit);
  return json({ dataset: "crowding", table: "bus_crowding", source: "snapshot (data/crowding.json — warehouse migration pending)", count: rows.length, limit, rows });
}

const SNAPSHOTS = { accidents: accidentsSnapshot, crowding: crowdingSnapshot };

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
  const snapshot = SNAPSHOTS[name];   // datasets whose set also lives in a static /api/v1 snapshot
  const canSnapshot = !!snapshot;

  const base = env.WAREHOUSE_URL, key = env.WAREHOUSE_ANON_KEY;
  if (!base || !key) {
    if (canSnapshot) { const fb = await snapshot(origin, q, limit, order); if (fb) return fb; }
    return json({ error: "historical store not configured (WAREHOUSE_URL / WAREHOUSE_ANON_KEY not set)" }, { status: 503 });
  }

  // Build a strict PostgREST query from whitelisted params only.
  const parts = [];
  for (const [param, [col, op]] of Object.entries(ep.filters)) {
    const v = q.get(param);
    if (v != null && v !== "") parts.push(`${col}=${op}.${encodeURIComponent(v)}`);
  }
  parts.push(`order=${order}`, `limit=${limit}`);

  // Use only the origin of WAREHOUSE_URL, so a pasted trailing path/slash (e.g. ".../rest/v1")
  // can't produce a malformed "/rest/v1/rest/v1/..." path (PostgREST PGRST125).
  let warehouseOrigin;
  try { warehouseOrigin = new URL(base).origin; } catch { return json({ error: "WAREHOUSE_URL is not a valid URL" }, { status: 503 }); }
  const url = `${warehouseOrigin}/rest/v1/${ep.table}?select=*&${parts.join("&")}`;
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
      if (canSnapshot) { const fb = await snapshot(origin, q, limit, order); if (fb) return fb; }
      return json({ error: `historical query failed (${r.status})`, detail: body.slice(0, 300) }, { status: (r.status >= 400 && r.status < 500) ? r.status : 502 });
    }
    let rows; try { rows = JSON.parse(body); } catch { return json({ error: "historical store returned non-JSON", detail: body.slice(0, 200) }, { status: 502 }); }
    return json({ dataset: name, table: ep.table, count: Array.isArray(rows) ? rows.length : 0, limit, rows });
  } catch (e) {
    return json({ error: "historical store error", detail: String(e && e.message || e) }, { status: 502 });
  }
}
