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

Validate the data layer (shape, row counts, vocab, reconciliation — what `/api/v1/*` serves):

```bash
npm run validate:atlas               # dependency-free data-integrity gate; exit 0 = all pass
```

## Environment / secrets

Secrets live in `.env` (gitignored) locally and as Cloudflare/CI secrets in production —
never hardcoded, never shipped to the browser. See `.env.example` for the keys:

- `TFL_APP_KEY` — optional, raises the TfL rate limit (pipeline + dev).
- `DVLA_API_KEY` — optional, enables fleet (VES) enrichment in the pipeline.
- `BODS_API_KEY` — Cloudflare **secret**; powers the live-positions Pages Function only.

## Deployment (Cloudflare Pages)

Static site, **no build command**, output directory = repo root (`/`); the `functions/`
directory is auto-detected. The committed `data/*.json` are the production read layer.
A daily VPS task (`pipeline/vps-refresh.sh`, Coolify Scheduled Task at 03:17 UTC — see
`ingest/SELF-HOSTING.md`) refreshes them and the push auto-triggers a Pages rebuild;
no GitHub Actions are used. Live bus GPS is a Pages Function
(`functions/api/live/vehicles.js`) keeping `BODS_API_KEY` server-side.

---

## Public API — `/api/v1`

Atlas serves all of its data through its own **open, read-only, versioned API**. It is
CORS-open (any origin), needs **no key**, and is safe to share and build on. The site
itself consumes this API; you get exactly the same data.

> **Full reference: [`API.md`](API.md)** — the canonical external-facing API doc
> (endpoints, params, response shapes, caching, attribution). The summary below is
> kept in sync with it.

- **Base URL:** `https://atlas.farhan.app/api/v1`
- **Full data reference:** [`https://atlas.farhan.app/docs`](https://atlas.farhan.app/docs) — every dataset and field documented: meaning, upstream source, processing, validation gates, fallbacks and refresh cadence. The tables below are the summary; `/docs` is the complete contract.
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
| `GET /api/v1/route-destinations` | Termini per route/direction — lightweight "A → B" labels (canonical, diversion-frozen) |
| `GET /api/v1/routes-overview` | Route line geometry — GeoJSON `FeatureCollection` (simplified ~11 m for the network layer) |
| `GET /api/v1/route-geometry/<id>` | Full-fidelity geometry for one route — TfL's raw ring, both directions, freeze-aware (404 → fall back to `routes-overview`) |
| `GET /api/v1/line-status` | Latest line-status snapshot — per-route status + network summary |
| `GET /api/v1/garages` | Garages — code, name, operator, lat/lng, PVR, routes |
| `GET /api/v1/fleet` | Fleet profile per route — count, avg age, propulsion mix, makes |
| `GET /api/v1/vehicles` | Vehicle register by reg — routes, operator, make, year, fuel, plus community-tier enrichment: `body` (chassis + bodywork type), `deck`, `fleetCode`, and `propulsionSource` when DVLA's known hybrid/FCEV fuel misreport was corrected. Chain: DVLA first (never overwritten) → bustimes.org → londonbusroutes |
| `GET /api/v1/tenders` | Tender/contract award history per route — bids, operator, dates, miles; each award also carries derived `jb` (joint-bid: partner routes + total £), `vehicle` (awarded deck/propulsion/basis), and `tranche` |
| `GET /api/v1/route-performance` | Reliability per route — EWT/OTP vs MPS, % mileage |
| `GET /api/v1/accidents` | STATS19 bus collisions — lat/lng, severity, date, borough, vehicles, `casualties`, plus decoded context: `roadType`, `speedLimit`, `junction`, `light`, `weather`, `roadSurface`, `day`, `timeBand` |
| `GET /api/v1/bridges` | Low bridges / height restrictions — lat/lng, clearance, name |
| `GET /api/v1/crowding` | Bus crowding per route (TfL BUSTO) — peak `V/C` (load÷capacity at the max-demand hour), `band` (comfortable→crowded), busiest stop/time/day, per-day-type peak |
| `GET /api/v1/crowding-profile` | Per-route crowding detail (TfL BUSTO) — load-along-route (`V/C` by stop in sequence) + time-of-day curve (`V/C` per timeband, per day type); powers the corridor gradient + dossier charts |
| `GET /api/v1/localities` | London locality labels for maps — towns & suburbs (`name`, `lat`/`lng`, `kind`); source OpenStreetMap (ODbL). Powers the apps' "Place names" layer |
| `GET /api/v1/route-diversions` | Active route diversions keyed by route name — `status`/`disruptions` (reason + validity window) from TfL live status, plus the diff of TfL's current Route/Sequence against our frozen canonical baseline: `missedStops`, temporary `addedStops`, and (when TfL has redrawn the line, `geometryStatus:"published"`) the diverted `diversionSegments` + `bypassedSegments` geometry, per direction. `baselineSource` says which baseline the diff used: `store` (our frozen canonical) or `ibus:<version>` (recovered from TfL's dated iBus static drops when the stored baseline had already absorbed an advance redraw). Refreshed daily; episodes carry `detectedAt` |
| `GET /api/v1/manifest` | Pipeline run manifest — per-dataset `fetchedAt` + row counts |

