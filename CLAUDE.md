# AGENTS.md — Atlas (London Bus Network tool)

**Atlas is THE tool** — a single interactive map + analytics app for the London bus
network, served at `index.html`. It consolidates what were separate instruments
(Radius catchment, Relay live tracking, Mandate tenders, Cohort fleet, Sentinel
accidents) into one deep-dive: **toggleable map layers** (route lines · garages ·
stops · live buses · accidents) and **one unified context panel** (route info ·
network analysis · live operations · fleet · tenders · accidents). The old
`headway/mandate/cohort/sentinel/relay.html` + the hub live in `archive/`.

Goal: replace london-buses.farhan.app — **simple to navigate, rich on drill-down +
analytics**, robust, with all data flowing through our own warehouse.

> **Atlas is primarily the API** (`/api/v1` — README + API.md are the public
> reference). The `/` and `/v2` pages are kept **deliberately** as the visual
> verification layer: the headless validation scripts (`verify-diversions.mjs`,
> `verify-render.mjs`, `route-check.mjs`) drive them to prove the API's data
> renders correctly, and a human can eyeball any dataset on the map in seconds.
> Do NOT remove the front-end pages — they are part of the validation story
> (decision recorded 2026-08-05).

> **Modular by construction.** Even though it's one tool, keep processes/functions
> modular (per-concern render helpers, the `dataSource` seam, pipeline `build/<name>.js`
> per dataset) so any layer/analysis can be lifted into a standalone tool later.

---

## General Project Standards

These are baseline standards Farhan applies across all projects. They apply here
unless a rule in **Project-Specific Standards & Overrides** (below) explicitly
supersedes it. Where Atlas's existing sections already cover a topic in more
detail (the three-pane shell, design tokens, the data seam, pipelines), those
sections are authoritative — these generic rules fill the gaps.

### Git & Identity

- **Never commit or push unless Farhan explicitly says so** in that message.
  Stage/edit freely, but `git commit` / `git push` only on an explicit instruction
  for that specific commit or push. Do not batch or auto-commit at the end of a
  session without asking.
- When ready to commit, state exactly what will be committed and wait for approval.
- **When told to push, commit AS Farhan** — author **Farhan Munim
  `<auth@farhan.app>`**. No `claude` / bot author, no `Co-Authored-By`, no
  sub-author or "Generated with" trailer. Never mention AI tooling in commit
  messages or metadata.
- Verify `git config user.name` (`Farhan`) and `git config user.email`
  (`auth@farhan.app`) match before the first commit on any session.
- Write clear, descriptive commit messages in the imperative mood
  (e.g. "Add caching layer for API responses").

### Site identity & meta (keep consistent)

Every user-facing HTML page ships a consistent identity block — don't leave
default or placeholder `<title>`/meta on any page.

