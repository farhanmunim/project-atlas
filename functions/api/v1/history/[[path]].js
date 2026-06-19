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
    table: "route_vehicle_sightings",
    filters: { route: ["route_id", "eq"], reg: ["registration", "eq"], from: ["observed_at", "gte"], to: ["observed_at", "lte"] },
    defaultOrder: "observed_at.desc",
    desc: "Vehicle-on-route sightings over time (reg ↔ route ↔ timestamp) — the basis for intraday/▒historical fleet movement.",
  },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
const json = (obj, { status = 200, cache = "public, max-age=300" } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...CORS } });

const MAX_LIMIT = 1000, DEFAULT_LIMIT = 200;

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

  const base = env.SUPABASE_URL, key = env.SUPABASE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !key) return json({ error: "historical store not configured (SUPABASE_URL / SUPABASE_KEY not set)" }, { status: 503 });

  // Build a strict PostgREST query from whitelisted params only.
  const q = new URL(request.url).searchParams;
  const parts = [];
  for (const [param, [col, op]] of Object.entries(ep.filters)) {
    const v = q.get(param);
    if (v != null && v !== "") parts.push(`${col}=${op}.${encodeURIComponent(v)}`);
  }
  let limit = parseInt(q.get("limit"), 10);
  limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  const order = /^[a-z_]+\.(asc|desc)$/.test(q.get("order") || "") ? q.get("order") : ep.defaultOrder;
  parts.push(`order=${order}`, `limit=${limit}`);

  const url = `${base.replace(/\/$/, "")}/rest/v1/${ep.table}?select=*&${parts.join("&")}`;
  let r;
  try {
    r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cf: { cacheTtl: 120, cacheEverything: true } });
  } catch (e) { return json({ error: "historical store unreachable" }, { status: 502 }); }
  if (!r.ok) return json({ error: `historical query failed (${r.status})` }, { status: 502 });

  const rows = await r.json();
  return json({ dataset: name, table: ep.table, count: Array.isArray(rows) ? rows.length : 0, limit, rows });
}
