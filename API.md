# Atlas API — `https://atlas.farhan.app/api/v1`

The **Atlas — London Bus Network API** is an open, read-only, versioned API over
everything the [Atlas](https://atlas.farhan.app) app itself runs on: routes, stops,
geometry, garages, fleet, tenders, reliability, crowding, collisions, low bridges and
live feeds. The site consumes this exact API — you get the same data it does.

- **Base URL:** `https://atlas.farhan.app/api/v1`
- **Auth:** none — no key, no registration.
- **CORS:** open (`Access-Control-Allow-Origin: *`) — call it straight from a browser.
- **Methods:** `GET` / `HEAD` only (`OPTIONS` handled for preflight). Anything else → `405`.
- **Format:** JSON (`routes-overview` is GeoJSON, `application/geo+json`).
- **Discovery:** `GET /api/v1` lists every endpoint with a description — the API is
  self-describing, and this document mirrors it.

The API has **three groups**, all listed in the discovery index:

| Group | Base | What it is |
|---|---|---|
| **current** | `/api/v1/<dataset>` | Today's snapshot of the warehouse (refreshed by the data pipeline, most datasets daily/weekly) |
| **live** | `/api/v1/live/<feed>` | Live bus + road feeds proxied from TfL / National Highways / BODS, edge-cached seconds-to-minutes |
| **history** | `/api/v1/history/<series>` | Time-series from our self-hosted warehouse (daily reliability, quarterly performance, sightings…) |

---

## Conventions

- **Caching.** Current-group responses are edge-cached ~5 min (`Cache-Control` is set
  honestly — respect it; the data behind most endpoints changes at most daily). Live
  feeds are cached 10 s – 2 min depending on the feed's real cadence. Don't poll
  faster than the cache TTL; you'll just get the same cached body.
- **Errors.** Unknown dataset → `404` with `{ "error": "...", "available": [...] }`.
  Upstream failure → `502` with `{ "error": "..." }`. History group without warehouse
  credentials configured → `503` (live + current keep working).
- **Stability.** Endpoint names and field names are stable within `v1`. Additive
  changes (new fields, new endpoints) can happen at any time; breaking changes will
  only ever come with a version bump (`/api/v2`).
- **Freshness.** `GET /api/v1/manifest` returns per-dataset `fetchedAt` timestamps and
  row counts — check it to see how fresh each dataset is.

---

## Current snapshot — `/api/v1/<dataset>`

| Endpoint | What it returns |
|---|---|
| `GET /api/v1` | Discovery index — service info + every endpoint |
| `GET /api/v1/routes` | All London bus routes — `[{ id, name, type }]` (`type`: `regular` \| `night` \| `twentyfour` \| `school`) |
| `GET /api/v1/route-meta` | Per-route metadata keyed by route name — operator, company, propulsion, garage (+ name), PVR, vehicle spec, route length, contract date |
| `GET /api/v1/route-classifications` | Route type classification keyed by route name |
| `GET /api/v1/route-stops` | Ordered stop sequences per route and direction — `{ routes: { "25": { outbound: [{ id, name, lat, lng, lines }], inbound: […] } } }` |
| `GET /api/v1/routes-overview` | Route line geometry — GeoJSON `FeatureCollection`; feature properties: `routeId`, `name`, `direction` (`"1"` outbound, `"2"` inbound), `routeType`, `lengthKm`, `stops` |
| `GET /api/v1/line-status` | Latest line-status snapshot — per-route service status + a network summary (`capturedAt`) |
| `GET /api/v1/garages` | Bus garages — `{ garages: [{ code, name, operator, company, postcode, lat, lng, pvr, capacity, utilisation, routes }] }` |
| `GET /api/v1/fleet` | Fleet profile per route — `{ byRoute: { "25": { regs, count, avgAgeYears, propulsion, makes } } }` (DVLA-enriched) |
| `GET /api/v1/vehicles` | Vehicle register keyed by registration — routes, operator, make, year, fuel |
| `GET /api/v1/tenders` | Tender / contract award history per route — `{ byRoute: { "25": [awards…] } }`; each award carries bids (low/won/high), `costPerMile`, `awardDate`, notes, plus derived `jb` (joint-bid partners + total £), `vehicle` (awarded deck/propulsion/basis) and `tranche` |
| `GET /api/v1/route-performance` | Reliability per route (TfL QSI) — EWT/OTP vs the contractual MPS benchmark, % mileage operated, service class |
| `GET /api/v1/accidents` | STATS19 bus/coach-involved collisions — lat/lng, severity, date, borough (ONS GSS code), vehicles, casualties, plus decoded context: `roadType`, `speedLimit`, `junction`, `light`, `weather`, `roadSurface`, `day`, `timeBand` |
| `GET /api/v1/bridges` | Low bridges / height restrictions — lat/lng, clearance (`height_m` + imperial band), name, road, borough |
| `GET /api/v1/crowding` | Bus crowding per route (TfL BUSTO) — peak `V/C` (load ÷ capacity at the max-demand hour), `band` (comfortable → crowded), busiest stop/time/day + per-day-type peaks |
| `GET /api/v1/crowding-profile` | Per-route crowding detail — `loadProfile` (V/C by stop in sequence along the busiest direction) + `timeOfDay` (V/C per timeband per day type) |
| `GET /api/v1/localities` | London locality labels for maps — `{ localities: [{ name, lat, lng, kind: "town" \| "suburb" }] }` (source: OpenStreetMap, ODbL) |
| `GET /api/v1/manifest` | Pipeline run manifest — per-dataset `fetchedAt` + row counts |

### Response shape examples

```jsonc
// GET /api/v1/route-meta   (one route shown)
{ "routes": { "25": {
    "type": "twentyfour", "operator": "Stagecoach London",
    "propulsion": "hybrid", "garage": "BW", "garageName": "Bow",
    "pvr": 31, "fleet": "E40H 10.2m/Enviro400H MMC 2D",
    "lengthKm": 18, "contractDate": "24/05/25" } } }

// GET /api/v1/accidents    (one collision shown)
{ "accidents": [{
    "id": "2024480551958", "lat": 51.51779, "lng": -0.10761,
    "severity": "slight", "date": "2024-12-31", "borough": "E09000001",
    "vehicles": 2, "casualties": 1, "roadType": "Dual carriageway",
    "speedLimit": "20 mph", "light": "Dark — lit", "weather": "Fine",
    "roadSurface": "Dry", "day": "Tue", "timeBand": "PM peak" }] }

// GET /api/v1/crowding     (one route shown)
{ "year": "2025-2026", "routes": { "25": {
    "peakVC": 0.6753, "band": "busy", "load": 439.6, "capacity": 651.1,
    "dayType": "Weekday", "time": "15:45:00", "stopname": "LITCHFIELD AVENUE",
    "byDay": { "Weekday": { "vc": 0.6753 }, "Saturday": { "vc": 0.4937 } } } } }
```

---

## Live feeds — `/api/v1/live/<feed>`

TfL / National Highways / BODS feeds proxied through our API — CORS-open, keyless,
edge-cached so a flood of callers collapses to a trickle of upstream pulls. Every
response wraps the payload as `{ feed, capturedAt, data }`.

| Endpoint | Cache | What it returns |
|---|---|---|
| `GET /api/v1/live` | 5 min | Index of live feeds |
| `GET /api/v1/live/status?route=25` | 30 s | Live bus line status + disruption reason (`?route=25` or `?route=25,86`; omit for the whole network) |
| `GET /api/v1/live/disruptions` | 60 s | Active bus line disruptions (description + affected stops) |
| `GET /api/v1/live/arrivals?stop=<naptanId>` *(or `?route=<id>`)* | 30 s | Live arrival predictions — one of `stop`/`route` is required |
| `GET /api/v1/live/road-disruptions` | 60 s | Live London road incidents / closures from TfL's traffic control centre |
| `GET /api/v1/live/national-highways` | 2 min | National Highways unplanned events on the strategic road network, filtered to Greater London |
| `GET /api/v1/live/vehicles` *(or `?line=25` / `?line=25,86`)* | 10 s | Live bus GPS (BODS SIRI-VM) across Greater London — `{ reg, line, publishedLine, direction, lat, lng, bearing, destination, origin, operatorRef, recordedAt }` per vehicle. All callers share one 10 s-cached upstream snapshot |

Live bus GPS is also available at the legacy path `GET /api/live/vehicles?line=<route>`
(same data, same cache — kept for compatibility).

---

## Historical / time-series — `/api/v1/history/<series>`

Time-series accrued in our self-hosted warehouse (Postgres + PostgREST) by the
decoupled ingest pipeline. Read-only, CORS-open, strict per-endpoint whitelists (table + filters + capped page
size). Common query params: `route`, `from`, `to`, `reg`, `year`,
`limit` (default 200, max 1000), `order` (e.g. `day.desc`). Responses:
`{ dataset, count, rows }`.

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/history` | Index of historical datasets |
| `GET /api/v1/history/reliability-daily?route=25` | Our own daily reliability estimate per route — AWT/SWT/EWT (high-frequency), OTD (low-frequency), scheduled vs operated km, `sample_count`. **Experimental**: live-sampled, currently biased high; not comparable to TfL's published QSI |
| `GET /api/v1/history/performance-history?route=25` | TfL's published quarterly performance across all captured periods |
| `GET /api/v1/history/schedule?route=25` | Scheduled service per route over time — service class, SWT, trips/km, headway |
| `GET /api/v1/history/tender-programme?route=25&year=2026-2027` | TfL's forward LBSL tendering programme — issue/return/award/start dates, vehicle type |
| `GET /api/v1/history/vehicle-sightings?route=25` *(or `?reg=LX58CWU`)* | Vehicle-on-route observations over time (reg ↔ route ↔ timestamp) |
| `GET /api/v1/history/crowding?route=25` | Bus crowding per route per year (TfL BUSTO) — filters: `route`, `band`, `year`, `day_type` |
| `GET /api/v1/history/accidents?from=2024-01-01&to=2024-12-31` | STATS19 collisions over time — filters: `from`/`to`, `severity`, `borough`, `road_type`, `speed_limit`, `day`, `time_band` |

Notes:

- The history group needs server-side warehouse credentials; when unconfigured it
  returns `503` while live + current keep working.
- **`history/accidents` self-heals:** the full enriched multi-year STATS19 set also
  ships as the static snapshot, so this endpoint falls back to filtering
  `/api/v1/accidents` in-process when the warehouse can't serve it — the documented
  filters keep working either way (such responses carry a `source` field).

---

## Examples

```bash
curl https://atlas.farhan.app/api/v1                          # discover everything
curl https://atlas.farhan.app/api/v1/route-meta               # operator/PVR/garage per route
curl https://atlas.farhan.app/api/v1/live/status?route=25     # live status for route 25
curl "https://atlas.farhan.app/api/v1/history/reliability-daily?route=25&limit=30"
```

```js
// browser / node — no key, CORS-open
const meta = await (await fetch("https://atlas.farhan.app/api/v1/route-meta")).json();
console.log(meta.routes["25"].operator);   // "Stagecoach London"
```

---

## Data sources & attribution

Atlas data is derived from open sources. If you build on this API, please respect the
upstream licences and attribute accordingly:

- **TfL Unified API** — routes, geometry, stops, status, arrivals, road disruptions
  (TfL open data terms; “Powered by TfL Open Data”).
- **DfT Bus Open Data Service (BODS)** — live vehicle GPS (SIRI-VM), OGL.
- **DfT STATS19** — road collision records, OGL.
- **TfL BUSTO** — crowding (max demand hour by route by timeband).
- **London Datastore (EPOWR)** — bridge height restrictions, OGL.
- **DVLA VES** — vehicle enrichment (make, year, fuel).
- **londonbusroutes.net** — garage allocations, PVR, vehicle types (community source).
- **OpenStreetMap** — locality names (`/localities`), © OSM contributors, **ODbL**.

The API itself is free to use for any purpose; it is provided as-is with no uptime
guarantee. Be polite: honour the cache headers and don't hammer the live feeds.
