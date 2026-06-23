/**
 * /api/v1/* — Atlas public read API (Cloudflare Pages Function).
 *
 * A single, versioned, CORS-open surface over the warehouse data the site itself
 * uses. It re-serves the committed static warehouse files (`/data/*.json` — the prod
 * read layer) with proper JSON content types, open CORS, and edge caching, plus a
 * discovery index at `/api/v1`. No key required; read-only; GET/HEAD only.
 *
 * This mirrors the dev server's `/api/v1/*` routes (pipeline/serve.js) — keep both in
 * sync. Real-time bus GPS is a SEPARATE endpoint (`/api/live/vehicles`), not here,
 * because it is volatile and key-backed.
 */

// dataset name → { committed file, description, optional non-JSON content type }
const DATASETS = {
  "routes":            { file: "routes.json",             desc: "All London bus routes — [{ id, name }]." },
  "route-meta":        { file: "route-meta.json",         desc: "Per-route metadata keyed by route name (operator, propulsion, garage, type, PVR)." },
  "route-classifications": { file: "route-classifications.json", desc: "Route type classification keyed by route name (day, night, 24-hour, school, prefix/lettered)." },
  "route-stops":       { file: "route-stops.json",        desc: "Ordered stop sequences per route and direction." },
  "line-status":       { file: "line-status.json",        desc: "Most recent line-status snapshot — per-route service status + a network summary (capturedAt)." },
  "routes-overview":   { file: "routes-overview.geojson", desc: "Route line geometry as a GeoJSON FeatureCollection.", type: "application/geo+json" },
  "garages":           { file: "garages.json",            desc: "Bus garages — code, name, operator, lat/lng, PVR, routes served." },
  "fleet":             { file: "fleet.json",              desc: "Fleet profile per route — vehicle count, average age, propulsion mix, makes." },
  "vehicles":          { file: "vehicles.json",           desc: "Vehicle register keyed by registration — routes, operator, make, year, fuel." },
  "tenders":           { file: "tenders.json",            desc: "Tender / contract award history per route — bids (low/won/high), operator, dates, contracted miles, plus derived joint-bid (partner routes + total), awarded vehicle (deck/propulsion/basis) and tranche." },
  "route-performance": { file: "route-performance.json",  desc: "Reliability per route — EWT/OTP vs the MPS benchmark, % mileage operated." },
  "accidents":         { file: "accidents.json",          desc: "STATS19 bus collisions — lat/lng, severity, date, borough, vehicles, casualties, plus decoded context: roadType, speedLimit, junction, light, weather, roadSurface, day, timeBand." },
  "bridges":           { file: "bridges.json",            desc: "Low bridges / height restrictions — lat/lng, clearance (m + imperial), name, road." },
  "crowding":          { file: "crowding.json",           desc: "Bus crowding per route (TfL BUSTO) — peak V/C (load÷capacity at the max-demand hour), band (comfortable→crowded), busiest stop/time/day, and the per-day-type peak." },
  "manifest":          { file: "_manifest.json",          desc: "Pipeline run manifest — per-dataset fetchedAt timestamps and row counts." },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const jsonResponse = (obj, { status = 200, cache = "public, max-age=300" } = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...CORS },
  });

export async function onRequest(context) {
  const { request, params } = context;

  if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse({ error: "method not allowed — GET only" }, { status: 405 });

  // `[[path]]` gives the segments after /api/v1 — [] for the index, [name] for a dataset.
  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const name = (segs[0] || "").toLowerCase();
  const origin = new URL(request.url).origin;

  // ── discovery index ──────────────────────────────────────────────────────
  if (!name) {
    return jsonResponse({
      service: "Atlas — London Bus Network API",
      version: "v1",
      description:
        "Open, read-only API for the London bus network: routes, stops, garages, fleet, tenders, reliability, collisions and low bridges. CORS-open, no key required.",
      attribution:
        "Derived from open sources — TfL Unified API, DfT/STATS19, London Datastore (EPOWR), DVLA VES, londonbusroutes.net. Respect the upstream licences when reusing.",
      livePositions: {
        path: "/api/live/vehicles?line=<route>",
        note: "Real-time bus GPS (BODS SIRI-VM) — a separate, volatile endpoint (10s edge cache).",
      },
      groups: {
        current: { path: "/api/v1", note: "Current snapshot of the warehouse (the datasets below)." },
        history: { path: "/api/v1/history", url: `${origin}/api/v1/history`, note: "Time-series from the Supabase warehouse — daily reliability, performance history, schedule, tender programme, vehicle sightings." },
        live: { path: "/api/v1/live", url: `${origin}/api/v1/live`, note: "Live bus + road feeds proxied from TfL — status, arrivals, disruptions, road incidents." },
      },
      endpoints: Object.entries(DATASETS).map(([k, v]) => ({ name: k, path: `/api/v1/${k}`, url: `${origin}/api/v1/${k}`, description: v.desc })),
    });
  }

  // ── a dataset ────────────────────────────────────────────────────────────
  const ds = DATASETS[name];
  if (!ds) return jsonResponse({ error: `unknown dataset: ${name}`, available: Object.keys(DATASETS) }, { status: 404 });

  // re-serve the committed warehouse file from the same origin (the prod read layer)
  let upstream;
  try {
    upstream = await fetch(new URL(`/data/${ds.file}`, request.url), { cf: { cacheTtl: 300, cacheEverything: true } });
  } catch (e) {
    return jsonResponse({ error: `dataset temporarily unavailable: ${name}` }, { status: 502 });
  }
  if (!upstream.ok) return jsonResponse({ error: `dataset unavailable: ${name}` }, { status: 502 });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": `${ds.type || "application/json"}; charset=utf-8`,
      "Cache-Control": "public, max-age=300, s-maxage=600",
      ...CORS,
    },
  });
}
