# Atlas — London Bus Network

An interactive map + analytics deep-dive for the London bus network, served as a single
self-contained `index.html`. Toggleable map layers (route lines · garages · stops · live
buses · collisions · low bridges) and one unified context panel (route info · network
analysis · live operations · fleet · tenders · risk & accidents).

The site is a static Cloudflare Pages app (no build step). All data flows through our own
warehouse pipeline and is served from our own public API.

## Local development

```bash
node pipeline/serve.js        # dev server on http://localhost:8000
```

`serve.js` serves `index.html`, the `/api/v1/*` data API (from the warehouse DB, falling
back to `data/*.json`), and the live-positions route. Use a fixed port per session.

Refresh the data warehouse:

```bash
node pipeline/run.js                 # all datasets (per-dataset TTLs gate the work)
node pipeline/run.js --only=bridges --force
```

## Environment / secrets

Secrets live in `.env` (gitignored) locally and as Cloudflare/CI secrets in production —
never hardcoded, never shipped to the browser. See `.env.example` for the keys:

- `TFL_APP_KEY` — optional, raises the TfL rate limit (pipeline + dev).
- `DVLA_API_KEY` — optional, enables fleet (VES) enrichment in the pipeline.
- `BODS_API_KEY` — Cloudflare **secret**; powers the live-positions Pages Function only.

## Deployment (Cloudflare Pages)

Static site, **no build command**, output directory = repo root (`/`); the `functions/`
directory is auto-detected. The committed `data/*.json` are the production read layer. The
GitHub Action `.github/workflows/refresh-data.yml` refreshes them on a schedule and the
push auto-triggers a Pages rebuild. Live bus GPS is a Pages Function
(`functions/api/live/vehicles.js`) keeping `BODS_API_KEY` server-side.

---

## Public API — `/api/v1`

Atlas serves all of its data through its own **open, read-only, versioned API**. It is
CORS-open (any origin), needs **no key**, and is safe to share and build on. The site
itself consumes this API; you get exactly the same data.

- **Base URL:** `https://atlas.farhan.app/api/v1`
- **Discovery:** `GET /api/v1` returns the service description and every endpoint.
- **Methods:** `GET` / `HEAD` only. `OPTIONS` is handled for CORS preflight.
- **Caching:** responses are edge-cached (~5 min). Reference data changes at most daily.
- **Format:** JSON (`routes-overview` is GeoJSON).

### Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/v1` | Discovery index — service info + all endpoints |
| `GET /api/v1/routes` | All London bus routes — `[{ id, name }]` |
| `GET /api/v1/route-meta` | Per-route metadata by name (operator, propulsion, garage, type, PVR) |
| `GET /api/v1/route-classifications` | Route type by name (day, night, 24-hour, school, prefix/lettered) |
| `GET /api/v1/route-stops` | Ordered stop sequences per route and direction |
| `GET /api/v1/routes-overview` | Route line geometry — GeoJSON `FeatureCollection` |
| `GET /api/v1/line-status` | Latest line-status snapshot — per-route status + network summary |
| `GET /api/v1/garages` | Garages — code, name, operator, lat/lng, PVR, routes |
| `GET /api/v1/fleet` | Fleet profile per route — count, avg age, propulsion mix, makes |
| `GET /api/v1/vehicles` | Vehicle register by reg — routes, operator, make, year, fuel |
| `GET /api/v1/tenders` | Tender/contract award history per route — bids, operator, dates, miles |
| `GET /api/v1/route-performance` | Reliability per route — EWT/OTP vs MPS, % mileage |
| `GET /api/v1/accidents` | STATS19 bus collisions — lat/lng, severity, date, borough |
| `GET /api/v1/bridges` | Low bridges / height restrictions — lat/lng, clearance, name |
| `GET /api/v1/manifest` | Pipeline run manifest — per-dataset `fetchedAt` + row counts |

### Live positions (separate, real-time)

Real-time bus GPS is **not** part of `v1` (it is volatile and key-backed). It has its own
endpoint, also same-origin and edge-cached (~10s):

```
GET /api/live/vehicles?line=<route>      # e.g. ?line=25 or ?line=25,86
```

### Example

```bash
curl https://atlas.farhan.app/api/v1                 # discover everything
curl https://atlas.farhan.app/api/v1/bridges         # all low bridges
curl "https://atlas.farhan.app/api/live/vehicles?line=25"
```

```js
const { endpoints } = await (await fetch("https://atlas.farhan.app/api/v1")).json();
const routes = await (await fetch("https://atlas.farhan.app/api/v1/routes")).json();
```

> **Attribution.** Data is derived from open sources — TfL Unified API, DfT/STATS19,
> London Datastore (EPOWR), DVLA VES, and londonbusroutes.net. Respect the upstream
> licences when reusing.

The dev server (`pipeline/serve.js`) mirrors `/api/v1/*` exactly, so the API behaves the
same locally and in production. In production it is served by the Pages Function
`functions/api/v1/[[path]].js`; keep the two in sync.
