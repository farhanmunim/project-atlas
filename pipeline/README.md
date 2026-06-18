# Data pipeline — Transit Instruments

The ingestion layer that feeds every instrument. Tools are dependency-free HTML
that read **our store**; this pipeline is the only thing that talks to upstream
APIs/scrapes, normalises the data into our shapes, validates it, and writes it
to the store. The two never share a code path — a slow scrape never blocks a
tool render (the tool shows its last-good/cached state).

This is the **write side**; the tools' `dataSource` seam is the **read side**.
Both depend on *our* data shapes, never on TfL's wire format or where the bytes
live — so today's filesystem store and tomorrow's database are a swap, not a
rewrite.

```
upstream (TfL, …)  ──►  sources/*   ──►  build/*  ──►  store sink  ──►  /data/*.json
                        (thin client)    (normalise +   (fs now,        ▲
                                          validate)      DB later)       │
                                                                    tools read here
                                                                    via dataSource seam
```

## Run it

```bash
npm run refresh              # build everything that's stale
npm run refresh:force        # ignore TTLs, rebuild all
npm run refresh:status       # just the live status snapshot
node pipeline/run.js --only=routes --limit=30   # dev: cap geometry fetches
```

Outputs land in `/data` with a `_manifest.json` recording per-dataset source,
`fetchedAt`, status and row count.

## Datasets (today)

| Dataset | File(s) | Source | Cadence / TTL |
|---|---|---|---|
| `routes` | `routes.json`, `route-classifications.json`, `routes-overview.geojson`, `route-stops.json` | TfL `/Line/Mode/bus` + `/Route/Sequence` (geometry **and** stops, one call) | reference · 7-day TTL |
| `route-meta` | `route-meta.json` | **londonbusroutes.net** `garages.csv` (operator/garage) + `details.htm` (fleet/PVR/length/contract) | weekly · scrape |
| `garages` | `garages.json` | **londonbusroutes.net** `garages.csv` → postcodes.io geocode (garage→override→company precedence) + curated DVSA `garage-capacity.json` (capacity/utilisation) | weekly |
| `fleet` | `fleet.json` | TfL `/Line/{id}/Arrivals` (live regs) → **DVLA VES** when `DVLA_API_KEY` set (make/year/fuel → avg age, propulsion mix, makes) | daily · cached reg lookups |
| `tenders` | `tenders.json` | **TfL tender results** `13923/13796.aspx` — full award history (~2,500), grouped by route | event-driven · scrape, **incremental cache** |
| `status` | `line-status.json` | TfL `/Line/Mode/bus/Status` | live · re-pulled every run |
| `db-mirror` | `transit.db` | mirrors every dataset above into the SQLite warehouse (CDC) — the app reads the DB, never the live API | every run |

Route geometry/stops + classifications come from TfL (authoritative, free). Operator/
garage/fleet/PVR aren't in the free TfL API, so `route-meta` scrapes
londonbusroutes.net — cross-checked against the london-buses dataset (14/15 operator
agreement). Contracts will move to the Find-a-Tender OCDS API next.

`routes-overview.geojson` is the whole network simplified (Ramer–Douglas–Peucker,
4dp) — the layer that lets Atlas draw and filter all routes instantly with **zero
runtime API cost**, the way the reference `london-buses` app does.

Add a source = add `build/<name>.js` + one row in `config.js`. That's the whole
extension surface.

## Caching (three layers)

1. **HTTP validators** — `ETag`/`Last-Modified` persisted in `.cache/http.json`;
   conditional requests let upstreams answer `304 Not Modified` (no body pulled).
2. **Dataset TTL** — the orchestrator skips a dataset still within its TTL
   (`config.js`) unless `--force`. Don't re-pull a weekly feed hourly.
3. **Tool-side** — tools fetch the static store (CDN-cacheable) and keep their
   own live→cached→sample tiers + in-memory cache.

## Robustness (the contract)

- Hard timeout + retries (exponential backoff + jitter, honours `Retry-After`)
  on every request — `lib/http.js`.
- **Soft-fail**: a failed fetch keeps the **last-good** store file (never
  overwrites good data with empty) and the run continues; the manifest marks it
  `failed` so the tools' badge can show "stale".
- **Validate before it lands** (`lib/validate.js`): row-count bands, required
  fields, no all-null columns — a bad batch throws and is rejected, not stored.
- **Atomic writes** (`.tmp` + rename) — a killed run never leaves a torn file.
- **Idempotent**: same inputs → same store; safe to re-run after a crash.

## API keys (optional, server-side only)

Loaded from `.env` (repo root, gitignored) via `lib/env.js` at every entry point —
see `.env.example`. Both are optional; the app degrades gracefully without them and
neither is ever shipped to the browser:

- `TFL_APP_KEY` — TfL Unified API subscription key ([api-portal.tfl.gov.uk](https://api-portal.tfl.gov.uk/)). Raises the rate limit; the API works key-less.
- `DVLA_API_KEY` — DVLA Vehicle Enquiry Service key ([developer-portal.driver-vehicle-licensing.api.gov.uk](https://developer-portal.driver-vehicle-licensing.api.gov.uk/)). Enables `fleet` age/make/propulsion enrichment; without it, regs are still captured.

No other source needs a key (postcodes.io, CARTO/OSM tiles, londonbusroutes.net, TfL tender pages are all keyless).

## Staying within the free tiers

Fresh data **and** inside the published limits, by design:

- **TfL — 500 req/min** with a key (no daily cap). Our heaviest pull is `fleet`
  (~676 Arrivals calls, concurrency-limited) + `status` (1 call); route geometry
  is weekly. `lib/http.js` backs off on 429/5xx, so a momentary burst self-corrects.
- **DVLA VES — per-second limit, 429 on exceed** (no public daily number). We stay
  polite and bounded: a configurable inter-request delay (`DVLA_DELAY_MS`, default
  220ms ≈ 4.5/s), a **per-run cap** (`DVLA_MAX_LOOKUPS`, default 5000) so a cold
  start spreads over a few daily runs, exponential backoff on 429, and a hard stop
  (persist + resume next run) if still throttled. Resolved regs are **cached**
  (`data/fleet-dvla-cache.json`, committed) so steady-state runs only resolve the
  few regs the fleet rotated in — typically a few hundred a day.

Cadence (per-dataset TTL in `config.js`): routes/meta/garages **weekly**, fleet +
status **daily**, tenders event-driven. So a daily run does little unless something
is due.

## Automation

`.github/workflows/refresh-data.yml` runs daily (and on manual dispatch) on Node 24,
restores the validator cache, runs the pipeline, and commits the refreshed store
(including the warm DVLA reg cache → next run starts warm). Set `TFL_APP_KEY` /
`DVLA_API_KEY` as repo secrets to enable the keyed paths; tune `DVLA_MAX_LOOKUPS`
there if you want faster/slower backfill. Well inside GitHub Actions' free minutes:
a warm daily run is a few minutes (public repos are unlimited regardless).

## The store sink — fs now, database later

`lib/store.js` exposes a `sink` with `writeDataset()` / `readDataset()`.

- `STORE_SINK=fs` (default) → `/data/*.json` + `*.geojson`, served straight to
  the HTML tools.
- `STORE_SINK=supabase` (future) → upsert into **our own** warehouse. We will
  ingest and own all data ourselves; Supabase/Postgres is the likely backend.

The DB sink implements the same two methods with the same dataset names and
shapes, so the future read API mirrors these 1:1 and tools flip `tfl → store/db`
by config — render code unchanged.
