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
// National Highways unplanned-events RSS (open, keyless) — major-road incidents.
const NH_FEED = "https://m.highwaysengland.co.uk/feeds/rss/UnplannedEvents.xml";
const LONDON_BBOX = [-0.55, 51.25, 0.30, 51.71]; // [minLng, minLat, maxLng, maxLat]

// Lightweight RSS parse (no DOM in Workers) → London-scoped incident records.
function parseNationalHighways(xml) {
  const decode = (s) => String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]) : null; };
  const out = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const it of items) {
    const lat = parseFloat(tag(it, "latitude")), lng = parseFloat(tag(it, "longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lng < LONDON_BBOX[0] || lng > LONDON_BBOX[2] || lat < LONDON_BBOX[1] || lat > LONDON_BBOX[3]) continue; // London only
    const cats = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => decode(m[1]));
    out.push({
      id: tag(it, "reference") || tag(it, "guid"),
      lat, lng,
      category: cats[0] || "Incident",
      severity: cats[1] || "",
      road: tag(it, "road") || "", region: tag(it, "region") || "", county: tag(it, "county") || "",
      title: tag(it, "title") || "", location: tag(it, "title") || "",
      comments: tag(it, "description") || "",
      since: tag(it, "pubDate") || null,
    });
  }
  return out;
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
    ttl: 120,
    custom: true,
    desc: "Live National Highways unplanned events (incidents / congestion / closures) on the strategic road network, filtered to Greater London. Source: National Highways open RSS, keyless.",
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

  // National Highways: fetch + parse the open RSS (not a TfL passthrough).
  if (ep.custom && name === "national-highways") {
    let r;
    // NB: this upstream 500s if sent an Accept header — send only a User-Agent.
    try { r = await fetch(NH_FEED, { headers: { "User-Agent": "Atlas/1.0" }, cf: { cacheTtl: ep.ttl, cacheEverything: true } }); }
    catch (e) { return json({ error: "national highways feed unreachable" }, { status: 502, ttl: ep.ttl }); }
    if (!r.ok) return json({ error: `national highways feed failed (${r.status})` }, { status: 502, ttl: ep.ttl });
    const data = parseNationalHighways(await r.text());
    return json({ feed: name, capturedAt: new Date().toISOString(), data }, { ttl: ep.ttl });
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
