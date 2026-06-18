/**
 * api.js – Data access layer
 *
 * Loads static GeoJSON/JSON files from the /data directory.
 * Stops come from the pre-baked weekly refresh (data/stops.json +
 * data/route_stops.json), not a live TfL call.
 * All responses are cached in memory for the session.
 */

const BASE    = './data';

// In-memory cache
const _cache = new Map();

async function loadJson(path) {
  if (_cache.has(path)) return _cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  const data = await res.json();
  _cache.set(path, data);
  return data;
}

/**
 * Returns the GeoJSON FeatureCollection for a route.
 * Features have properties: { routeId, direction ('1'|'2'), sourceDate }
 * Geometry is LineString or MultiLineString.
 *
 * @param {string} routeId  e.g. '25', 'N25', 'X26'
 * @returns {Promise<object>} GeoJSON FeatureCollection
 */
export async function fetchRouteGeoJson(routeId) {
  return loadJson(`${BASE}/routes/${routeId.toUpperCase()}.geojson`);
}

/**
 * Returns the flat list of all known route IDs from the index.
 * @returns {Promise<string[]>}
 */
export async function fetchRouteIndex() {
  const index = await loadJson(`${BASE}/routes/index.json`);
  return index.routes ?? [];
}

/**
 * Returns the full route_destinations map (all routes at once).
 * Keys are normalised to uppercase.
 * @returns {Promise<object>} { routeId: { inbound, outbound, service_types } }
 */
export async function fetchAllDestinations() {
  const data = await loadJson(`${BASE}/route_destinations.json`);
  // Normalise all keys to uppercase so lookups always succeed regardless of
  // how the build script stored them (TfL API returns lowercase IDs).
  const raw = data.routes ?? {};
  const normalised = {};
  for (const [k, v] of Object.entries(raw)) normalised[k.toUpperCase()] = v;
  return normalised;
}

/**
 * Returns the route classifications map.
 * @returns {Promise<object>}
 */
export async function fetchRouteClassifications() {
  const data = await loadJson(`${BASE}/route_classifications.json`);
  return data.routes ?? {};
}

/**
 * Returns classification info for a single route.
 * @param {string} routeId
 * @returns {Promise<object|null>}
 */
export async function fetchRouteClassification(routeId) {
  const data = await loadJson(`${BASE}/route_classifications.json`);
  return data.routes?.[routeId.toUpperCase()] ?? null;
}

/**
 * Returns destination info for a route.
 * Case-insensitive: handles both uppercase and lowercase keys in the data file.
 * @param {string} routeId
 * @returns {Promise<{inbound, outbound, service_types}|null>}
 */
export async function fetchRouteDestinations(routeId) {
  const data = await loadJson(`${BASE}/route_destinations.json`);
  const id   = routeId.toUpperCase();
  // Try uppercase first (new format), fall back to lowercase (legacy data)
  return data.routes?.[id] ?? data.routes?.[id.toLowerCase()] ?? null;
}

/**
 * Returns located garages: [{ code, name, operator, address, lat, lon }, …]
 * Garages without a successful geocode are omitted.
 */
export async function fetchGarageLocations() {
  try {
    const data = await loadJson(`${BASE}/garage-locations.json`);
    return Object.values(data.garages ?? {}).filter(g => g.lat != null && g.lon != null);
  } catch (err) {
    console.warn('garage-locations.json not available:', err.message);
    return [];
  }
}

/**
 * Returns the canonical stops registry: stopId → { name, indicator, lat, lon, routes[] }.
 * Lazy-loaded on first call, then cached for the session.
 * @returns {Promise<Record<string, { name: string, indicator: string|null, lat: number, lon: number, routes: string[] }>>}
 */
export async function fetchStopsRegistry() {
  const payload = await loadJson(`${BASE}/stops.json`);
  return payload?.stops ?? {};
}

/**
 * Returns just the stop count for a route — cheap O(1) lookup once the
 * route_stops bundle is cached, so route cards can display "N stops"
 * without materialising the full stops GeoJSON array.
 * @param {string} routeId
 * @returns {Promise<number>}
 */
export async function fetchRouteStopCount(routeId) {
  const { routeStops } = await loadStopsBundle();
  return (routeStops[routeId.toUpperCase()] ?? []).length;
}

/**
 * Loads the stored stops registry + per-route stop lists once and caches them.
 * @returns {Promise<{ stops: Record<string, object>, routeStops: Record<string, object[]> }>}
 */
async function loadStopsBundle() {
  const [stopsPayload, routeStopsPayload] = await Promise.all([
    loadJson(`${BASE}/stops.json`),
    loadJson(`${BASE}/route_stops.json`),
  ]);
  return {
    stops:      stopsPayload?.stops ?? {},
    routeStops: routeStopsPayload?.routes ?? {},
  };
}

/**
 * Returns the stops for a route as GeoJSON Point features, read from the
 * weekly-refreshed static data files. Preserves the shape returned by the
 * previous live-TfL implementation so downstream callers don't change.
 * @param {string} routeId
 * @returns {Promise<object[]>} Array of GeoJSON-style feature objects
 */
export async function fetchStopsForRoute(routeId) {
  const id       = routeId.toUpperCase();
  const cacheKey = `stops:${id}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const { stops, routeStops } = await loadStopsBundle();
  const entries = routeStops[id] ?? [];

  const features = [];
  for (const entry of entries) {
    const stop = stops[entry.id];
    if (!stop) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
      properties: {
        id:        entry.id,
        name:      stop.name ?? 'Stop',
        indicator: stop.indicator ?? null,
        towards:   entry.towards ?? null,
        routes:    (stop.routes ?? []).map(r => r.toUpperCase()).sort().join(','),
      },
    });
  }

  _cache.set(cacheKey, features);
  return features;
}
