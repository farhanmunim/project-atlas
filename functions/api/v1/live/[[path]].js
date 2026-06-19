/**
 * /api/v1/live/* — Atlas live API (TfL Unified API proxy, edge-cached).
 *
 * The app reads these live feeds browser→TfL directly; this re-exposes them under our
 * own versioned, CORS-open API so external callers get the same live view. TfL is
 * keyless/CORS-open, so no caller key is needed; if TFL_APP_KEY is set as a Cloudflare
 * secret we attach it to raise our rate limit. Edge-cached briefly so a flood of
 * callers collapses to a trickle of upstream pulls (protects our TfL budget).
 *
 * Live bus GPS (BODS SIRI-VM) stays at its own endpoint /api/live/vehicles (keyed).
 */

const TFL = "https://api.tfl.gov.uk";

// endpoint → { url(params) → TfL path, ttl seconds, desc }
const ENDPOINTS = {
  "status": {
    ttl: 30,
    url: (p) => { const routes = (p.get("route") || "").trim(); return routes ? `/Line/${encodeURIComponent(routes)}/Status` : `/Line/Mode/bus/Status`; },
    desc: "Live bus line status (service status + disruption reason). ?route=25 or ?route=25,86 for specific lines, else the whole network.",
  },
  "disruptions": {
    ttl: 60,
    url: () => `/Line/Mode/bus/Disruption`,
    desc: "Active bus line disruptions across the network (description + affected stops).",
  },
  "arrivals": {
    ttl: 30,
    url: (p) => { const route = (p.get("route") || "").trim(), stop = (p.get("stop") || "").trim();
      if (stop) return `/StopPoint/${encodeURIComponent(stop)}/Arrivals`;
      if (route) return `/Line/${encodeURIComponent(route)}/Arrivals`;
      return null; },
    desc: "Live arrival predictions. ?stop=<naptanId> for a stop, or ?route=<id> for a whole line. One of stop/route is required.",
  },
  "road-disruptions": {
    ttl: 60,
    url: () => `/Road/all/Disruption`,
    desc: "Live London road incidents / closures from TfL's traffic control centre (updated ~5 min) — congestion + collisions affecting the road network.",
  },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" };
const json = (obj, { status = 200, ttl = 30 } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}`, ...CORS } });

export async function onRequest(context) {
  const { request, params, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed — GET only" }, { status: 405 });

  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const name = (segs[0] || "").toLowerCase();
  const origin = new URL(request.url).origin;

  if (!name) {
    return json({
      group: "live", version: "v1",
      description: "Live bus + road feeds proxied from the TfL Unified API, edge-cached. Read-only, CORS-open.",
      livePositions: { path: "/api/live/vehicles?line=<route>", note: "Real-time bus GPS (BODS SIRI-VM) — separate keyed endpoint." },
      endpoints: Object.entries(ENDPOINTS).map(([k, v]) => ({ name: k, path: `/api/v1/live/${k}`, url: `${origin}/api/v1/live/${k}`, description: v.desc })),
    }, { ttl: 300 });
  }

  const ep = ENDPOINTS[name];
  if (!ep) return json({ error: `unknown live feed: ${name}`, available: Object.keys(ENDPOINTS) }, { status: 404 });

  const sp = new URL(request.url).searchParams;
  const tflPath = ep.url(sp);
  if (!tflPath) return json({ error: "missing required param (stop or route)" }, { status: 400 });

  let url = `${TFL}${tflPath}`;
  if (env.TFL_APP_KEY) url += (url.includes("?") ? "&" : "?") + `app_key=${env.TFL_APP_KEY}`;

  let r;
  try { r = await fetch(url, { headers: { Accept: "application/json" }, cf: { cacheTtl: ep.ttl, cacheEverything: true } }); }
  catch (e) { return json({ error: "live feed unreachable" }, { status: 502, ttl: ep.ttl }); }
  if (!r.ok) return json({ error: `live feed failed (${r.status})` }, { status: 502, ttl: ep.ttl });

  const data = await r.json();
  return json({ feed: name, capturedAt: new Date().toISOString(), data }, { ttl: ep.ttl });
}
