/**
 * sources/bods.js — Bus Open Data Service (BODS) SIRI-VM live vehicle positions.
 *
 * The authoritative LIVE GPS feed for London buses (TfL's Unified API has none —
 * its predictions give next-stop + bearing only). Powers Relay's live tracking and
 * is the basis for vehicle→journey/block assignment + intraday fleet moves.
 *
 * Auth: free BODS API key (`BODS_API_KEY`), passed as ?api_key=. SERVER-SIDE ONLY —
 * the browser never sees it; Relay calls our /api/live/vehicles, which proxies here.
 *
 * RATE LIMITS: the feed refreshes every ~10s; BODS asks you not to poll faster. We
 * enforce that in serve.js with a 10s server-side cache, so any number of clients
 * map to ≤1 upstream poll per 10s. We also always filter (boundingBox + lineRef) so
 * each pull is small (a single route ≈ a few KB) rather than the whole-GB firehose.
 *
 * Endpoint: GET https://data.bus-data.dft.gov.uk/api/v1/datafeed/  (SIRI-VM XML)
 *   params: api_key, boundingBox=minLng,minLat,maxLng,maxLat, lineRef, operatorRef
 */

const SIRI_VM = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";
// Greater London bounding box (minLng,minLat,maxLng,maxLat) — keeps pulls small.
export const LONDON_BBOX = "-0.55,51.25,0.30,51.71";

export function hasKey() { return !!process.env.BODS_API_KEY; }

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };

/** Parse SIRI-VM XML → normalised vehicle activities. Lightweight (flat tags), no deps. */
export function parseSiriVm(xml) {
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
      direction: tag(j, "DirectionRef"),               // "1"=outbound, "2"=inbound (operator-defined)
      lat, lng,
      bearing: Number.isFinite(bearing) ? bearing : null,
      destination: tag(j, "DestinationName"),
      origin: tag(j, "OriginName"),
      journeyRef: tag(j, "VehicleJourneyRef"),          // the run/journey
      blockRef: tag(j, "BlockRef"),                     // the block (vehicle's day of work), when present
      operatorRef: tag(j, "OperatorRef"),
      recordedAt: tag(b, "RecordedAtTime"),
    });
  }
  return out;
}

/** Fetch live vehicle activity (filtered). Returns [] without a key or on failure. */
export async function fetchVehicleActivity({ boundingBox = LONDON_BBOX, lineRef, operatorRef } = {}) {
  const key = process.env.BODS_API_KEY;
  if (!key) return [];
  const qs = new URLSearchParams({ api_key: key, boundingBox });
  if (lineRef) qs.set("lineRef", lineRef);
  if (operatorRef) qs.set("operatorRef", operatorRef);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${SIRI_VM}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) return [];
    return parseSiriVm(await res.text());
  } catch { return []; }
  finally { clearTimeout(t); }
}