The API has three groups, all listed in the `/api/v1` discovery index:
**current** (the snapshot tables above), **live** (`/api/v1/live`), and **history**
(`/api/v1/history`).

### Live feeds — `/api/v1/live`

TfL feeds proxied through our API, CORS-open, edge-cached (so a flood of callers
collapses to a trickle of upstream pulls). No caller key.

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/live` | Index of live feeds |
| `GET /api/v1/live/status?route=25` | Live bus line status (omit `route` for the whole network) |
| `GET /api/v1/live/disruptions` | Active bus line disruptions |
| `GET /api/v1/live/arrivals?stop=<naptan>` *(or `?route=<id>`)* | Live arrival predictions |
| `GET /api/v1/live/road-disruptions` | Live London road incidents/closures (TfL control centre, ~5 min) |
| `GET /api/v1/live/national-highways` | **Retired** — returns `410 Gone`. National Highways withdrew the keyless RSS this endpoint proxied (its replacement API needs a registered key). Use `road-disruptions` for London road incidents |
| `GET /api/v1/live/vehicles` *(or `?line=25` / `?route=25`)* | Live bus GPS positions (BODS SIRI-VM) across Greater London — omit the filter for the whole network. One 10 s-cached upstream snapshot shared by all callers (also at the legacy `/api/live/vehicles`) |

Real-time bus **GPS** stays on its own keyed endpoint, edge-cached ~10s:

```
GET /api/live/vehicles?line=<route>      # e.g. ?line=25 or ?line=25,86
```

### Historical / time-series — `/api/v1/history`

Time-series from our self-hosted warehouse (Postgres + PostgREST). Common params:
`route`, `from`, `to`, `reg`, `year`, `limit` (max 1000), `order` (e.g. `day.desc`).

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/history` | Index of historical datasets |
| `GET /api/v1/history/reliability-daily?route=25` | Our own daily reliability (EWT/OTD). **Experimental** — surfaced in the app's route dossier + table as an "Atlas estimate" (cyan, `~`-prefixed), currently biased high (the ~30-min Arrivals sampling under-observes short headways); shown alongside, and explicitly not comparable to, TfL's published QSI. |
| `GET /api/v1/history/lost-mileage?route=25` *(also `from=`/`to=`, `day_type=`, `confidence=`)* | Our own daily **gross** lost-mileage estimate — % of scheduled trips the continuous BODS trip-tracker never observed running (`lost_pct` + trip counts + `feed_coverage_pct`/`confidence`). Feed outages are excluded as unmeasured, never counted lost. **Experimental** — gross by construction (says trips didn't run, not why); not comparable to TfL's contractual in-control lost-mileage figures. |
| `GET /api/v1/history/reliability-tracked?route=25` *(also `from=`/`to=`, `day_type=`, `confidence=`)* | Our daily **tracked** reliability estimate (EWT/OTD v2) — complete observed headways from the same continuous tracking, removing the sampled estimate's bias. EWT = AWT − SWT (high-freq); OTD −2…+5 min with non-arrivals counted (low-freq). **Experimental** — calibrating against TfL's QSI before promotion. |
| `GET /api/v1/history/performance-history?route=25` | TfL quarterly performance, all periods |
| `GET /api/v1/history/schedule?route=25` | Scheduled service per route over time |
| `GET /api/v1/history/tender-programme?route=25` | TfL forward tendering programme |
| `GET /api/v1/history/route-snapshots?route=25` *(also `operator=`, `propulsion=`, `garage=`, `from=`/`to=`)* | Per-route CDC snapshots over time — PVR, propulsion, deck, vehicle type, operator, garage, fleet size/age, MPS. The record behind fleet-move / propulsion-change / PVR-change analysis |
| `GET /api/v1/history/garage-snapshots?garage=BW` *(also `operator=`, `from=`/`to=`)* | Per-garage snapshots over time — total PVR, route count, routes served |
| `GET /api/v1/history/vehicle-sightings?route=25` | Vehicle-on-route sightings over time (once-daily sample) |
| `GET /api/v1/history/vehicle-assignments?reg=LX58CWU` | Per-vehicle daily route assignments from continuous tracking — one row per (reg, route, day); catches mid-day reallocations |
| `GET /api/v1/history/crowding?route=25` | Bus crowding per route per year (TfL BUSTO) — filter by `route`, `band`, `year`, `day_type` |
| `GET /api/v1/history/accidents?from=2024-01-01&to=2024-12-31` *(also `severity=`, `borough=`, `road_type=`, `speed_limit=`)* | STATS19 bus collisions over time — incl. decoded road_type/speed_limit/junction/light/weather/road_surface; the temporal source behind the `/api/v1/accidents` snapshot |

> The history group needs warehouse read credentials configured (see **Historical API
> setup** below). Without them it returns `503` and the live + current groups still work.
> **Exception — `history/accidents`:** the full enriched multi-year STATS19 set also ships as
> the static snapshot, so this endpoint **falls back to filtering `data/accidents.json`** when
> the warehouse is unconfigured or a filter targets a column whose migration is still pending —
> the documented filters (`severity`, `borough`, `road_type`, `speed_limit`, `day`, `time_band`,
> `from`/`to`) return enriched rows regardless. Responses carry a `source` field when served from
> the snapshot.

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
same locally and in production. In production it is served by Pages Functions
(`functions/api/v1/[[path]].js`, `…/live/[[path]].js`, `…/history/[[path]].js`); keep the
dev mirror in sync.

### Historical API setup (self-hosted warehouse)

The `/api/v1/history/*` endpoints read our own warehouse — a **self-hosted Postgres +
PostgREST** (no external database vendor). The key is held **server-side** in the Pages
Function (never sent to the browser). The summary below covers the essentials; the
**full validated runbook** (Coolify resources, role bootstrap, PostgREST config,
scheduled tasks, gotchas) is [`ingest/SELF-HOSTING.md`](ingest/SELF-HOSTING.md).
To enable them:

**1 — Stand up Postgres + PostgREST** (e.g. on a Coolify VPS)
1. Deploy a plain Postgres instance and load `ingest/db/migrations-bundle.sql`
   (concatenates every file in `ingest/db/migrations/`).
2. Create the roles PostgREST switches into per request — `authenticator` (its own
   login role), `anon` (read-only, matches every `TO anon` RLS policy already in the
   migrations), `service_role` (full read-write, `BYPASSRLS`, used by the ingest
   pipeline), `authenticated` (unused today, kept for parity).
3. Deploy `postgrest/postgrest`, pointed at that Postgres via `authenticator`, with
   `PGRST_DB_SCHEMA=public`, `PGRST_DB_ANON_ROLE=anon`, and a `PGRST_JWT_SECRET` you
   generate yourself.
4. Mint two JWTs signed with that secret — one with `{"role":"anon"}`, one with
   `{"role":"service_role"}` — these become `WAREHOUSE_ANON_KEY` and
   `WAREHOUSE_SERVICE_KEY` below.
5. Route a public domain's `/rest/v1/*` to PostgREST (stripping the `/rest/v1` prefix,
   since PostgREST serves tables at its root) — this domain is `WAREHOUSE_URL`.

