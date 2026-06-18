/**
 * functions/api/live/vehicles.js — Cloudflare Pages Function.
 *
 * Production stand-in for the local `pipeline/serve.js` `/api/live/vehicles`
 * route. Cloudflare Pages is static hosting, so the Node dev server does not run
 * there; this Function reproduces the SAME contract on the SAME URL, so the
 * browser seam (index.html → dataSource.fetchLivePositions) is unchanged.
 *
 *   GET /api/live/vehicles?line=25        → { live, cached, capturedAt, vehicles }
 *   GET /api/live/vehicles?line=25,86     → filter by multiple PublishedLineName
 *
 * Key handling: BODS_API_KEY is a Cloudflare project SECRET (context.env), never
 * shipped to the browser — same guarantee as the server-side .env locally.
 *
 * Rate limit: BODS refreshes ~every 10s and asks callers not to poll faster. We
 * pull the whole London snapshot ONCE and cache it for 10s via the Cloudflare
 * Cache API, then filter that single snapshot per request — so any number of
 * clients map to ≤1 upstream poll per 10s (mirrors serve.js's liveCache).
 *
 * This is intentionally a self-contained copy of the parse/fetch logic from
 * pipeline/sources/bods.js (that module reads process.env and isn't importable
 * in the Workers runtime). If the SIRI-VM parsing changes, change both.
 */

const SIRI_VM = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";
const LONDON_BBOX = "-0.55,51.25,0.30,51.71";
const LIVE_TTL_S = 10;
// Stable internal cache key (not a real public URL — just the Cache API map key).
const SNAPSHOT_KEY = "https://atlas.internal/live/london-snapshot";

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
};

/** Parse SIRI-VM XML → normalised vehicle activities (mirrors bods.parseSiriVm). */
function parseSiriVm(xml) {
  if (!xml) return [];
  const out = [];
  const blocks = xml.match(/<VehicleActivity>[\s\S]*?<\/VehicleActivity>/g) || [];
  for (const b of blocks) {
    const j = (b.match(/<MonitoredVehicleJourney>([\s\S]*?)<\/MonitoredVehicleJourney>/) || [])[1] || b;
    const lat = parseFloat(tag(j, "Latitude")), lng = parseFloat(tag(j, "Longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const bearing = parseFloat(tag(j, "Bearing"));
    out.push({
      reg: tag(j, "VehicleRef"),
      line: tag(j, "LineRef"),
      publishedLine: tag(j, "PublishedLineName"),
      direction: tag(j, "DirectionRef"),
      lat, lng,
      bearing: Number.isFinite(bearing) ? bearing : null,
      destination: tag(j, "DestinationName"),
      origin: tag(j, "OriginName"),
      journeyRef: tag(j, "VehicleJourneyRef"),
      blockRef: tag(j, "BlockRef"),
      operatorRef: tag(j, "OperatorRef"),
      recordedAt: tag(b, "RecordedAtTime"),
    });
  }
  return out;
}

const json = (code, obj) =>
  new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });

/** Pull the whole-London SIRI-VM snapshot, cached 10s in the CF edge cache. */
async function getSnapshot(key, cache) {
  const cached = await cache.match(SNAPSHOT_KEY);
  if (cached) {
    const rec = await cached.json();
    return { rec, cached: true };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const qs = new URLSearchParams({ api_key: key, boundingBox: LONDON_BBOX });
    const res = await fetch(`${SIRI_VM}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error("BODS HTTP " + res.status);
    const rec = { at: Date.now(), vehicles: parseSiriVm(await res.text()) };
    // Store for LIVE_TTL_S so subsequent requests reuse this one upstream poll.
    await cache.put(
      SNAPSHOT_KEY,
      new Response(JSON.stringify(rec), { headers: { "Cache-Control": `max-age=${LIVE_TTL_S}` } })
    );
    return { rec, cached: false };
  } finally {
    clearTimeout(t);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const key = env.BODS_API_KEY;
  if (!key) return json(200, { live: false, vehicles: [], note: "no BODS key — live positions unavailable" });

  const lines = new Set(
    (new URL(request.url).searchParams.get("line") || "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const cache = caches.default;
  try {
    const { rec, cached } = await getSnapshot(key, cache);
    const vehicles = lines.size ? rec.vehicles.filter((v) => lines.has(String(v.publishedLine))) : rec.vehicles;
    return json(200, { live: true, cached, capturedAt: rec.at, vehicles });
  } catch (e) {
    // Last-good: if a stale snapshot is still in cache, serve it rather than blanking.
    const stale = await cache.match(SNAPSHOT_KEY);
    if (stale) {
      const rec = await stale.json();
      const vehicles = lines.size ? rec.vehicles.filter((v) => lines.has(String(v.publishedLine))) : rec.vehicles;
      return json(200, { live: true, cached: true, capturedAt: rec.at, vehicles });
    }
    return json(502, { live: false, vehicles: [], error: String(e.message || e) });
  }
}