- `<html lang="en-GB">` with `<meta name="color-scheme" content="dark">`.
- `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- **Title:** `Atlas — London Bus Network` (or `<section> · Atlas` when a deep-link
  view warrants it). Keep the brand suffix consistent across pages.
- **Description meta** describing the tool (interactive map + analytics for the
  London bus network).
- **Favicon** — the Atlas mark, matching the topbar logo (an SVG favicon as in the
  predecessor project).
- **Open Graph / Twitter card** tags (`og:title`, `og:description`, `og:type`,
  `og:url`, `og:image`) so shared links render properly.
- The same identity/meta snippet appears on **every** user-facing page (e.g.
  `index.html`, any changelog page) — treat it as shared chrome, not per-page copy.

### Analytics

- Before the first push on a new project, ask whether to include tracking — do not
  add analytics without explicit confirmation.
- If confirmed, the same snippet must appear on every user-facing HTML page.
- Analytics is **anonymous aggregate only** — no user accounts, no fingerprinting.

### Environment & Secrets

- Store all API keys and secrets in a `.env` file — **never hardcoded**.
- Add `.env` to `.gitignore` on project initialisation.
- Include a `.env.example` listing all required keys with **no values**.
- In Atlas specifically: `BODS_API_KEY` is a Cloudflare project **secret** (and a
  local `.env` value for dev) — it powers the `functions/api/live/vehicles.js`
  Pages Function server-side and **never reaches the browser**. Pipeline keys
  (TfL etc.) live the same way: secrets in CI / local `.env`, never shipped.

### .gitignore — keep it lean

- Ignore anything not required in the repo: build artefacts, local config and
  editor files, OS files (`.DS_Store`, `Thumbs.db`), logs, temp folders
  (e.g. `/screenshots`), and `CHANGELOG.md`.
- The `data/*.db` warehouse is gitignored (the committed `data/*.json` is the prod
  read layer — see Deployment). Verify no junk or secret files are tracked before
  committing.

### Changelog

- If `CHANGELOG.md` does not exist, create it at project root.
- Internal use only — add it to `.gitignore`.
- Log every meaningful change with a date and short description.

### Local development

- Always run a local server so the project previews in-browser; in Atlas that's the
  **dev-only** `pipeline/serve.js` (its dynamic routes are reproduced in prod by
  static JSON + the Pages Function — keep both in sync).
- Confirm the URL and port at the start of each session, and use a **fixed port**
  per project — don't let it change between sessions.

### Puppeteer checks (pre-commit)

Before committing any visual or functional change:

- Capture screenshots at desktop (`1280×800`) and mobile (`390×844`).
- Check for JS console errors on page load and resolve them before committing.
- Store screenshots in `/screenshots` (gitignored). Puppeteer is already installed
  — use it directly, no install needed.

This complements the **Validation** section below (headless cross-check of
rendered ↔ source); screenshots alone are never sufficient proof.

### API data & security

> **Atlas override:** Atlas does **not** use a Cloudflare Worker proxy. Runtime
> browser calls go directly to CORS-open TfL feeds via the `tfl` seam; the one
> keyed feed (BODS SIRI-VM live GPS) is served by a **Cloudflare Pages Function**
> (`functions/api/live/vehicles.js`), edge-cached, with the key as a project
> secret. The security _principles_ below still apply to that Function and the
> pipeline.

- Never expose a key to the browser. Server-side key use lives only in the Pages
  Function and build scripts.
- **Input validation:** never trust query params or client input. Validate and
  sanitise everything reaching the Pages Function; reject malformed or unexpected
  inputs early.
- **Rate limiting:** apply Cloudflare rate limiting on the Function route before
  going live (baseline ~100 req/min/IP, adjust per use case). Prefer caching
  before rate limiting. Remind Farhan to configure this before go-live.

### Caching strategy

- Define explicit TTL rules for fetched data — default 60–300 s unless the data is
  genuinely real-time. The live vehicles Function is 10 s edge-cached; match each
  feed's cadence (see _Data sources_ — don't re-pull a 30 s-cached feed every
  second).
- Use stale-while-revalidate where possible.
- Never cache sensitive or user-specific data.

### Error handling & resilience

- Handle all API/network failures gracefully (timeouts, 4xx, 5xx).
- Never allow a silent UI failure — always show a fallback state or message.
- Retry transient failures (1–2 attempts with delay).
- On failure, keep the previous data on screen and use cached data if available;
  surface the state honestly in the last-refreshed badge (see _Topbar layout_).
- Never leave empty or broken UI states. (This is the same graceful-degrade tiering
  the _Data sources_ section already mandates: live → cached → labelled sample.)

### Performance

- Avoid unnecessary DOM updates / re-renders; re-render only the affected pane.
- Lazy-load or defer non-critical assets (e.g. SheetJS-style libs loaded `defer`).
- Keep JS lightweight; remove unused code.
- Set appropriate cache headers for static assets.

### Security headers (baseline)

Apply standard headers on all responses where possible (via Pages config /
`_headers`): `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`.

### Logging & debugging

- Log meaningful errors only — avoid console spam.
- Minimise logs in production.
- For the Pages Function: log failures and cache hits/misses where useful.

### Versioning

- Version any API-like endpoint (the Pages Function route) — e.g. `/api/v1/...`.
- Don't introduce breaking changes without a version increment.

### README

- Keep `README.md` current with: project purpose, local setup, required env
  variables (keys only, no values), and Cloudflare Pages / Function setup notes.
- Treat it as the source of truth for picking the project up cold.

### Network inspection (pre-ship)

Before shipping, verify in DevTools → Network: no keys exposed, no duplicate or
wasteful requests, caching behaves as expected.

### Code consistency

- Keep naming conventions consistent per layer.
- Don't mix async patterns (`async/await` vs `.then`) within a layer.
- Prefer simple, native solutions over added dependencies; don't install an npm
  package for something a native browser API solves (consistent with the
  no-framework / no-bundler rule below).

---

## Working agreement (commits & deploys)

- **Never commit or push to GitHub unless Farhan explicitly says so** in that
  message. Stage/edit freely, but `git commit`/`git push` only on an explicit
  instruction.
- **When told to push, commit AS Farhan** — author **Farhan Munim
  `<auth@farhan.app>`**. No `claude`/bot author, no `Co-Authored-By`, no
  sub-author or "Generated with" trailer. Just Farhan.

## Deployment (Cloudflare Pages)

Atlas deploys as a **static site on Cloudflare Pages** (no Node server in prod).
The local `pipeline/serve.js` is **dev-only**; its dynamic routes are replaced in
prod as follows — keep both in sync:

- **Static data** — the committed `data/*.json` + `routes-overview.geojson` (the
  warehouse output) ship as static assets. The store reader tries our public API
  `/api/v1/*` first, then falls back to `./data/*.json`. The `data/*.db` warehouse is
  gitignored and **not** deployed (JSON is the prod read layer).
- **Public API** — `/api/v1/*` is our own open, versioned, CORS-open read API (no key;
  GET only; discovery at `/api/v1`, which lists three groups). The app consumes it; it's
  documented in `README.md` for external reuse. Keep the prod Pages Functions and the
  `serve.js` dev mirror in sync.
  - **current** — `/api/v1/<dataset>` re-serves the static `data/*.json`
    ([`functions/api/v1/[[path]].js`]; dev reads the same files).
  - **live** — `/api/v1/live/*` proxies TfL (status · disruptions · arrivals ·
    road-disruptions) ([`functions/api/v1/live/[[path]].js`]), keyless, edge-cached.
    Real-time bus GPS stays separate at `/api/live/vehicles` (volatile, keyed).
  - **history** — `/api/v1/history/*` serves the warehouse time-series (reliability-daily ·
    **lost-mileage** (daily gross estimate from continuous BODS trip tracking, EXPERIMENTAL) ·
    **reliability-tracked** (EWT/OTD v2 from the same tracking — complete observed headways,
    EXPERIMENTAL, calibrating vs TfL QSI) ·
    performance-history · schedule · **route-snapshots** · **garage-snapshots** ·
    tender-programme · vehicle-sightings · accidents · crowding)
    ([`functions/api/v1/history/[[path]].js`]). Strict per-endpoint whitelist (table +
    filters + capped page size); `WAREHOUSE_URL` + `WAREHOUSE_ANON_KEY` (anon-role JWT +
    RLS read policies) are server-side Cloudflare secrets, never shipped. See README
    "Historical API setup". Returns 503 (not 502) when unconfigured; live + current still work.
- **Data refresh = Coolify Scheduled Tasks on the VPS** (`atlas-refresh` resource:
  `pipeline/refresh.Dockerfile` + `pipeline/vps-refresh.sh`, daily full run 03:17 UTC
  plus an intraday `REFRESH_ARGS="--only=diversions"` run every 4 h so diversions
  stay fresh between full builds — see `ingest/SELF-HOSTING.md`). Each run clones main, runs the pipeline, hard-validates
  (`validate-atlas.js` gates the commit), commits refreshed `data/*.json`, and the
  push auto-triggers the Cloudflare Pages rebuild. That commit is the bot's
  (`transit-instruments-bot`) — the "commit as Farhan" rule above is for _our_
  manual commits, not this automated data commit. **No GitHub Actions remain** —
  all automation (this + the four warehouse ingest cadences) runs on the VPS.
- **Live data** — volatile feeds go **browser → TfL directly** via the `tfl`
  seam (CORS-open): line status, arrivals/vehicles, disruptions. No server needed.
- **Live bus GPS (BODS SIRI-VM)** — needs a server-side key, so it's a
  **Cloudflare Pages Function** at [`functions/api/live/vehicles.js`], reproducing
  serve.js's `/api/live/vehicles` on the same URL (10s edge-cached). `BODS_API_KEY`
  is a Cloudflare project **secret**, never shipped to the browser. If the parse
  logic in `pipeline/sources/bods.js` changes, change the Function too.
- Pages build config: **no build command**, output directory **repo root** (`/`);
  the `functions/` dir at root is auto-detected.

## Built Atlas features & data layers (current state)

What exists in `index.html` today — don't rebuild it, and keep it working:

- **Map layers** (a v2-style **Layers panel** — labelled toggle-switch rows behind one
  topbar `Layers` button in `#mapCtl`, with an enabled-count badge; persisted in settings
  *except* the noisy overlays): route lines · **place names** (locality labels from
  `/api/v1/localities` — OSM towns/suburbs, `pipeline/build/localities.js`; towns from
  z10, suburbs join at z12, drawn in a dedicated pane above the route lines so main
  areas read at route-fit zoom; also a `/v2` Layers toggle) · garages · stops ·
  **live buses (BODS GPS)** ·
  **collisions (STATS19)** · **low bridges** (clearance-graded bridge-icon markers) ·
  **live road incidents** (TfL Road Disruptions via `/api/v1/live/road-disruptions` —
  collisions/breakdowns/delays/works/closures, category-coloured) · **crowding** (TfL BUSTO —
  route lines tinted by peak-load band comfortable→crowded; in `/` it's the third **colour-by**
  mode beside Operator/Type, in `/v2` a Layers toggle). Live · collisions ·
  bridges · incidents **always start OFF each session** (reset on load, not persisted-on);
  the user enables them explicitly, and when on they scope to the selected/searched
  route(s). A contextual **Map key** legend (`updateLegend`) labels every visible symbol.
- **Route dossier** (right rail, `renderContext`) — accordion `group()`s: Live ops ·
  **Route** (incl. a **Reliability** block — EWT/OTP vs MPS + % mileage, from
  `store.perf` (TfL QSI); plus a separate **Reliability — Atlas estimate** block
  (`reliabilityOf`, from `/api/v1/history/reliability-daily` via `loadReliabilityLatest`)
  showing our OWN live-sampled EWT (high-freq) / OTD (low-freq) — flagged **EXPERIMENTAL**
  and currently biased high (the ~30-min Arrivals sampling under-observes short headways),
  so it's cyan/`~`-prefixed and explicitly "not comparable to TfL's QSI"; lost-mileage is
  deliberately NOT shown (operated_km is a sampling-coverage sliver). Mirrored as the
  table's "Est. rel. (exp)" column + the CSV's "Est EWT/OTD (exp)" fields. The estimate's
  methodology is being refined; the warehouse calc lives in `ingest/build-reliability.js`) ·
  **Risk & accidents** (collisions near the route: density, KSI,
  severity split, by-year trend, hotspot boroughs — `sentinelBody`; plus a **low-bridge
  diversion-risk** readout that flags bridges under the 4.4 m double-deck height near the
  route, and a **user-set alert-proximity slider** (`riskRadius`, persisted) that drives
  the collision + bridge corridors and re-scopes their map layers) · Fleet ·
  **Commercial** (tender history with **bid spread low–won–high**, previous-operator
  + win/loss flag, notes, contracted miles). Network view + catchment (Magnify) also
  carry a Risk & accidents readout.
- **Classification**: route type now includes **`prefix`** (lettered SL/EL/W/X routes,
  `isPrefixRoute`) alongside regular/24-hour/night/school.
- **Selection UX**: search **auto-detects** single vs multi (one token → single;
  comma-separated → multi-compare) — the Single/Multi toggle is just a manual
  override. Clicking a route (similar-route row, connection pill, marker/stop popup)
  while one is selected **adds** it to the view rather than replacing. Selected routes
  show as removable **chips** on the left rail.
- **Accidents map = density heatmap**: nearby collisions bin into one circle whose
  radius + colour scale with the count (amber few → deep red many), re-binned on
  zoom (`drawAccidents`).
- **Responsive**: ≤820px → simple single-column, page-scrolling layout (route list →
  map → analysis all reachable); map `invalidateSize` on resize.
- **Atlas data files** (seam-read): routes, route-meta, route-stops, **route-destinations**
  (termini per direction, derived from the canonical frozen sequences — the "A → B" label
  dataset), garages, fleet,
  vehicles, tenders, routes-overview.geojson (simplified ~11 m — the network layer) +
  **route-geometry/<id>.json** (full-fidelity per-route rings, lazy-loaded on selection
  by both apps so drawn lines are road-faithful to TfL; freeze-aware — structurally
  diverted routes keep last-good, absent file → overview fallback), **route-performance.json** (EWT/OTP/MPS,
  `pipeline/build/performance.js`), **accidents.json** (STATS19, `pipeline/build/accidents.js`
  — per collision: severity/date/borough/vehicles/**casualties** **plus decoded context** roadType/
  speedLimit/junction/light/weather/roadSurface/day/timeBand, which surface as the lens "aggregate
  by" dimensions, the apps' "Collision context" risk readouts, and a Casualties metric), and
  **crowding.json** (TfL BUSTO, `pipeline/build/crowding.js` + `sources/busto.js` — streams the
  ~98MB "MAX DEMAND HOUR BY ROUTE BY TIMEBAND" CSV and reduces to one record per route: peak **V/C**
  = load÷capacity at the max-demand hour, banded comfortable→crowded, with the per-day-type peak;
  powers the **Crowding colour layer** + the dossier's Crowding readout in both `/` and `/v2`), and
  **crowding-profile.json** (the per-route DETAIL split out of the summary so the network colour layer
  stays light: `loadProfile` = V/C by stop in sequence along the busiest direction, `timeOfDay` = V/C
  per timeband per day type — served at `/api/v1/crowding-profile`, lazy-loaded only on route select,
  and drives the **corridor crowding gradient** (the line painted by per-stop V/C, not one flat band)
  + the dossier's **load-along-route** and **time-of-day** mini-charts in both apps), and
  **localities.json** (`pipeline/build/localities.js` + `sources/osm-places.js` — OSM
  place=town|suburb nodes for the London bbox via Overpass, ODbL; served at
  `/api/v1/localities`; powers the **Place names** map layer in `/` and `/v2`), and
  **route-diversions.json** (`pipeline/build/diversions.js` — active diversion episodes:
  detection from TfL live status via `lib/tfl-status.js` (TfL's `validityPeriods.isNow` is
  unreliable — date windows are checked directly), then TfL's current Route/Sequence diffed
  against the store's canonical baseline → per-direction `missedStops`/`addedStops` and,
  when TfL has redrawn the line (`geometryStatus:"published"`), the real `diversionSegments`
  + `bypassedSegments` geometry. Runs BEFORE the routes builder and hands it
  `ctx.divertedRoutes` — the **baseline freeze**: flagged routes keep last-good
  stops/geometry so a temporary diversion never silently overwrites the canonical route
  (self-heals when the episode ends). Served at `/api/v1/route-diversions`; renders in `/`
  as the dashed-amber diverted path + dotted-red bypassed section + missed/temporary stop
  markers (`drawDiversions`, three tiers: store diff → live text-parse fallback → live-GPS
  estimated traces for unpublished geometry), the always-visible dossier diversion panel,
  the table's **Diverted** column + CSV fields, and in `/v2` as the always-on `divnLayer`
  overlay + a Route-card Diversion section; mirrored to warehouse `route_diversions`
  (migration `0029`, one row per episode keyed `route_id, detected_at` — never deleted, so
  the table accrues diversion history).
  Both warehouse builders — and fleet/route-meta/garages/tenders/vehicles/routes —
  gate writes with `lib/validate.js` (`rowsWithin` etc.) so a degraded fetch can't
  overwrite last-good. **`lib/normalize.js`** is the shared cleanup the builders apply so
  the warehouse lands already-clean: `cleanMake` (DVLA ALL-CAPS chassis → tidy brand),
  `propulsionOf` (fuelType → electric/hybrid/hydrogen/diesel/gas, incl. the DVLA edge
  cases — but DVLA reports most hybrids as plain diesel, so route-meta/londonbusroutes
  stays the hybrid authority), and `canonicalOperator` (+ `operator-aliases.json`) which
  rolls messy tender operator variants up to the parent brand (raw kept on `operatorRaw`;
  the append-only `byId` tender cache is never mutated). **DVLA fleet enrichment**
  (`sources/dvla.js`) pre-validates UK VRMs, caches hits + misses, is per-run-capped +
  429-backed-off, and `build/fleet.js` backfills every rostered reg (not just those
  running this minute) so new plates fill in regardless of timing.

> **"Sentinel"** is the **legacy internal name** for the accidents/risk layer — it must
> NOT appear in any user-facing copy (only in code comments / function names).

## Warehouse ingest pipeline (`ingest/`)

A **standalone, isolated** ingestion subtree (moved in from the old london-buses
repo) that builds a historical/analytics warehouse on **self-hosted Postgres +
PostgREST** (a Coolify VPS — no external database vendor; previously Supabase cloud,
migrated off after hitting its free-tier storage cap).
It is **fully decoupled** from Atlas — its own `package.json`, `data/`, and
schedules; it shares **no code path** with `pipeline/` or the site. It writes
**only to the warehouse**, never to `data/*.json` or the repo, so a slow/failed ingest
can never block the Cloudflare site.

- **Scripts self-locate** via `__dirname/..` → always read/write `ingest/data`
  regardless of cwd. Orchestrator: `ingest/scripts/refresh.js`.
  Warehouse upsert: `ingest/scripts/push-to-supabase.js` (name predates the migration;
  still uses `@supabase/supabase-js`, which is just a PostgREST client — works
  unchanged against the self-hosted backend) → tables `vehicles`,
  `route_snapshots`, `garage_snapshots`, `route_performance`, `tenders`,
  `tender_programme`, `route_vehicle_observations`, `route_vehicle_sightings`,
  **`accidents`** (STATS19 collisions), **`bus_crowding`** (TfL BUSTO per route per
  year — `fetch-crowding.js` streams the BUSTO CSV, conditional-skips when the year
  is unchanged, `pushCrowding()` upserts per `(route_id, busto_year)`), and the
  live-reliability tables (`route_schedule`, `arrival_samples`,
  `route_reliability_daily` — our own EWT/OTD/lost-mileage, see below).
- **Reference mirror (single source of truth).** `ingest/scripts/mirror-reference-data.js`
  (step 20, also `npm run mirror-reference-data`) pulls the reference datasets from our
  own public `/api/v1` (the static store — decoupled from this pipeline's TfL fetchers,
  always the already-validated data) and upserts them into the warehouse so the DB holds
  everything the app does (bar live feeds): `route_stops`, `route_geometry`, `bridges`,
  `crowding_profile` (per BUSTO year), `localities`, `route_diversions` (per episode,
  append-only — doubles as diversion history) (migrations `0023`–`0027`, `0029`). These
  aren't given new `/api/v1/history` endpoints — the same data is already served by the
  current group (`/api/v1/route-stops` etc.); the mirror is a storage sink for
  completeness + future DB-backed reads. Reference data → latest-upsert (with `fetched_at`),
  not dated snapshots; the mutable operational attributes (PVR, propulsion, operator,
  garage, capacity, MPS) are the daily/weekly CDC snapshots in `route_snapshots` /
  `garage_snapshots` / the observation tables, which is what powers fleet-move /
  propulsion-change / PVR-change trend analysis.
- **Schema bootstrap.** `ingest/db/migrations/0001`–`0028` define every table + RLS
  policy; `ingest/db/migrations-bundle.sql` (generated, served statically at
  `/ingest/db/migrations-bundle.sql`) concatenates them for a one-shot `psql -f` against
  a fresh Postgres. PostgREST needs four roles the migrations' `TO anon` policies
  assume but don't create themselves: `authenticator` (its own login role),
  `anon` (read-only), `service_role` (`BYPASSRLS`, full read-write — the ingest
  pipeline's role), `authenticated` (unused today, kept for parity) — bootstrap these
  once via SQL before loading the migrations. The accidents + route_schedule upserts are
  **self-healing** — they strip columns a pending migration hasn't added yet (via each
  push's `optionalCols`) and write the base record, so a new field never blocks the
  ingest. Don't reshape existing tables; add a migration for anything new (`0029+`).
  (Two columns were only ever added by hand on the old Supabase and are now ported as
  migrations: `route_vehicle_observations` anon-read policy in `0022`,
  `route_schedule.timing_point_stop_id` in `0028`.)
- **Schedules — Coolify Scheduled Tasks** (an idle `ingest/Dockerfile` container,
  `docker exec`'d into per cron; replaces the old GitHub Actions workflows of the
  same cadence). Every command goes through `scripts/run-task.sh <name> <cmd…>`,
  which detaches the real work (Coolify's task job has a short hard timeout; the
  sampler/refresh runs are 15–20 min by design), holds a per-name `/tmp` lock
  against overlap, and logs to `/tmp/task-<name>.log`:
  - `npm run refresh` — full refresh, daily 09:23 UTC (daily CDC snapshots per route/garage).
  - `npm run sample-vehicles` — daily fleet sample, 08:37 UTC.
  - `npm run sample-headways` — every ~30 min in service hours; appends live
    arrival/headway observations to `arrival_samples`.
  - `npm run build-reliability` — daily; derives EWT/SWT/AWT, OTD and lost
    mileage into `route_reliability_daily` from the samples + `route_schedule`;
    chains `build-lost-mileage.js` (the daily gross lost-mileage matcher —
    yesterday's tracked trips vs `route_schedule` departures at the timing point
    → `route_lost_mileage_daily`, migration `0031`) and
    `build-reliability-tracked.js` (EWT/OTD **v2** — passing times from the same
    trip log through the pure QSI core `_lib/reliability-tracked.js` →
    `route_reliability_tracked_daily`, migration `0032`; complete observed
    headways, so no sampling bias; coexists with the sampled v1 for calibration
    against TfL's QSI before promotion) and `build-vehicle-assignments.js`
    (per-vehicle DAILY route assignments — one row per (reg, route, day) with
    first/last-seen + trips + km → `vehicle_route_assignments_daily`, migration
    `0033`; catches mid-day reallocations the 08:37 sample can't). All four share
    `_lib/tracking-day.js` loaders and soft-skip when the trip log, warehouse env
    or table is missing.
  - `npm run track-vehicles` — the continuous BODS SIRI-VM collector daemon
    (`track-vehicles.js`): polls the whole-London feed every 25 s, runs each
    vehicle through the trip state machine (`_lib/trip-tracker.js`), appends
    completed trips (each carrying a sparse `wp: [[minute, alongKm]…]` waypoint
    trail for pace-aware passing-time interpolation — the raw material for
    lost-mileage AND the planned tracked EWT/OTD estimate) to
    `data/tracking/trips-<day>.jsonl` + per-operator hourly
    feed-health counts on the `/app/data` volume. Scheduled every 30 min —
    `run-task.sh`'s lock makes firings while the daemon lives a no-op, so the
    cron is a keepalive/restart, not a poller. SIGTERM checkpoints open trips;
    restart within 30 min resumes them. Needs `BODS_API_KEY` in the resource env.
  - No heartbeat job — that existed only because Supabase's free tier auto-paused
    after 7 days with no DB write; self-hosted Postgres never does.
- **Live reliability (our own, supplementing TfL's quarterly figures).** EWT =
  AWT − SWT where AWT/SWT = Σ(h²)/(2·Σh) over observed/scheduled headways; OTD =
  % departures 2 min early–5 min late (low-freq); lost mileage = scheduled − operated
  km. Scheduled side from TfL Timetable (`fetch-schedule.js`); observed side from
  sampling `/Line/{id}/Arrivals` (`sample-headways.js`). Accuracy improves as
  samples accrue and is bounded by sampling frequency — it's an estimate, labelled
  as such; TfL's published `route_performance` remains the authoritative quarterly.
- **Secrets:** `WAREHOUSE_URL`, `WAREHOUSE_SERVICE_KEY` (the service_role-equivalent
  JWT, signed with the PostgREST instance's own `PGRST_JWT_SECRET`), `DVLA_API_KEY`,
  `BODS_API_KEY` (the SIRI-VM collector — same key as the Cloudflare Pages secret),
  and `TFL_APP_KEY` — bridged to the scripts' `BUS_API_KEY` in the task env. Live in
  the Coolify `ingest` resource's environment (the old GitHub Actions workflows are
  deleted; `.github/workflows/` is empty — any equivalently-named repo secrets are
  dead and can be removed). The service key is server-only; never in code or the
  browser. The `atlas-refresh` resource additionally holds `GIT_PUSH_TOKEN` (a
  fine-grained PAT, contents:rw on this repo only) for the static-store data pushes.
- **RLS parity note:** the anon read policies for the history tables live in the
  migrations (`0003`/`0004`/`0006`/`0014`/`0015`/`0020`), and `route_vehicle_recurrence`
  (the RPC `backfill-route-vehicle-sightings.js` calls) is in `0013` — all in the bundle.
  The one policy that was previously a manual Supabase SQL step, `route_vehicle_observations`
  anon read (serves `/api/v1/history/vehicle-sightings`), is now ported as `0022`.
- **Warm caches** (`ingest/data/source/*` — DVLA fleet, tenders, MPS, geocode) persist
  across runs and redeploys on the `atlas-ingest` resource's `/app/data` volume (they
  used to ride `actions/cache` on GitHub), so runs don't cold-pull ~9000 DVLA lookups.
  Everything the pipeline regenerates is gitignored (`ingest/.gitignore`).

## Every datapoint flows through to the warehouse AND the API (no dead ends)

When you add or change a datapoint, field, or dataset, wire it end-to-end so it's
reflected **automatically** everywhere downstream — never just in one place. The
**database is updated first**, then the read layer, then everything that reads it:
**warehouse → `data/*.json` store → `/api/v1` API → app (dossier **and** table view) →
CSV export → docs.** A change that lands in one of these but not the rest is an
**incomplete change** — the standing expectation is that all of them move together.

- **Warehouse first.** A new field is added to the warehouse schema/ingest (the `ingest/`
  subtree → its Postgres table, with a migration for anything new) so the historical
  store carries it before — or alongside — the read layer. The append-only/CDC tables
  are the system of record; never let the app diverge from what the DB can hold.
- **Pipeline → store.** The same field is produced by a `build/<name>.js`, validated, and
  written to `data/*.json` (the prod read layer) and mirrored into the warehouse
  (`db-mirror.js` / the warehouse ingest). If it's time-series, it accrues via CDC.
- **Store → API.** It must be reachable through `/api/v1` — either it rides an existing
  dataset (current group) or it gets a new endpoint. Add it to the prod Pages Function
  **and** the `serve.js` dev mirror (keep them in sync), and list it in the `/api/v1`
  discovery index. Live feeds → `/api/v1/live/*`; warehouse time-series → `/api/v1/history/*`.
- **API → app.** The app reads it via the `dataSource` seam (never a raw inline fetch).
  Surface it in **every** view that should show it — the right-rail dossier **and** the
  canvas **table view** (a new field that belongs in the table is added as a column, not
  just the dossier) — and re-render the affected pane on change.
- **App → CSV export.** The export reflects the *current* view, so any column/field added
  to the table (or dossier export) is added to the CSV writer too — exported rows and the
  on-screen table never drift apart.
- **→ docs.** `README.md` (the public API reference) + this file are updated so the new
  surface is documented. A datapoint that the warehouse holds but the API can't serve, that
  the API serves but the app/table/export don't show, or that nothing documents, is an
  incomplete change.

Net: capture once, expose everywhere — the warehouse, the public API, the app (dossier
**and** table), the CSV export, and the docs stay in lockstep. "Docs" includes the
**`/docs` reference page** (`docs/index.html`, served at atlas.farhan.app/docs and linked
from both apps): the exhaustive per-field contract — meaning, source, processing,
validation, fallbacks, cadence per datapoint. A new/changed field gets a row there too. The default expectation for
any data change is "is it in the database, queryable through `/api/v1`, shown in the app +
table, exported, and documented?"

## Golden rule

One coherent app: every layer and panel section shares the same tokens, components and
shell. Simple chrome, deep analytics on demand. Consistency beats cleverness.

---

## Structure: the three-pane shell

Atlas uses one layout. Do not invent new page shapes.

```
┌───────────────────────────────────────────────────────────┐
│  TOPBAR (52px)  logo/title ········· data status · ⟳ · clock │
├──────────┬──────────────────────────────────┬──────────────┤
│ LEFT     │  CANVAS (center)                  │  RIGHT       │
│ RAIL     │  - header: title + mode toggle    │  CONTEXT     │
│          │  - body: the hero visual / views  │  RAIL        │
│ interactive│                                 │  analysis    │
│ list /   │  (mode switches between 2–3 views)│  readout for │
│ controls │                                  │  the selection│
└──────────┴──────────────────────────────────┴──────────────┘
```

- **Left rail** — the interactive panel: the list you pick from (routes, lines,
  operators) or the controls that drive the tool. Selecting here updates the
  canvas and the right rail.
- **Canvas (center)** — the hero. Each tool's signature visual lives here, with a
  **mode toggle** in the canvas header switching between 2–3 views of the same
  subject.
- **Right rail** — the context panel: the analysis readout for whatever is
  selected (metrics, breakdowns, a contextual alert/insight).

Grid: `grid-template-columns: ~236px 1fr ~320px; grid-template-rows: 52px 1fr;`
fixed `height: 100vh`, panes scroll internally (the page itself doesn't scroll).

### Topbar layout

Left → right: **brand/logo (and tool title)** on the left; a **data-status
cluster pinned to the top right**. The cluster, in order, is:

1. **Last-refreshed badge** — e.g. `Updated 2 min ago` (mono, muted). Shows data
   freshness at a glance; flips to an amber "stale" tone past a sensible threshold.
2. **Manual refresh control** — a small `⟳` `<button type="button">` that re-pulls
   the data, re-renders the panes, and resets the badge. Spin/disable it briefly
   while refreshing; respect `prefers-reduced-motion` (no spin).
3. **Live clock** — `HH:MM:SS`, mono, with the small live dot.

```
[logo  Tool title] ···································  [● Updated 2 min ago] [⟳] [● 14:32:07]
```

Keep it mono and quiet — it's chrome, not a headline. On narrow screens drop the
badge text to just a dot/icon (or hide the clock) before anything wraps; never let
the topbar overflow. Any network KPI readouts a tool wants belong in the right
context rail or the canvas, not crammed into the topbar.

The refresh action is the single, consistent way to update data across every tool
— wire the same `refresh()` that repaints the panes to both this button and any
auto-refresh timer, so manual and automatic refresh share one code path and both
update the badge.

---

## Design tokens (use these — never hardcode colours)

Copy the `:root` block from any existing tool. Canonical values:

```css
/* surfaces */
--ink: #0a0e16;
--ink-2: #0c111b;
--panel: #111725;
--panel-2: #151c2c;
--panel-3: #1a2233;
--line: #1f2a3d;
--line-2: #2a384f;
--line-3: #3a4a66;
/* ink on dark */
--paper: #e7edf6;
--paper-2: #9fb0c8;
--paper-3: #647691;
--paper-4: #3f4d63;
/* data accents */
--amber: #f5a524;
--cyan: #37c5c5;
--violet: #8b7bf0;
--green: #3fb87a;
--alert: #ff5470;
/* motion */
--ease: cubic-bezier(0.4, 0, 0.2, 1);
/* type */
--mono: "SF Mono", …, monospace;
--sans: "Inter", system-ui, …, sans-serif;
```

**Colour meaning (keep it consistent):**

- **Amber** = primary data / the selected thing. **Cyan** = secondary data.
- **Violet / green** = additional categorical accents.
- **Red (`--alert`) is reserved for genuine alerts** — breaches, disruptions,
  danger. Never use it as decoration. (Exception: a tool whose _subject_ is the
  alert, e.g. Sentinel's KSI, may use red as the analytical signal.)

**Type rule:** all quantitative values (times, counts, distances, %) are set in
**`--mono`** — the instrument-readout feel. Prose and labels use `--sans`.

Also tokenise spacing, radii and font-sizes (see the hub's `:root` for a fluid
`clamp()` scale). No magic numbers in component rules.

**Theme-aware tokens.** The values above are the **dark** theme (the default). So
a light theme is a token swap (not a rewrite), define surface/ink tokens under a
theme selector and let every component keep referencing the same variable names:

```css
:root, [data-theme="dark"]  { --ink:#0a0e16; --panel:#111725; --paper:#e7edf6; … }
[data-theme="light"]        { --ink:#f4f7fb; --panel:#ffffff; --paper:#1f2733; … }
```

Components never branch on theme — they only use `--ink`, `--panel`, `--paper`,
etc., so they restyle automatically. The **data-accent hues (amber/cyan/violet/
green/alert) stay constant** across themes (re-tune only if contrast demands it);
their _meaning_ never changes. See _Theming, settings & preferences_.

---

## HTML semantics (required)

- Real landmarks: `<header>` (topbar), `<nav>` or `<aside>` (left rail),
  `<main>` (canvas), `<aside>` (right rail). One `<h1>` per page.
- Lists are `<ul>`/`<li>` (route lists, tool grids) — not stacked `<div>`s.
- The mode toggle is a `role="tablist"` with `role="tab"` buttons and
  `aria-selected`; the views are `role="tabpanel"`.
- Headings in order (h1 → h2 → h3), no skips.
- Buttons are `<button type="button">`; links that navigate are `<a href>`.

## Accessibility (required)

- A skip link to the canvas, first in tab order.
- `lang="en-GB"` on `<html>`; `<meta name="color-scheme" content="dark">`.
- Visible focus: `:focus-visible { outline: 2px solid var(--amber); … }`.
- Decorative SVGs get `aria-hidden="true"`; meaningful ones get a label.
- Respect `@media (prefers-reduced-motion: reduce)` — kill transforms/animation.
- Don't rely on colour alone — pair status dots with text/labels.
- Sufficient contrast for text on `--ink`/`--panel`.
- All meaningful images carry descriptive `alt`; resolve all JS console errors
  before committing.

---

## Responsive

- Fluid type/spacing via `clamp()`; grids via
  `repeat(auto-fill, minmax(min(100%, …), 1fr))` so they reflow without fixed
  breakpoints.
- Collapse panes on small screens the way the tools already do: hide the right
  rail under ~1100px; collapse the left rail into a horizontal scroller on phones.
- **Zero horizontal overflow at any width** (test 320px → 1440px). Cap grid mins
  with `min(100%, …)`; drop non-essential topbar items on narrow screens.

---

## Theming, settings & preferences

User-facing chrome that every tool inherits — build it once, consistently.

- **Theme toggle (dark / light).** A control in the topbar data-status cluster
  (near the clock/refresh) flips `data-theme` on `<html>`. Default to the user's
  OS preference via `@media (prefers-color-scheme)` on first visit, then let their
  explicit choice override. Animate nothing jarring; respect reduced-motion.
- **Settings.** A small settings affordance (gear in the topbar, or a panel) for
  cross-tool preferences. Keep it light — only genuinely useful options:
  - **Units & formats** — distance (km/mi), time (24h/12h, minutes vs `mm:ss`),
    currency display, date format (default en-GB). Tools format via these, never
    hardcode a unit.
  - **Data refresh mode** — cached (read our static store) vs live (re-pull from
    TfL + the live-positions Pages Function), with the live-interval countdown.
  - **Default view / home tool**, density (comfortable/compact) if useful, and
    the theme.
  > **Dropped:** "Preferred operator" was removed — not worth its weight in
  > Atlas. Don't reintroduce it without a concrete cross-tool use.
- **Persistence.** Preferences persist across sessions and are **shared across
  all tools** (one settings object, one storage key) so the suite feels unified —
  set your units/theme once, every instrument respects it. Read settings at startup
  before first render; re-render on change.
- **Apply, don't decorate.** A preference must actually change behaviour: units
  reformat every value, clock format re-renders the time, theme restyles via
  tokens. A setting that does nothing is worse than no setting.
- **Accessibility & tokens.** Toggle/controls are real `<button>`s with state
  (`aria-pressed`), keyboard-operable, focus-visible; both themes must meet
  contrast. Settings UI reuses the existing token/component styling.

> Sandbox note: artifact/sandbox storage rules vary — if `localStorage` isn't
> available in a given runtime, fall back to in-memory settings for the session
> and document it, rather than letting persistence throw.

## Build conventions

- **Single self-contained `.html` per tool** — inline `<style>` and `<script>`,
  no build step, no external CSS/JS frameworks.
- Vanilla JS. Keep state in plain variables; re-render the affected pane on change.
- A small `#tip` tooltip is standard (copy from a tool). The topbar clock,
  refresh button and last-refreshed badge are standard too — see _Topbar layout_.
- SVG gotcha: a global `svg:not([width]){width:1em;height:1em}` keeps inline icons
  sane, **but large data SVGs (viewBox-only) must override it** — give them a
  class with `width:100%!important` (and explicit height) or they collapse to 1em.
- **External map tiles (Leaflet/OSM)** are the one allowed CDN dependency (Atlas,
  Radius). Dark-theme the tiles with a CSS filter; provide a graceful offline
  fallback message so the tool never looks broken without a network.
- Placeholder data is fine for design phases — keep it in a clear data block at
  the top of the script, structured the way the real feed will arrive, so wiring
  live data later is a swap not a rewrite. See `data_sources.xlsx` for the feeds.

## Data sources

- **Official TfL APIs first.** Where TfL publishes it, use the TfL Unified API
  (`api.tfl.gov.uk`) as the primary source — it's the authoritative feed for
  London bus data. Reach for third-party / commercial / community sources only
  when TfL doesn't cover the need. `data_sources.xlsx` lists what's available and
  ranks the official options; prefer the ones flagged official/open.
- **Document the source per tool.** At the top of each tool's data layer, note
  which endpoint(s) feed it and at what cadence (see the _Output_ column in
  `data_sources.xlsx`) so polling matches the source — don't hammer a 30s-cached
  feed every second.
- **Handle fallbacks gracefully.** A source can be down, rate-limited, key-less,
  or (in-sandbox) network-blocked. Never let the tool look broken:
  - degrade in tiers — live API → last cached good response → clearly-labelled
    placeholder/sample data;
  - show the state honestly in the last-refreshed badge (e.g. "stale — showing
    cached" / "offline — sample data"), don't silently fake it;
  - the map-tile offline fallback (Atlas/Radius) is the reference pattern;
  - a failed refresh keeps the previous data on screen and surfaces the error
    quietly, rather than blanking the panes.

### Approved source catalogue (from `data_sources.xlsx`)

The full set of sources approved for Atlas, mirrored from `data_sources.xlsx`
(that spreadsheet stays the master; keep this in sync when it changes). Prefer
sources **top-down within each category** — official/open before commercial/
community. **TfL Unified API is always first** where it covers the need.

**Access legend:** 🔵 TfL/official (key optional) · 🟢 open/free · 🟠 commercial
(vendor-defined) · ⚪ community. **Output legend:** 🔴 live · 🟡 periodic ·
🔵 scheduled release · ⚫ static/reference. ⚠️ = an access gotcha (JS-rendered,
gated, PDF-only) — see the note.

#### Standards & feed formats (the backbone)
- **SIRI-VM** 🟢 ⚫ — EU real-time vehicle-position standard (all England AVL is SIRI-VM v2.0; 10–30s). The wire format our live GPS speaks. https://www.gov.uk/government/publications/technical-guidance-publish-bus-open-data
- **SIRI-SX / SIRI-ET** 🟢 ⚫ — Situation Exchange (disruptions) + Estimated Timetable (predicted arrivals). https://www.siri-cen.eu/
- **GTFS / GTFS-RT** 🟢 ⚫ — global schedule (static) + real-time format. https://gtfs.org/
- **TransXChange (TXC)** 🟢 ⚫ — UK-native XML timetable format; what BODS timetables ship in. https://www.gov.uk/government/collections/transxchange
- **NeTEx** 🟢 ⚫ — EU timetable/fare/topology standard. https://netex-cen.eu/
- **BODS Operator Requirements** 🟢 ⚫ — the legal publishing spec. https://publish.bus-data.dft.gov.uk/guidance/operator-requirements/

#### Real-time bus operations (core TfL) — **primary**
- **TfL Unified API** 🔵 🔴 — buses/Tube/rail status, disruptions, timetables, journey planning. The central layer. https://api.tfl.gov.uk/ · register https://api-portal.tfl.gov.uk/
- **TfL Vehicle Location (via Unified API)** 🔵 🔴~30s — approximate live bus GPS. `/Vehicle/{ids}/Arrivals`
- **TfL Live Bus Arrivals** 🔵 🔴 30s-cached — stop-level predictions (no gain polling faster). `/StopPoint/{id}/Arrivals`
- **TfL Countdown** 🔵 🔴 — low-latency stop arrivals (now via Unified API). `/StopPoint/{id}/Arrivals`
- **TfL StopPoint** 🔵 ⚫ — stop metadata (location, routes, platforms). `/StopPoint/`
- **TfL Line & Route** 🔵 ⚫ — route geometry + service patterns. `/Line/{id}/Route`
- **TfL Road API / JamCams** 🔵 🔴 — congestion/closures/incidents + 900+ traffic cams (still + 5s video). `/Road/` · `/Place/Type/JamCam`
- **TfL iBus data portal** 🔵 🟡 — bulk iBus file drops. ⚠️ directory index is JS-rendered; individual files fetch directly. https://ibus.data.tfl.gov.uk/

#### Train / Tube / rail live
- **TfL Unified API (Rail module)** 🔵 🔴 — Tube/DLR/Overground status + arrivals. `/Line/Mode/tube,dlr,overground/Status`
- **TfL Line Status** 🔵 🔴 — service status per line. `/Line/{id}/Status`
- **National Rail Darwin** 🔵 🔴 — live train arrivals/delays. ⚠️ gated behind Rail Data Marketplace registration. https://raildata.org.uk/
- **Network Rail Open Data** 🔵 🔴/🟡 — movements/TD/SCHEDULE. ⚠️ STOMP/HTTP, not browser-fetchable; free registration. https://datafeeds.networkrail.co.uk/
- **TrackerNet** 🔵 🔴 — detailed rail movement (limited exposure).

#### Live disruption & delay alerts (buses + rail)
- **TfL Line Status — all modes incl. bus** 🔵 🔴~30s — statusSeverity 0–14 + reason. The core delays feed. `/Line/Mode/bus/Status` · `/Line/{ids}/Status`
- **TfL Line Disruptions** 🔵 🔴 — active disruptions w/ affected stops + description. `/Line/Mode/bus/Disruption`
- **TfL StopPoint Disruptions (bus)** 🔵 🔴 — closed/blocked bus stops. `/StopPoint/Mode/bus/Disruption`
- **TfL Line Status by date (planned)** 🔵 🔴 — forward-dated closures/engineering. `/Line/{ids}/Status/{start}/to/{end}`
- **National Rail Darwin / Knowledgebase** 🔵 🔴 — rail disruption context. ⚠️ RDM/NRDP registration.
- **BODS / SIRI-SX (national bus disruption)** 🟢 🔴 — cross-operator disruption where published. https://data.bus-data.dft.gov.uk/

#### National bus data (outside TfL)
- **Bus Open Data Service (BODS)** 🟢 mixed 🔴/🟡 — UK-wide timetables, live location (~10s) & fares. We're a publisher too. https://data.bus-data.dft.gov.uk/
- **NaPTAN** 🟢 🟡 — national stop database (IDs, coords). https://naptan.api.dft.gov.uk/swagger/index.html
- **NPTG** 🟢 🟡 — national locality hierarchy. https://www.gov.uk/government/publications/national-public-transport-gazetteer
- **TransportAPI** 🟠 🔴 — managed UK transport JSON (turnkey). https://www.transportapi.com/
- **bustimes.org** ⚪ 🔴+⚫ — live tracking + community fleet/route/operator history; open REST API
  (`/api/vehicles/?reg=`) is the per-vehicle BODY/type + fleet-code source in the vehicles
  enrichment chain (DVLA first → bustimes fills body/deck/fleetCode + corrects DVLA's hybrid
  misreports → londonbusroutes route-level spec). One lookup per reg ever, cached in
  `data/vehicle-body-cache.json`. https://bustimes.org/
- **LVF (London Vehicle Finder)** ⚪ 🔴 — login-gated vehicle *finder* built on TfL location data
  (where a vehicle is / route history); NO make/body register, and the finder capability is
  native to Atlas (`vehicles` + `history/vehicle-sightings`). Not a source; contact
  lvf_help@hotmail.com if an arrangement is ever wanted. https://lvf.io/

#### Route-type classification (night / school / 24h / express)
- **Night service** — TfL Line API `serviceTypes` (the only explicit machine-readable type field). `/Line/Route/Sequence/{dir}?serviceTypes=night`
- **24-hour route** — derived (both Regular + Night with continuous coverage); not a flag.
- **School / term-time** — TXC (via BODS) restricted operating profiles; TfL school routes ~6xx/9xx.
- **Day-of-week / special-day variants** — TXC `OperatingProfile` + `SpecialDaysOperation`.
- **High- vs low-frequency** — derived from headway (≥5 buses/h = high-freq, EWT-measured).
- **Express / limited-stop / Superloop** — branding/naming convention; tag yourself from route number.

#### Tendering, contracts & operator intelligence
- **TfL "Who runs your bus"** 🟢 ⚫ — contracting model + current operators. https://tfl.gov.uk/modes/buses/who-runs-your-bus
- **TfL Bus Tender Results** 🟢 🟡 — per-route tender winners. ⚠️ JS-rendered .aspx — use FTS/Contracts Finder OCDS for structured data. https://tfl.gov.uk/forms/13923.aspx
- **TfL Annual LBSL Tendering Programme** 🟢 🔵 annual (Sept) — forward schedule, issue/return/award dates, PVR. ⚠️ PDF-only. https://tfl.gov.uk/cdn/static/cms/documents/uploads/forms/2026-2027-lbsl-tendering-programme.pdf
- **TfL Bus Operator League Tables** 🟢 🔵 quarterly — operator reliability ranking. https://tfl.gov.uk/corporate/publications-and-reports/bus-operator-league-tables
- **Find a Tender (FTS)** 🟢 🔴+🟡 — OCDS JSON API + bulk; TfL notices carry CPV 60112000. https://www.find-tender.service.gov.uk/
- **Contracts Finder** 🟢 🔴+🟡 — lower-value + early-engagement notices; OCDS API. https://www.contractsfinder.service.gov.uk/
- **OCDS bulk (data.gov.uk)** 🟢 🟡 daily — full-history contract analysis. https://www.data.gov.uk/search?q=contracts+finder
- **Bidstats** ⚪ 🟡 — procurement-notice aggregator. https://bidstats.uk/tenders/?q=tfl
- **Bus Routes in London Wiki — tender history** ⚪ ⚫ — crowd-sourced cross-check. https://bus-routes-in-london.fandom.com/wiki/Tender_history_results_for_TFL

#### Competitor financials & corporate intelligence
- **Companies House API** 🔵 🟡 — filings, accounts, officers, PSC. ⚠️ accounts are iXBRL/PDF (~40% structured). https://developer.company-information.service.gov.uk/
- **Companies House bulk product** 🟢 🟡 — full register + iXBRL accounts. https://www.gov.uk/government/publications/companies-house-accounts-data
- **TfL Expenditure over £250** 🟢 🔵 4-weekly — payments to operators (QIC context). https://tfl.gov.uk/corporate/publications-and-reports/expenditure-over-250
- **Operator group annual reports / RNS** 🟢 🔵 — listed parents' segment results. https://www.londonstockexchange.com/news
- **GLA Group / TfL transparency** 🟢 🟡 — board papers, business plan, budget. https://tfl.gov.uk/corporate/publications-and-reports/

#### Regulatory & licensing
- **VOL Operator Licence Records (DVSA, data.gov.uk)** 🟢 🟡 weekly — operator/licence/operating-centre/authorised-fleet ceiling. CKAN API. https://www.data.gov.uk/dataset/2a67d1ee-8f1b-43a3-8bc6-e8772d162a3c/
- **Find lorry or bus operators** 🟢 🔴 — human VOL search front-end. https://www.gov.uk/find-vehicle-operators
- **Find registered local bus services** 🟢 🔴 — service-registration records. https://www.gov.uk/find-local-bus-services
- **DVSA VOL statistical dataset** 🟢 🔵 — licence application stats. https://open.data.dvsa.gov.uk/vehicle-operator-licensing/index.html

#### Vehicle telematics, EV & depot (all 🟠 vendor-defined, 🔴 live)
- **Geotab** — engine/EV diagnostics, SoC, driver behaviour; open API. https://developers.geotab.com/
- **ChargePoint** — charging-station mgmt, battery, fault codes. https://www.chargepoint.com/fleet/telematics
- **Volteum** — hardware-free fleet view (mileage, battery, charging cost). https://www.volteum.io/
- **INIT** — next-gen AVL/CAD; TfL's iBus successor. https://www.initse.com/

#### Scheduling, crew & rostering (🟠 vendor software)
- **HASTUS (GIRO)** — scheduling/run-cutting/rostering (industry standard). https://www.giro.ca/en/our-solutions/hastus-software/
- **Optibus** — AI blocking/runcutting/rostering; GTFS/TXC import. https://optibus.com/product/scheduling/
- **Trapeze** — end-to-end planning → dispatch → control. https://www.trapezegroup.co.uk/
- **Academic optimisation literature** 🟢 ⚫ — open solver formulations. https://arxiv.org/pdf/2310.13425

#### Traffic, roadworks & incidents
- **Street Manager (DfT)** 🔵 🔴+🟡 hourly — every planned/active street work in England; Open Data API + GeoJSON. The key roadworks source. https://www.gov.uk/guidance/find-and-use-roadworks-data
- **TfL Live Traffic Disruptions** 🔵 🔴 — London control-centre incident feed. `/Road/all/Disruption` · https://data.london.gov.uk/dataset/tfl-live-traffic-disruptions-248xn/
- **TfL Road Disruptions API** 🔵 🔴 — events + planned works up to 12 months out. `/Road/all/Disruption`
- **TfL Live Roadside Message Signs** 🔵 🔴 — VMS location + live message.
- **National Highways API** 🔵 🔴 — motorway/SRN incidents. https://api.data.nationalhighways.co.uk/
- **UK Power Networks Live Faults** 🟢 🔴 — London DNO power-cut feed (signal outages, charger loss). https://ukpowernetworks.opendatasoft.com/explore/dataset/ukpn-live-faults/
- **National Grid / DNO power-cut feeds** 🟢/🟠 🔴 — outside UKPN footprint. https://powercuts.nationalgrid.co.uk/
- **INRIX / TomTom / HERE Traffic** 🟠 🔴 — vendor traffic speed + routing. (docs.inrix.com · developer.tomtom.com · here.com)
- **DfT Road Traffic Counts** 🟢 🔵 annual — AADF volumes by count point. https://roadtraffic.dft.gov.uk/
- **TfL roads open-data host** 🔵 🟡 — bulk road/network files. ⚠️ JS-rendered index; files fetch directly. https://roads.data.tfl.gov.uk/

#### Bridge clearances & strike avoidance
- **TfL/OS London Bridge Height Restrictions** 🟢 🔵 annual — 877 low bridges (CSV). Primary London source. ⚠️ Datastore landing JS-rendered; CSV downloads directly. https://data.london.gov.uk/dataset/bridges-tunnels-road-barriers-height-restrictions-epowr/
- **Network Rail Bridge Strike Data** 🟢 🟡 — 5,000+ rail bridges + strike frequency. https://www.networkrail.co.uk/.../prevention-of-bridge-strikes/
- **OpenStreetMap maxheight** 🟢 🟡 — crowd-sourced clearance tags (incomplete). https://wiki.openstreetmap.org/wiki/Bridge_heights_in_the_United_Kingdom
- **Low Clearance Map** 🟠 🟡 — commercial clearance dataset + routing API. https://lowclearancemap.com/

#### PCN enforcement & camera locations
- **London Councils — Enforcement & Appeals stats** 🟢 🔵 annual — authoritative London-wide PCN volumes per borough by contravention. https://www.londoncouncils.gov.uk/services/parking-services/enforcement-and-appeals-statistics
- **Barnet Parking PCN Dashboard (exemplar)** 🟢 🟡 — per-PCN street-level open data; FOI template for other boroughs. https://open.barnet.gov.uk/dataset/24r8e/parking-pcn-dashboard
- **Borough open-data portals** 🟢 mixed — per-borough extracts. ⚠️ patchy; some need FOI.
- **London Tribunals** 🟢 🔵 — PCN appeals/adjudication outcomes. https://www.londontribunals.gov.uk/
- **London Datastore — Safety Camera Data** 🟢 ⚫ — fixed/avg-speed/red-light sites + KSI. ⚠️ free Datastore login required. https://data.london.gov.uk/dataset/safety-camera-data-london
- **London Datastore — CC ANPR captures** 🟢 🔵 monthly — ANPR activity (not locations). ⚠️ Datastore portal.
- **PhotoEnforced — London** ⚪ 🟡 — crowd camera locations (verify). https://www.photoenforced.com/London.html
- **Commercial UK speed-camera datasets** 🟠 🟡 — national coverage (sat-nav providers).
- **TfL JamCams** 🔵 🔴 — 900+ traffic cams (still + video), monitoring only. `/Place/Type/JamCam`
- **TfL Live Traffic Cameras (Datastore)** 🟢 🔴 ≥3min — curated 177-site set. ⚠️ Datastore portal. https://data.london.gov.uk/dataset/tfl-live-traffic-cameras-2kmnd

#### Bus positioning / ETA prediction (concept layers — build, not feeds)
Vehicle GPS feed · arrival prediction (Countdown) · interpolation engine · map
snapping (OSM) · confidence scoring · diversion detection. These are pipeline/
render concepts layered on the live feeds above, not external sources.

#### Weather & environmental
- **Met Office Weather DataHub** 🔵 🔴 — UK forecasts/obs/alerts. https://datahub.metoffice.gov.uk/
- **OpenWeather** 🔵 🔴 — hyperlocal current + forecast. https://openweathermap.org/api
- **Environment Agency Flood-Monitoring** 🟢 🔴 ~15min — flood warnings/levels; OGL, no registration. https://environment.data.gov.uk/flood-monitoring/doc/reference
- **London Air Quality (Imperial / LAQN)** 🟢 🔴 hourly — pollution levels. https://www.londonair.org.uk/LondonAir/API/

#### Mapping & geospatial
- **postcodes.io** 🟢 🔴 — open UK postcode geocoder (lat/lng + BNG); self-hostable, no rate limit. The open Google-Geocoding substitute (already used). https://postcodes.io/
- **OS Places API** 🔵 🔴 — authoritative building-level addresses (PAF/AddressBase). https://osdatahub.os.uk/docs/places/overview
- **getthedata** 🟢 🔴 — fallback postcode geocoder. https://www.getthedata.com/postcode
- **Doogal** 🟢 🟡 — UK postcode/geo data + bulk. https://www.doogal.co.uk/Postcodes
- **OpenStreetMap** 🟢 🟡 — road network + POIs; Geofabrik GB extract. The allowed map-tile CDN dep. https://download.geofabrik.de/europe/great-britain.html
- **Ordnance Survey APIs** 🔵 🟡 — high-precision UK mapping (OS Data Hub). https://osdatahub.os.uk/
- **Google Maps Platform** 🔵 🔴 — geocoding + routing (vendor). https://developers.google.com/maps/documentation
- **Mapbox** 🔵 🔴 — map rendering engine (vendor). https://docs.mapbox.com/

#### Demand, passenger flow & analytics
- **TfL Station Crowding API** 🔵 🔴 ~5min — Tube busyness as % of historical peak. ⚠️ relative %, not absolute counts. `/Crowding/{naptan}/Live`
- **Oyster / Contactless aggregated** 🔵 🔵 — boarding patterns. https://tfl.gov.uk/info-for/open-data-users/our-open-data
- **TfL RODS** 🟢 🔵 annual — Underground origin-destination flows.
- **DfT daily bus passenger stats** 🟢 🟡 — faster-indicator patronage. https://www.gov.uk/government/statistics/transport-use-during-the-coronavirus-covid-19-pandemic
- **DfT Annual Bus Statistics** 🟢 🔵 annual — patronage/mileage/fares/fleet by operator. https://www.gov.uk/government/collections/bus-statistics
- **Analyse Bus Open Data (DfT)** 🟢 🟡 — BODS feed-quality dashboards. https://analyse.bus-data.dft.gov.uk/
- **ONS commuting / O-D datasets** 🟢 ⚫ — travel-to-work patterns. https://www.ons.gov.uk/census
- **Mobile mobility data (O2 Motion)** 🟠 🟡 — anonymised movement trends. https://www.o2.co.uk/business/solutions/o2-motion
- **Google Places — Popular Times** 🔵 🔴 — footfall/busyness (vendor).

#### Network, accessibility & wider context (TfL & GLA)
- **TfL Journey Planner API** 🔵 🔴 — multi-modal routing + PAYG fares. `/Journey/JourneyResults/{from}/to/{to}`
- **TfL Step-Free / Accessibility (Pathfinder, GTFS)** 🟢 🟡 — station topology + step-free.
- **TfL Walking Routes** 🟢 ⚫ — station-to-station walk times.
- **TfL Santander Cycles** 🔵 🔴 — live docking availability. `/BikePoint`
- **TfL Car Park occupancy** 🔵 🔴 — LU car-park spaces. `/Occupancy/CarPark`
- **TfL Licensed Private Hire / Findaride** 🔵 🟡 — PHV/taxi operator data.
- **GLA Road Network boundary (TLRN)** 🟢 ⚫ — TfL-vs-borough road control. ⚠️ Datastore; files download directly.
- **London Datastore** 🟢 mixed — GLA central open-data portal; CKAN API + direct resource URLs. ⚠️ portal pages JS-rendered. https://data.london.gov.uk/
- **LAEI (emissions inventory)** 🟢 ⚫ — pollutant concentration per 20m. https://data.london.gov.uk/dataset/london-atmospheric-emissions-inventory--laei--2019

#### Compliance, safety & statutory reporting
- **TfL Surface Transport performance metrics** 🔵 🔵 — EWT/OTP + QIC measures. https://tfl.gov.uk/corporate/publications-and-reports/buses-performance-data
- **TfL Bus Safety Data / collisions** 🟢 🔵 quarterly — Vision Zero + STATS19 dashboard. https://tfl.gov.uk/corporate/publications-and-reports/bus-safety-data
- **DfT STATS19 road casualty data** 🟢 🔵 annual — national collision records + factors; bulk via data.gov.uk. https://www.gov.uk/government/collections/road-accidents-and-safety-statistics
- **HSE RIDDOR statistics** 🟢 🔵 annual — workforce injury benchmarking. https://www.hse.gov.uk/statistics/
- **HSE enforcement / prosecutions** 🟢 🟡 — safety-compliance register. https://resources.hse.gov.uk/convictions/
- **BODS publishing obligations** 🟢 🔴 — statutory publish duty. https://publish.bus-data.dft.gov.uk/
- **Bus dwell-time analytics** 🟢 ⚫ — dwell from AVL/iBus (method reference).

#### Bus performance & reliability (EWT / OTP / QSI)
- **TfL Buses Performance Data (hub)** 🟢 🔵 — methodology + headline trends. https://tfl.gov.uk/corporate/publications-and-reports/buses-performance-data
- **TfL Route-level Results (current + archive)** 🟢 🔵 — per-route EWT/SWT/AWT + long-gaps. ⚠️ search form JS-rendered; PDF host fetches directly (table extraction needed). https://tfl.gov.uk/forms/14144.aspx · https://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf
- **TfL Bus Operator League Tables** 🟢 🔵 quarterly — operator ranking.
- **TfL Quality of Service Indicators (QSI)** 🟢 🔵 quarterly — passenger-scored quality.
- **TfL Bus Speeds data** 🟢 🔵 — average bus speeds (diagnoses EWT cause).
- **London Datastore — Public Transport Journeys by Mode** 🟢 🔵 — bus journeys per period. ⚠️ file downloads directly.
- **London Datastore — Bus Use & Supply Data** 🟢 ⚫ — annual journeys/km/subsidy per route. ⚠️ gated; free login required.
- **London Datastore — bus tag** 🟢 mixed — faceted search of all bus datasets. ⚠️ JS-rendered search.
- **Mayor's Questions / London Assembly answers** 🟢 🟡 — deep-dive perf answers; directly fetchable. https://www.london.gov.uk/who-we-are/what-london-assembly-does/questions-mayor/find-an-answer
- **FOI archive (WhatDoTheyKnow)** ⚪ ⚫ — granular EWT FOI responses + FOI template. https://www.whatdotheyknow.com/body/tfl

#### Formal calculations & definitions (TfL methodology — reference, not feeds)
SWT = Σ(hₛ²)/(2·Σhₛ) · AWT = Σ(hₐ²)/(2·Σhₐ) · **EWT = AWT − SWT** (each route
has an MPS benchmark) · AWT:SWT ratio · P(wait > x) · Long Gaps = P(wait > 4×SWT).
OTP/OTD · early/non-arrival. Contract model: TfL keeps fares, pays operator a fee
(from 2000–01); bonus/deduction vs benchmark (EWT high-freq, OTP low-freq);
lost-mileage deductions (in-control only); 5yr + up-to-2yr extension. PVR (Peak
Vehicle Requirement), scheduled/operated km, dead mileage, MDBF, MPS. **PVR
sources:** tender award notices (authoritative, frozen at award) · LBSL programme
(forward) · own/published TXC schedule (block-count — operationally true now) ·
londonbusroutes.net/bustimes.org (community cross-check) · GLA/Mayor's Questions
(network total only).

#### Open-source toolkit (build, not buy — software, 🟢)
awesome-transit (catalogue) · GTFS-RT↔SIRI-Lite converters · TransitClock (ETA
prediction) · particle/Kalman models · gtfs-realtime-validator · gtfs-mcp (LLM
query layer) · OpenTripPlanner · Apache Kafka · MQTT (Mosquitto) · PostgreSQL +
PostGIS · Grafana · Prometheus. (See `data_sources.xlsx` for links.)

#### London-specific community & reference (⚪, last-resort cross-checks)
- **londonbusroutes.net (Ian Armstrong)** ⚫ — route histories, operators & **garage allocations** (already a pipeline source). http://www.londonbusroutes.net/index.htm
- **London Omnibus Traction Society (LOTS)** 🟡 — fleet/vehicle movements. https://www.lots.org.uk/
- **TfL Bus Consultations** 🟡 — open service consultations. https://haveyoursay.tfl.gov.uk/
- **Bus Routes in London Wiki (Fandom)** ⚫ — crowd-sourced route info.
- **londonbuses.co.uk** ⚫ — general reference.

> **Atlas wiring today** (where these feed the live app): TfL Unified API (Line/
> Route/StopPoint/Status/Disruption/Arrivals) · **TfL iBus static drops**
> (`ibus.data.tfl.gov.uk` — a public S3 bucket of dated fortnightly schedule
> releases; `sources/ibus.js` reads `Route_Geometry_<ver>.zip` as the dated,
> immutable pre-diversion baseline archive for build/diversions.js recovery;
> `pipeline/check-sources.mjs` is the reproducible health sweep of every source
> here) · BODS SIRI-VM (live GPS, via the
> Pages Function) · postcodes.io + OSM tiles · DVLA VES (fleet enrichment) ·
> londonbusroutes.net (garages) · TfL tender pages + LBSL programme (Mandate). The
> rest of the catalogue is approved for future layers — add via the seam + a
> `pipeline/build/<name>.js`, documenting the endpoint + cadence as above.

### Data access layer (future-proof for a database)

Today each tool is a **live JS app calling the API directly**. A backing
**database** is planned (ingest the feeds once, serve the tools from our own
store). Write the data layer now so that switch is a swap, not a rewrite:

- **Put all data access behind one seam per tool** — a small module/object (e.g.
  `dataSource` with `fetchRoutes()`, `fetchRoute(id)`, …) that returns
  normalised, tool-shaped data via Promises (`async`). UI/render code calls the
  seam **only** — never `fetch()` a TfL URL inline in a component.
- **Normalise at the boundary.** The seam maps the raw API response into the
  tool's own data shape (the same shape the placeholder block already uses). Tools
  render the normalised shape, so the upstream source can change underneath them.
- **Make the backend swappable by config**, not by editing tools: a single place
  that points the seam at `tfl` (direct API) or `db` (our store). Same method
  signatures, same returned shapes → flipping the source is one line. Design the
  DB read API to mirror these method shapes.
- **Async everywhere, even now.** Treat direct API calls as async from day one
  (loading states, error handling, the graceful-fallback tiers above) so adding a
  DB/cache layer introduces no new control flow.
- **Keep the contract documented.** For each seam method note: which TfL endpoint
  backs it today, the normalised shape it returns, and the cadence — that doc
  becomes the spec for the DB ingest + read layer later.

> Net: components depend on _our_ data shape via the seam, never on TfL's wire
> format or on where the bytes come from. API-direct now, DB-backed later, with
> the tools unchanged.

### Pipelines, ingestion & automation

When we gather data — API pulls, file downloads, or **scraping** the JS-rendered /
PDF / gated sources flagged in `data_sources.xlsx` — the pipeline must be
**robust, optimized, and gracefully degrading**. These run unattended in future
(GitHub Actions, cron, or a scheduled job), so they fail safely on their own.
The pipeline shape is explicit and isolated per step: **Fetch → Clean → Validate
→ Store → Serve.**

- **Prefer the cleanest source.** Official API → bulk open dataset / CKAN → file
  download → scrape. Scraping is the **last resort**, only for sources with no
  machine-readable feed; check terms/robots and keep within them.
- **Robust by default:** timeouts on every request; retries with exponential
  backoff + jitter (1–2 attempts for transient failures); treat any single source
  as fallible. One source failing must not abort the whole run or corrupt the
  store. Prevent overlapping/concurrent executions.
- **Graceful fallback / degrade:** on fetch failure keep the **last good data**
  (don't overwrite a good record with an error or empty); mark records with
  `fetched_at` + status so staleness is visible downstream (feeds the tools'
  "stale/cached" badge). Partial success is success — persist what you got, but
  never store a _partial dataset_ where a whole-dataset swap is expected.
- **Optimized & polite:** match poll cadence to the source's real refresh (the
  _Output_ column — don't re-pull a quarterly PDF hourly); use conditional
  requests (ETag / If-Modified-Since) and incremental/delta fetches — skip
  processing entirely if the source hasn't changed; cache; dedupe; respect rate
  limits and back off on 429/5xx.
- **Clean before it lands.** Treat all scraped/fetched data as untrusted input:
  strip HTML by default (allow specific tags only if required); decode and
  standardise to UTF-8; trim whitespace and remove invisible/control characters;
  coerce to strict types (number, boolean, ISO date) and validate formats
  (dates, URLs, numeric ranges). Never pass raw scraped content into the DOM, and
  never execute scripts from scraped content. Validate outbound links before
  exposing them.
- **Shape into a stable schema.** Transform into a consistent internal schema with
  stable field names; apply defaults for missing values; reject malformed or
  incomplete records early. Don't rely on upstream HTML structure — if selectors
  fail or return empty, return a safe fallback state and **log the structural
  mismatch**, don't break the UI.
- **Validate before it lands (hard gate)** (ties to _Validation_): schema /
  row-count / sanity checks on ingested data; quarantine or reject bad batches
  rather than poisoning the store; alert on anomalies (row count cratered,
  all-nulls, totals don't reconcile). **If new data fails validation, retain the
  last known good dataset and log the failure** — treat validation as a hard gate,
  not a warning.
- **Idempotent & re-runnable:** a re-run produces the same end state (upsert on a
  stable key, no dupes); safe to retry after a crash. Checkpoint long runs so a
  failure resumes rather than restarts. Keep execution time predictable and within
  platform limits (e.g. GitHub Actions job timeouts).
- **Automation-ready & observable:** parameterised (no hardcoded secrets — keys
  via env/secrets), structured logging, a clear exit code and run summary
  (fetched / updated / skipped / failed) so a scheduled job surfaces health.
  Scrapers that drive a headless browser are heavier — schedule accordingly and
  keep them isolated from the light API pulls.
- **Decoupled from the app.** Pipelines write to the store; tools read via the
  seam. The two never share a code path — a slow/failed scrape never blocks a
  tool render (the tool just shows its last-good/cached state). **Never rely on
  live scraping for a user-facing request** — always serve pre-processed,
  validated data.
- **Scraping security & observability:** scraping (where unavoidable) runs only in
  pipeline scripts, never at runtime or from the browser; never expose scraping
  targets, selectors, or parsing logic in frontend code. Log failed requests,
  empty selector results, and validation failures — minimal but actionable.

## Validation (always)

Every tool must be checked so that **what's on screen provably matches the source
data** — not just "it renders". Don't trust a screenshot alone.

- **Use multiple methods**, whichever fits: a headless browser (Puppeteer /
  Playwright) to drive the UI and read back the rendered DOM; **Node or Python**
  to fetch the same source data independently and compare; unit-level checks on
  the transform/aggregation functions.
- **Cross-check rendered ↔ source.** Pull the figure shown in a cell/label via
  the headless browser, fetch the same figure straight from the API (or the
  fixture), and assert they agree. Spot-check several values, edge cases, and at
  least one per view/mode.
- **Verify interaction:** selecting in the left rail updates canvas + right rail;
  mode toggle swaps views; filters/inputs change the result set correctly;
  refresh re-pulls and updates the badge.
- **Verify integrity, not just presence:** no console errors / page errors; large
  data SVGs have real width (the 1em-collapse trap); no horizontal overflow
  320–1440px; numbers reconcile (parts sum to totals, sorts are ordered, units
  correct).
- Keep validation **reproducible** — a script per tool that can be re-run each
  phase, against fixtures where live APIs aren't reachable.

## Export & import

- **CSV export of the current view** — every tool offers it. Export reflects the
  _current_ state (selected entity, active filters, mode) — what the user sees is
  what they get. UTF-8, quoted fields, sensible headers/filename
  (`headway_route-73_2026-06-17.csv`). Plain client-side Blob download, no deps.
- **Import / user input where it makes sense** — an import button to bring in a
  CSV/dataset the tool then analyses (validate and report bad rows; never fail
  silently). Treat imported data as a first-class source alongside the API feed.
- **Inline table editing where it makes sense** — editable cells that update the
  model and re-render dependent views/visuals live. Keep edits in the in-memory
  model; pair with export so the user can save their adjusted dataset back out.
- Keep all of this within the existing tokens/components — an export control sits
  in the canvas header or right rail in the same button style; edit affordances
  reuse the tool's input styling.

## Naming & structure

- The app is **Atlas**, served at `index.html`. The old per-instrument names
  (Headway/Mandate/Cohort/Sentinel/Relay) now refer to **layers/sections** inside Atlas,
  not separate pages — render them as in-tool references, never cross-page links.
- Archived suite + old hub: `archive/`. If a layer ever needs to spin out into its own
  page again, keep the render helpers/`dataSource` seam modular so it lifts out cleanly.
- **`v2/index.html` (served at `/v2`) is a deliberate alternate design** — a "Route Lens"
  full-bleed-map shell with floating glass control/context cards (collision & incident
  density along a route corridor, with a draggable lens), reading the same `/api/v1`
  (STATS19 collisions + low bridges) and TfL (routes/geometry). Its Layers card includes a
  **"TfL print style"** toggle — a consultation-map look (light label-free voyager base,
  white-cased per-route colour lines with route-number lozenges, spaced-caps place names,
  paper Key card listing each route's termini; `data-mapstyle="print"` on `<html>`, persisted
  as `printMap` in the shared settings). It is an **intentional
  experiment that coexists with** the three-pane `/` app — do NOT "correct" it back to the
  three-pane shell; the "one layout" rule above governs `index.html`. `serve.js` mirrors the
  `/v2` route for dev; Cloudflare Pages serves `v2/index.html` at `/v2` automatically.

---

## Project-Specific Standards & Overrides

These take precedence over the **General Project Standards** above where they differ.

### No Cloudflare Worker proxy

The general standard of routing API calls through a Cloudflare Worker does **not**
apply. Atlas's runtime browser calls go directly to CORS-open TfL feeds via the
`tfl` seam; the one keyed feed (BODS SIRI-VM live GPS) is served by a Cloudflare
**Pages Function** (`functions/api/live/vehicles.js`) with the key as a project
secret. See _Deployment_.

### No framework or bundler — ever

Never introduce a bundler, framework, or build step at deploy time. The
no-build-at-deploy contract is load-bearing for the Cloudflare Pages setup
(output directory is the repo root; `functions/` is auto-detected).

### Scraping is pipeline-only

All scraping runs exclusively in the pipeline scripts during CI — never at
runtime, never from the browser. The general scraping standards apply fully there.

### TfL API first — scrape only to fill gaps

Third-party / community fallbacks run only for what the TfL API didn't return.
TfL-sourced values are never overwritten by scraped ones.

### Automated data commits are exempt

The daily VPS refresh task (`pipeline/vps-refresh.sh` on the Coolify `atlas-refresh`
resource) commits and pushes refreshed `data/*.json` automatically as the bot
(`transit-instruments-bot`) — this is expected and exempt from the "never commit/push
unless explicitly told" rule. That rule applies only to manual/agent-driven changes
during development sessions, which commit **as Farhan**.

## Checklist (each change/phase)

- [ ] Three-pane shell, 52px topbar, matches the existing app
- [ ] Topbar right: last-refreshed badge + manual refresh `⟳` + clock; refresh repaints panes & resets the badge
- [ ] Dark/light theme toggle via `data-theme`; defaults to OS pref, choice persists; both themes meet contrast
- [ ] Reads shared user settings (units/formats, data-refresh mode) at startup; preferences actually change behaviour & persist across tools
- [ ] `:root` tokens copied; no hardcoded colours; quantitative values in mono
- [ ] Red only for alerts
- [ ] Consistent `<title>` + meta + favicon + OG/Twitter tags on every user-facing page
- [ ] Left rail drives canvas + right rail; mode toggle switches canvas views
- [ ] Semantic landmarks, single h1, tablist for modes, lists as `<ul>`
- [ ] Skip link, focus-visible, reduced-motion, aria-hidden on decorative SVG; meaningful images have alt
- [ ] No horizontal overflow 320–1440px; panes collapse sensibly
- [ ] Large data SVGs have width override
- [ ] Official TfL API used as primary source where available; source + cadence documented
- [ ] Data access behind a swappable seam (normalised shapes, async); no inline `fetch` in components; backend selectable by config (tfl → db later)
- [ ] Fallbacks degrade gracefully (live → cached → labelled sample); badge shows the state
- [ ] Pipeline: Fetch → Clean → Validate → Store → Serve; validation is a hard gate (bad/empty data never overwrites last-good)
- [ ] Secrets in `.env` / CI secrets only; `.env.example` lists keys with no values; nothing keyed reaches the browser
- [ ] Pre-commit: desktop (1280×800) + mobile (390×844) screenshots; zero JS console errors
- [ ] Validated: rendered values cross-checked against the source via headless browser + Node/Python; reproducible script
- [ ] CSV export of the current view (respects selection/filters/mode)
- [ ] Data lockstep: any new/changed field lands in **the warehouse first**, then `data/*.json`, `/api/v1`, the app **dossier + table view**, the **CSV export**, and the docs — all together, none skipped
- [ ] Import &/or inline editing wired where it makes sense (imported/edited data is first-class; bad input reported)
- [ ] New layer/section wired into Atlas's display toggles + context groups (modular helpers)
- [ ] README current; analytics confirmed (added or explicitly skipped); pre-ship Network-tab check passed