**2 — Add the secrets to Cloudflare Pages**
1. Cloudflare dashboard → **Workers & Pages** → your **Atlas** Pages project → **Settings** → **Environment variables**.
2. Under **Production**, **Add variable** twice:
   - `WAREHOUSE_URL` = the PostgREST domain from step 1.5.
   - `WAREHOUSE_ANON_KEY` = the anon-role JWT from step 1.4. *(Click **Encrypt** to store it as a secret.)*
3. Add the same two to **Preview** if you want history on preview deployments.
4. **Save**, then trigger a redeploy (**Deployments → Retry deployment**, or push any commit).

After redeploy, `GET /api/v1/history/reliability-daily?route=25` returns rows instead of
`503`. To test locally, put `WAREHOUSE_URL` and `WAREHOUSE_ANON_KEY` in your `.env`.

The `ingest/` pipeline writes to the same warehouse using `WAREHOUSE_URL` +
`WAREHOUSE_SERVICE_KEY` (the service_role-equivalent JWT, bypasses RLS) — see
`ingest/.env.example`. Its scheduled jobs run as Coolify Scheduled Tasks on the same
VPS, not GitHub Actions.

> Optionally also set `TFL_APP_KEY` as a Pages variable to raise the live-feed rate
> limit (the live endpoints work without it).
