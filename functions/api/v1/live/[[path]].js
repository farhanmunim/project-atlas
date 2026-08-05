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

// BODS SIRI-VM live bus GPS (keyed). The same whole-London snapshot the
// /api/live/vehicles Function serves — we reuse its exact edge-cache key so the
// two endpoints share ONE upstream poll per 10s (no extra BODS load).
const SIRI_VM = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";
const BODS_BBOX = "-0.55,51.25,0.30,51.71";
const LIVE_TTL_S = 10;
const SNAPSHOT_KEY = "https://atlas.internal/live/london-snapshot";
const sTag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };
function parseSiriVm(xml) {
  if (!xml) return [];
  const out = [];
  for (const b of xml.match(/<VehicleActivity>[\s\S]*?<\/VehicleActivity>/g) || []) {
    const j = (b.match(/<MonitoredVehicleJourney>([\s\S]*?)<\/MonitoredVehicleJourney>/) || [])[1] || b;
    const lat = parseFloat(sTag(j, "Latitude")), lng = parseFloat(sTag(j, "Longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const bearing = parseFloat(sTag(j, "Bearing"));
    out.push({ reg: sTag(j, "VehicleRef"), line: sTag(j, "LineRef"), publishedLine: sTag(j, "PublishedLineName"),
      direction: sTag(j, "DirectionRef"), lat, lng, bearing: Number.isFinite(bearing) ? bearing : null,
      destination: sTag(j, "DestinationName"), origin: sTag(j, "OriginName"), operatorRef: sTag(j, "OperatorRef"),
      recordedAt: sTag(b, "RecordedAtTime") });
  }
  return out;
}
async function getVehicleSnapshot(key, cache) {
  const hit = await cache.match(SNAPSHOT_KEY);
  if (hit) return { rec: await hit.json(), cached: true };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${SIRI_VM}?${new URLSearchParams({ api_key: key, boundingBox: BODS_BBOX })}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error("BODS HTTP " + res.status);
    const rec = { at: Date.now(), vehicles: parseSiriVm(await res.text()) };
    await cache.put(SNAPSHOT_KEY, new Response(JSON.stringify(rec), { headers: { "Cache-Control": `max-age=${LIVE_TTL_S}` } }));
    return { rec, cached: false };
  } finally { clearTimeout(t); }
}

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
  "national-highways": {
    ttl: 86400,
    retired: true,
    desc: "RETIRED — National Highways withdrew the keyless RSS feed this endpoint proxied (every legacy URL now 404s; the replacement API requires a registered key). Returns 410 Gone. Use /api/v1/live/road-disruptions for London road incidents.",
  },
  "vehicles": {
    ttl: 10,
    custom: true,
    desc: "Live bus GPS positions (BODS SIRI-VM) across Greater London. ?line=25 or ?route=25 filters to a route (publishedLine); omit for the whole network. All callers share one 10s-cached upstream snapshot.",
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
      endpoints: Object.entries(ENDPOINTS).map(([k, v]) => ({ name: k, path: `/api/v1/live/${k}`, url: `${origin}/api/v1/live/${k}`, description: v.desc, ...(v.retired ? { retired: true } : {}) })),
    }, { ttl: 300 });
  }

  const ep = ENDPOINTS[name];
  if (!ep) return json({ error: `unknown live feed: ${name}`, available: Object.keys(ENDPOINTS) }, { status: 404 });

  if (ep.retired) return json({
    error: `live feed retired: ${name}`,
    note: "National Highways withdrew the keyless RSS this endpoint proxied; its replacement API requires a registered key.",
    alternative: "/api/v1/live/road-disruptions",
  }, { status: 410, ttl: ep.ttl });

  // Live bus GPS (BODS SIRI-VM) — shares the /api/live/vehicles cached snapshot.
  if (ep.custom && name === "vehicles") {
    const key = env.BODS_API_KEY;
    if (!key) return json({ feed: name, live: false, count: 0, data: [], note: "no BODS key — live positions unavailable" }, { ttl: ep.ttl });
    const sp2 = new URL(request.url).searchParams;
    const lines = new Set((sp2.get("line") || sp2.get("route") || "").split(",").map((s) => s.trim()).filter(Boolean));
    const cache = caches.default;
    const filt = (v) => !lines.size || lines.has(String(v.publishedLine));
    try {
      const { rec, cached } = await getVehicleSnapshot(key, cache);
      const data = rec.vehicles.filter(filt);
      return json({ feed: name, live: true, cached, capturedAt: new Date(rec.at).toISOString(), count: data.length, data }, { ttl: ep.ttl });
    } catch (e) {
      const stale = await cache.match(SNAPSHOT_KEY);
      if (stale) { const rec = await stale.json(); const data = rec.vehicles.filter(filt);
        return json({ feed: name, live: true, cached: true, capturedAt: new Date(rec.at).toISOString(), count: data.length, data }, { ttl: ep.ttl }); }
      return json({ error: "live vehicles unavailable" }, { status: 502, ttl: ep.ttl });
    }
  }

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
