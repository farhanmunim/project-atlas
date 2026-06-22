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
| `GET /api/v1/tenders` | Tender/contract award history per route — bids, operator, dates, miles; each award also carries derived `jb` (joint-bid: partner routes + total £), `vehicle` (awarded deck/propulsion/basis), and `tranche` |
| `GET /api/v1/route-performance` | Reliability per route — EWT/OTP vs MPS, % mileage |
| `GET /api/v1/accidents` | STATS19 bus collisions — lat/lng, severity, date, borough, vehicles, `casualties`, plus decoded context: `roadType`, `speedLimit`, `junction`, `light`, `weather`, `roadSurface`, `day`, `timeBand` |
| `GET /api/v1/bridges` | Low bridges / height restrictions — lat/lng, clearance, name |
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
| `GET /api/v1/live/national-highways` | Live National Highways unplanned events (incidents/congestion/closures) on the strategic road network, filtered to Greater London — keyless RSS, 2 min cache |
| `GET /api/v1/live/vehicles` *(or `?line=25` / `?route=25`)* | Live bus GPS positions (BODS SIRI-VM) across Greater London — omit the filter for the whole network. One 10 s-cached upstream snapshot shared by all callers (also at the legacy `/api/live/vehicles`) |

Real-time bus **GPS** stays on its own keyed endpoint, edge-cached ~10s:

```
GET /api/live/vehicles?line=<route>      # e.g. ?line=25 or ?line=25,86
```

### Historical / time-series — `/api/v1/history`

Time-series from our Supabase warehouse. Common params: `route`, `from`, `to`, `reg`,
`year`, `limit` (max 1000), `order` (e.g. `day.desc`).

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/history` | Index of historical datasets |
| `GET /api/v1/history/reliability-daily?route=25` | Our own daily reliability (EWT/OTD/lost mileage) |
| `GET /api/v1/history/performance-history?route=25` | TfL quarterly performance, all periods |
| `GET /api/v1/history/schedule?route=25` | Scheduled service per route over time |
| `GET /api/v1/history/tender-programme?route=25` | TfL forward tendering programme |
| `GET /api/v1/history/vehicle-sightings?route=25` | Vehicle-on-route sightings over time |
| `GET /api/v1/history/accidents?from=2024-01-01&to=2024-12-31` *(also `severity=`, `borough=`, `road_type=`, `speed_limit=`)* | STATS19 bus collisions over time — incl. decoded road_type/speed_limit/junction/light/weather/road_surface; the temporal source behind the `/api/v1/accidents` snapshot |

> The history group needs Supabase read credentials configured (see **Historical API
> setup** below). Without them it returns `503` and the live + current groups still work.

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

### Historical API setup (Supabase read key)

The `/api/v1/history/*` endpoints read our Supabase warehouse. The key is held
**server-side** in the Pages Function (never sent to the browser). To enable them:

**1 — Get the values from Supabase**
1. Open your project at <https://supabase.com/dashboard> → **Project Settings** (gear) → **API**.
2. Copy the **Project URL** (e.g. `https://abcdxyz.supabase.co`) → this is `SUPABASE_URL`.
3. Under **Project API keys**, copy the **`anon` `public`** key → this is `SUPABASE_KEY`.
   *(Use the `anon` key, not `service_role`. The `anon` key is designed to be used with
   row-level security; never put the `service_role` key in a public-facing Function.)*

**2 — Allow public read on the historical tables (one-time SQL)**
In Supabase → **SQL Editor**, run this. It's idempotent and **skips any table that
doesn't exist in your project**, so it won't fail if your warehouse is missing one:
```sql
do $$
declare t text;
begin
  foreach t in array array[
    'route_reliability_daily','route_performance','route_schedule',
    'tender_programme','route_vehicle_observations'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format('alter table public.%I enable row level security', t);
      if not exists (select 1 from pg_policies
                     where schemaname='public' and tablename=t and policyname='public read') then
        execute format('create policy "public read" on public.%I for select using (true)', t);
      end if;
    end if;
  end loop;
end $$;
```
*(RLS stays off for the ingest pipeline because it uses the `service_role` key, which
bypasses RLS — so this does not affect data loading.)*

**3 — Add the secrets to Cloudflare Pages**
1. Cloudflare dashboard → **Workers & Pages** → your **Atlas** Pages project → **Settings** → **Environment variables**.
2. Under **Production**, **Add variable** twice:
   - `SUPABASE_URL` = the Project URL from step 1.
   - `SUPABASE_KEY` = the `anon` key from step 1. *(Click **Encrypt** to store it as a secret.)*
3. Add the same two to **Preview** if you want history on preview deployments.
4. **Save**, then trigger a redeploy (**Deployments → Retry deployment**, or push any commit).

After redeploy, `GET /api/v1/history/reliability-daily?route=25` returns rows instead of
`503`. To test locally, put `SUPABASE_URL` and `SUPABASE_KEY` in your `.env`.

> Optionally also set `TFL_APP_KEY` as a Pages variable to raise the live-feed rate
> limit (the live endpoints work without it).
