# Changelog — Transit Instruments

A running log of major features. Each entry: **what** we built, **how**, and **why**.
Newest first. Dates are when the work landed.

---

## 2026-07-03 — Warehouse migrated off Supabase → self-hosted Postgres + PostgREST (Coolify VPS)

Supabase free tier hit its 500MB cap and went read-only (blocking even the password
reset + Data API, so no export was possible) — rebuilt the warehouse from scratch on
our own VPS and repopulated it from sources. Full runbook: `ingest/SELF-HOSTING.md`.

**Infrastructure (Coolify):** `atlas-db` (Postgres 18, not publicly exposed) ·
`atlas-postgrest` (PostgREST at `https://atlas-db.farhan.app/rest/v1`, strip-prefix
routing, self-minted anon/service_role JWTs) · `atlas-ingest` (the `ingest/` pipeline
in an idle container — new `ingest/Dockerfile` — with 4 Coolify Scheduled Tasks
replacing the GitHub Actions crons, a persistent `/app/data` volume for the warm
caches, and auto-deploy off so pushes can't kill runs).

**Code/schema changes:**
- `SUPABASE_*` env vars renamed `WAREHOUSE_URL` / `WAREHOUSE_ANON_KEY` /
  `WAREHOUSE_SERVICE_KEY` across the Function, serve.js, all ingest scripts,
  workflows and docs. Heartbeat workflow deleted (only existed for Supabase
  auto-pause).
- `ingest/db/migrations-bundle.sql` — generated one-shot schema bootstrap, served
  statically for wget-from-container setup.
- Ported two hand-applied-only Supabase changes into migrations: `0022`
  (route_vehicle_observations anon read — vehicle-sightings endpoint returned
  empty without it) and `0028` (route_schedule.timing_point_stop_id — its absence
  hard-failed the whole push; now also in the self-heal optionalCols list).
- **Single source of truth:** new `mirror-reference-data.js` (refresh step 20) +
  migrations `0023`–`0027` mirror route_stops, route_geometry, bridges,
  crowding_profile (per BUSTO year) and localities from our own `/api/v1` into the
  warehouse — the DB now holds everything the apps render except live feeds.
- **New history endpoints** (lockstep fix — these tables were stored but unserved):
  `/api/v1/history/route-snapshots` (PVR/propulsion/operator/garage/fleet/MPS per
  route per date — the record behind fleet-move/PVR-change/propulsion-change
  analysis) and `/api/v1/history/garage-snapshots`.
- TfL 429 hardening in fetch-route-destinations/stops (honour Retry-After, back off
  up to 45s×6 — throttle windows outlived the old 4×≤2.4s retries), and
  `ingest/Dockerfile` installs devDependencies (they're the runtime deps).

**Verified populated** (~19 tables): vehicles 9,441 · accidents 7,118 · tenders 2,509 ·
tender_programme 1,240 · route_performance 667 · bus_crowding 606 · observations 6,751+ ·
route_stops/route_geometry 1,345 · bridges 877 · crowding_profile 606 · localities 530 ·
garage_snapshots 65 — reliability tables fill as the samplers run.

## 2026-07-01 — Data parity vs london-buses: night/school/prefix PVR restored (pipeline)

Investigated the user-reported datapoint differences between london-buses.farhan.app
(747 routes · 8,942 PVR · 76 garages) and Atlas (676 · 6,967 · 86). Verdict:

- **Route count — Atlas is correct.** TfL Unified API lists exactly **676** bus lines;
  Atlas matches 1:1. The old site's 747 includes 71 ids TfL doesn't serve (withdrawn
  night/school variants like N23/108D, non-TfL commercial routes like Uno's UL*, and
  tram-replacement ids) — its headline overstates the TfL network.
- **PVR — Atlas was wrong (incomplete).** `londonbusroutes.net/details.htm` carries FOUR
  fixed-width tables (main · **Croydon Tramlink** · **night** · **school/mobility**);
  our parser read only the first, so every night + school route (and the two-letter
  prefix routes SL*/EL*/BL1/SCS, which the route-id regex also missed) had no
  PVR/vehicle/garage/contract. Fixed `fetchRouteDetails` to parse every bus table
  (tram table stays excluded — its lines 1–4 collide with bus routes 1–4), first-table-
  wins merge, "See <day route>" contract refs not misread as dates. Network PVR:
  **6,967 → 7,852** — which reconciles with the old site to ±1 once its non-TfL
  routes are excluded. Also corrected 4 stale PVRs (83, 245, 483, G1). Remaining 4
  blanks (389/399/969/R10) are genuine `*`/`0*` shared-allocation rows in the source.
- **route-meta now scoped to the TfL route set** (routes.json) so the ~65 non-TfL ids
  in the community source can't inflate operator/route counts (fallback: keep union on
  a cold run).
- **Garages 86 vs 76 — Atlas is correct per the current source** (the extra 10 are real
  garages/outstations with no current TfL routes; the old site also carries the tram
  depot TK and stale codes HO/UB where the source now says LI/HF).

## 2026-07-01 — / gets v2-style Layers panel + place-name labels (both apps)

- **Layers panel in `/`** — the seven icon-only display toggles + colour-by seg in the
  topbar are now a single `Layers` button opening a v2-style panel of labelled
  toggle-switch rows (same `data-k` wiring/persistence), with an enabled-count badge.
  Also fixes mobile: the old icon strip was hidden under 1000px; the button stays.
- **Place names layer (new dataset, end-to-end)** — user report: no area/town names
  visible at route-fit zoom. New `pipeline/build/localities.js` + `sources/osm-places.js`
  (OSM Overpass, place=town|suburb, London bbox, ODbL) → `data/localities.json` (530
  places) → `/api/v1/localities` (prod Function + serve.js mirror + discovery + README/
  API.md) → both apps draw zoom-scaled locality labels (towns z10+, suburbs z12+) in a
  dedicated pane above the route lines; toggleable ("Place names", default ON — a `/`
  Layers row and a `/v2` Layers card switch). Verified: Stratford/Bow/Mile End/Stepney/
  Shadwell all label at z12–13.
- **`API.md`** — new single-file public reference for `https://atlas.farhan.app/api/v1`
  (all three groups + `/api/live/vehicles`, params, response shapes, caching, errors,
  attribution/licences). README's API section now points to it as canonical.

## 2026-07-01 — v2 (Route Lens) wiring review: bug fixes + dossier gaps closed

Full wiring review of `/v2` against the API and the `/` app, plus a runtime audit
(Puppeteer, desktop 1280×800 + mobile 390×844, zero console/page errors).

**Fixed**
- Route-type vocabulary mismatch: `routes.json` says `regular`, but v2's label maps
  only knew `day` — the busiest filter chip rendered as raw lowercase "regular"
  (now "Regular"), and `loadRoutes` defaulted unknown types to the non-existent `day`.
- Left rail booted fully collapsed — the route search was hidden behind a closed
  "Route" header while the empty-state invited you to pick a route. Route + Layers
  cards now boot open.
- Leaflet-CDN failure killed the whole script silently while the status bar showed a
  hardcoded "676 routes ready". Now: honest "Map unavailable" status + offline notice,
  and the boot status reads "Loading…" until routes actually arrive.
- The top-centre network caption said "coloured by operator" even with the Crowding
  colour layer on (now reflects the active scheme, incl. after toggling in network view).
- The Crowding map key (bottom-left) painted over the left rail's cards — moved clear
  of the rail.
- `role="application"` on the map → `role="region"` (mirrors the `/` app's a11y fix).

**Dossier gaps closed (v2 now carries the `/` app's per-route info)**
- **Risk & accidents card** — STATS19 collisions within 250 m of the corridor (count,
  KSI, severity split, density per km, hotspot boroughs, by-year), plus low-bridge
  diversion risk (bridges under the 4.4 m double-deck height, lowest clearance).
  Reuses the cached `/api/v1/accidents` + `/api/v1/bridges` sets; renders once the
  corridor geometry is in (slot + re-call from `fetchRoute`, race-safe).
- **Reliability — Atlas estimate** — our own live-sampled ~EWT (high-freq) / ~OTD
  (low-freq) from `/api/v1/history/reliability-daily`, cyan + "experimental", sample
  count shown, explicitly "not comparable to TfL's QSI"; degrades silently when the
  history API is unconfigured (503).
- **Disruption reason** — the live Status row now carries TfL's disruption description,
  not just the severity word.

## 2026-06-18 — Diversions layer

Live diversions/disruptions now surface on a selected route. A new seam method
`fetchDisruptions(id)` (→ TfL `/Line/{id}/Disruption`, 5-min cached) feeds it. **TfL
publishes no diversion geometry** — only prose — so `normaliseDisruption` parses the
diverted-via roads and the not-served stop names out of the description, and we honestly
visualise only what we know (never a fabricated alternate path):

- **Map** — the not-served stops get alert-red ring markers; the affected on-route
  corridor (between the first and last skipped stop) is overlaid as a dashed red line.
  Drawn on a dedicated `divLayer`, cleared with the route layers.
- **Right rail** — a prominent, always-visible "Diversion in effect" panel (alert-toned,
  not collapsed) with the full description, diverted-via roads, validity ("Until …"),
  last-updated, and the list of stops not served (flagged "on map" when matched to the
  sequence). Mirrors the reference app's Diversion Information panel.
- Only genuine diversions / not-serving disruptions trigger it (generic delay notices
  don't add noise).

Validated against live route 276 (Ordnance Road signal-works diversion): panel renders,
3/3 skipped stops parsed, cleaned and matched to the sequence, 0 console errors. UI 44/44.

## 2026-06-18 — Electrification (ZEV %) on garages & operators

Electrification is now first-class. A new **PVR-weighted** propulsion helper
(`propMixOfRoutes`) aggregates the propulsion of the routes at a garage / run by an
operator, weighted by peak-vehicle requirement — a 60-bus diesel trunk route moves the
needle more than a 4-bus electric school run. Denominator is the PVR we actually know
(routes without a PVR figure are excluded, not counted as zero), so the % isn't diluted
by missing data. **ZEV = battery-electric + hydrogen share.** Mirrors london-buses'
garage-electrification methodology.

- **Garage detail** — an "Electrification" KPI (green/amber by ZEV %) plus the full
  propulsion meter + legend.
- **Operator detail** — same Electrification KPI; the fleet-mix meter is now PVR-weighted
  (was route-count-weighted) for consistency.
- **Garage map popup** — a ZEV % stat alongside PVR / capacity / utilisation / routes.

Validated: 528/679 routes carry PVR + propulsion; sample garages reconcile (Sutton 100%,
Brentford 0%, Willesden 22%). UI audit 44/44.

## 2026-06-18 — Route-list grouping, coherent colours & UX polish

- **Route list groups by operator (default).** The left rail now groups routes under
  headers, tied to the colour mode: **Operator** mode groups by operator (brand-colour
  header, each row shows its route *type*); **Type** mode groups by type (each row shows
  its *operator*). Biggest group first, numeric order within. Default colour mode flipped
  to `operator`.
- **Fixed nonsensical list colours.** The per-row dot was hardcoded to the *type* colour
  while the label showed the *operator* (two Metroline rows had red/blue/green dots). The
  row dot now always matches its visible label, and the group header carries the grouping
  dimension's colour. The Type/Operator toggle now re-renders the list (and map), not just
  the filters.
- **Active toggles are obvious.** Selected segments (Type/Operator, Single/Multi, mode
  tabs, In/Out) get an amber tint + inset amber ring instead of the near-invisible grey.
- **Magnify keeps your map view** — entering Magnify no longer yanks back to all-London.
- **Magnify empty-radius** — when nothing falls in the radius, an explicit "Nothing within
  {radius}" banner shows the nearest routes/stops with their distances from the pin.
- Fixed the "ROUTES &AMP; STOPS" double-escape in the Magnify group title.

## 2026-06-18 — Comprehensive audit (no critical/high open)

Full audit per `audit.md` — static review + headless UI (44/44) + live API/DB/security
probing. Findings in `AUDIT-FINDINGS.md`. Verified clean: security (traversal, ingest
allowlist, key isolation), CDC idempotency, soft-fail orchestration, graceful fallback
tiers. **Fixed:** a phantom non-public `ZZ` line inflated network status to 677 — filtered
in `build/status.js` (`/^ZZ\d*$/i`) and purged from the warehouse → reconciled to 676.

## 2026-06-18 — Live markers: multi-route, coloured, selection-synced

- **Live vehicle markers now follow the selection across the board.** Was gated to
  single-select; now tracks **single or multi**. Multi-select colours each route's buses
  by that route (matching its line); single-select keeps the cyan/amber outbound/inbound
  colouring. The server `/api/live/vehicles` accepts comma-separated routes (`?line=25,86`)
  and filters the one cached London snapshot, so multi-route is a single 10s-cached request.
- **Fixed stale markers**: every selection change (add/remove a route, switch single↔multi,
  or a filter that clears the selection) now calls `applyDataMode()` → the live layer
  refreshes/clears accordingly. A `liveToken` guard drops a slow positions fetch that lands
  after the selection already changed. Per-vehicle off-route/progress is computed against
  *its own* route geometry in multi.
- **Accordion groups default to COLLAPSED** — selecting a route opens a compact stack of
  group headers; expand on demand (opened groups persist across live re-renders).

## 2026-06-18 — Context panel: collapsible groups

The long merged dossier is now organised into a few **collapsible top-level groups** —
**Live · Route · Fleet · Commercial** (Safety lands with the accidents layer) — each with
an accent dot, a summary stat (e.g. "32 live", "45 stops · 14.9 km", "6.0y avg",
"5 tenders") and a clear chevron. Replaces the earlier per-section accordions (too many,
ambiguous chevron). Collapse state persists across the ~15s live re-renders (baked in at
build time from `grpClosed`, so no flicker). The route's many sub-sections now nest inside
these groups instead of being ~18 separate toggles.

## 2026-06-18 — Consolidation: Atlas is THE tool

The suite collapses into one tool. **Atlas is now `index.html`**; the hub and
`relay.html` moved to `archive/` (headway/mandate/cohort/sentinel were only stubs).
Everything becomes layers + one context panel.

- **Live buses merged into Atlas** — a `Live` display toggle (alongside routes/garages/
  stops) overlays real-time BODS GPS markers (heading, coloured by direction) on the
  selected route, auto-refreshing on the ring. The context panel gained the full
  live-ops set (service health, live performance: speed/held/off-route, headway+CoV
  bunching, running-now fleet, live vehicle list, intraday fleet movements) **on top of**
  Atlas's existing route/analysis/fleet/tender dossier. `liveOpsHtml()` is a self-
  contained module so it could be lifted back out. UI audit 44/44.
- **Structural**: `atlas.html → index.html`; ui-audit/route-check/theme-audit/serve.js
  repointed; `relay-audit.mjs` removed; cross-tool links neutralised to in-tool
  references (no dead links); CLAUDE.md reframed from "suite of instruments" to the
  single, modular Atlas tool.

**Planned next (design locked):**
- **Accidents layer** — TfL Bus Safety Data → `accidents` dataset → DB → toggle + markers + context.
- **Tiered time-series storage** for historical/period queries — *reference* (CDC, done);
  *transitions* (append only on change → fleet route→route + route garage→garage moves);
  *rollups* (~5-min per-route counts/headway); *daily summaries*. A server sampler captures
  counts + transitions every ~2–5 min (raw 10s firehose is never persisted). Powers
  movement analytics + previous/current/upcoming tenders (date query over tender history).



### Relay — advanced live-ops analytics
- Added analytics only possible from **live positions over time** (what Atlas can't do):
  - **Live performance** — per-vehicle speed from position deltas (route avg km/h), count
    of **held/slow** buses (≤3 km/h), and **off-route** detection (>300m from the line).
    Speed is sampled only on a new BODS snapshot, so cached repeats never read as "held".
  - **Headway & bunching** — coefficient-of-variation **regularity grade**
    (regular/uneven/irregular) alongside avg spacing, largest gap, and bunched-pair count.
  - **Running now** — composition of the fleet *actually on the road this minute*: avg age
    + propulsion mix from the DVLA roster ∩ live regs (distinct from the route's nominal fleet).
- Vehicles carry route progress + off-route distance (projected onto the geometry). 27/27.

### Relay made its own tool + fixed wrong-route live markers
- **Relay is now distinct from Atlas** (was a near-clone). Shared shell/tokens stay, but
  the content is live-operations: the route dossier is replaced by a live-ops readout —
  **Service health** (on road vs PVR, % of peak), **Directional flow** (outbound/inbound
  split, colour-coded), **Spacing & bunching** (live headway from GPS — avg spacing,
  largest gap, bunched-pair count), the live vehicle list, and a **Fleet movements**
  (intraday) scaffold. Geometry/analysis/tenders now cross-link to Atlas. The landing is a
  Relay-specific "Live network — select a route to track" prompt + live-feed facts (not
  Atlas's network overview). Left rail defaults to Routes; eyebrow reads "Live tracking";
  map markers are coloured by direction (cyan outbound / amber inbound).
- **Fixed wrong-route live markers**: BODS `LineRef` is an internal id (route 25's buses
  carry `LineRef=186`), so filtering by it returned route-61 buses in Bromley. The public
  route is **`PublishedLineName`** — now matched on that. The server pulls the whole London
  feed once per 10s and serves every route from that single cached snapshot (filtered by
  PublishedLineName), so vehicles land exactly on the route corridor. Relay audit 27/27.

### Relay shipped — live vehicle tracking (BODS SIRI-VM)
- **Relay is live** (relay.html), derived from Atlas so it inherits the exact shell,
  tokens, topbar and dataSource seam (cyan accent, route-only — no catchment). Pick a
  route → its buses appear on the map as **live GPS markers with heading arrows**, and
  the right rail leads with **"On the road now"** (each vehicle: reg, destination,
  bearing, DVLA age; click a row to pan; marker popups show make/age/run). Auto-refreshes
  on the live ring; the full route dossier (geometry, analysis, fleet, tender) sits below.
- **True live positions via BODS**: TfL's Unified API has no bus GPS (verified — its
  predictions carry next-stop + bearing only, `currentLocation` empty), so positions come
  from the **BODS SIRI-VM** feed. New `sources/bods.js` fetches + parses SIRI-VM
  (`VehicleActivity` → reg/lat/lng/bearing/line/direction/destination/journeyRef).
- **Within limits by construction**: the BODS key is server-side only; the browser calls
  our `/api/live/vehicles?line=` proxy, which **caches per-line for 10s** (BODS'
  `ShortestPossibleCycle` is 5s) so any number of clients map to ≤1 upstream poll/10s, and
  always filters by bbox+line so each pull is tiny. Relay's refresh interval floors at 10s.
  `BODS_API_KEY` added to `.env`/`.env.example` + env loader (`keys: … · BODS ✓`).
- Registered Relay in the hub (status live). New reproducible **`pipeline/relay-audit.mjs`
  — 27/27** (shell, live markers, count reconciliation, row→pan, popup, toggles, clear,
  no stale markers on route-switch, countdown ticks, no page errors). Atlas audit 44/44.

### DVLA live, rate-limit safety, fleet profile, Relay scaffold
- **DVLA fleet enrichment is live.** Fixed the blocker (our HTTP client wraps bodies
  as `{data}`; the fleet builder expected a bare array → 0 vehicles). Now TfL Arrivals
  → regs → DVLA VES gives per-route **avg fleet age, propulsion mix and make breakdown**,
  surfaced in a new **Fleet profile** block in the route dossier (fed from the warehouse
  via `/api/fleet`, not a live browser call).
- **Provably inside the free tiers** (per the official docs): TfL is 500 req/min — our
  pulls sit well under and `lib/http.js` backs off on 429. DVLA throttles per-second
  (429 on exceed) so the client now does: configurable delay (`DVLA_DELAY_MS`≈4.5/s),
  a per-run lookup cap (`DVLA_MAX_LOOKUPS`, default 5000) that spreads a cold start over
  a few daily runs, exponential backoff on 429, and a graceful stop-and-resume. Resolved
  regs are cached (committed) → steady-state runs resolve only the few rotated-in regs.
- **GitHub Actions** updated: Node 24 (for `node:sqlite`), passes `DVLA_API_KEY`, warm
  caches committed → daily runs are minutes and well inside free Actions limits.
- **Relay scaffold (London Vehicle Finder)**: new `vehicles` dataset inverts `fleet`
  into a reg→routes roster (operator + DVLA make/age), free (no API calls), mirrored to
  the warehouse so CDC accumulates the time-series for **intraday fleet-move** detection.
  Added a `sources/bods.js` stub for the BODS SIRI-VM feed (the authoritative
  vehicle→journey/block source LVF uses) — ready to wire when Relay is built. `/api/vehicles` served.

## 2026-06-17

### Coincident markers, route-as-search, reusable render primitives
- **"Double marker" fixed**: some sites host two garages at identical coordinates
  (e.g. AE + HK at Ash Grove). Coincident markers now fan out on a tiny circle so
  neither hides behind the other — no more overlapping/duplicate-looking pins.
- **Route pills behave like a search**: clicking a route in any popup, the similar-
  routes list or a context pill now mirrors a left-panel search — switches to the
  Routes tab, fills the search box, clears filters, and selects it.
- **"View all routes"**: garage popups and the garage detail view gain a button that
  multi-selects every route operated there (equivalent to multi-searching them).
- **Modularity pass**: extracted reusable context-rail primitives — `mcard`/`metrics`
  (KPI grid), `kv` (stat row), `metricBlock`, `crossLink`/`toolLink`, and one shared
  `fleetMixHtml`. Removed duplicated propulsion-bar code + a shadowed `PCOL`; network,
  catchment, operator/garage detail and the dossier now build from the same helpers
  so the look stays consistent and the pieces are reusable across future tools. 44/44.

### Fleet & capacity pipelines, garage geocoding, API keys
- **Garage geocoding fixed (88/88, was 69)**: the operating-garage marker was
  missing for many routes because ~19 garages had no coordinates. Root cause —
  we only read the *garage* address postcode; the reference pipeline also falls
  back to the *company* address. Now precedence is **garage address → curated
  override (`pipeline/garage-postcodes.json`) → company address**, so a marker
  only falls back to an operator HQ postcode as a last resort (keeps depots
  accurately placed, e.g. Ash Grove at E8 not the Leyton HQ).
- **Fleet pipeline** (`build/fleet.js`): TfL Line Arrivals → per-route vehicle
  regs → **DVLA VES** enrichment (make/year/fuel → avg fleet age + propulsion mix
  + top makes) when `DVLA_API_KEY` is set, via a persisted reg-cache. Stored as
  the `fleet` dataset, mirrored to the warehouse, served at `/api/fleet`. Degrades
  to regs-only without a key. **All gathered data now flows pipeline → DB → app.**
- **Garage capacity analytics**: curated DVSA operating-centre capacity
  (`pipeline/garage-capacity.json`, 78 garages) joined into the garages dataset,
  yielding **utilisation = PVR ÷ capacity**. Surfaced in the garage marker popup
  (compact stat strip), the garage detail view (Capacity + Utilisation KPIs with a
  load bar, red ≥95% / amber ≥80% / green) and the operator detail (fleet capacity
  + utilisation).
- **API keys wired** (`pipeline/lib/env.js`): loads `.env` via Node's native
  `process.loadEnvFile` at every entry point. Two optional, server-side-only keys —
  `TFL_APP_KEY` (rate limit) and `DVLA_API_KEY` (fleet enrichment); documented in
  `.env.example` with the portal URLs. Nothing else needs a key.
- **Garage markers**: removed the redundant hover tooltip (it duplicated the
  visible code and covered the marker); the chip now reacts on hover (operator-tint
  ring + lift). Popup carries capacity/PVR/utilisation/routes.
- **Quick "Clear all"**: a red topbar button appears whenever any lens is engaged
  (filter / search / selection / catchment pin / drill-down) and reloads to a clean
  default. Clear-filter / clear-selection buttons are now red with a white icon.
- Similar-route threshold relaxed **50% → 30%**. UI audit 44/44.

### Context-panel harmony, drill-down & smarter analysis
- **Operator & garage drill-down** (london-buses parity, our design): the context
  rail is now a small nav stack — click any operator (network operators table, route
  dossier) → operator detail (routes/garages/PVR/% network, fleet mix, clickable
  garage list); click a garage → garage detail (routes/PVR, operator link, clickable
  route pills). Back button returns. Network operators list became a clickable table
  with routes + ZEV columns.
- **Similar-routes analysis**: each route dossier lists routes sharing ≥50% of its
  stops, with overlap % bars, clickable to open (e.g. 25 → N25 96%, 425 56%). Plus a
  **Network analysis** block — role archetype (Trunk/Coverage/Orbital/Local), directness
  (sinuosity), avg stop gap, interchange intensity, sole-served coverage, key hubs.
- **Design harmonised to the Concepts language**: de-boxed KPI tiles into borderless
  `.big`-style numbers, stat rows without per-row dividers, one thin meter style, quiet
  section headings — the rail reads as one instrument, not assorted widgets.
- **Map/UX fixes**: garage toggle now hides the active route's operating-garage too
  (single layer, highlighted in-place — no duplicate overlay); Routes/Garages/Stops/
  Colour toggles no longer refit-zoom; new **bus-stop visibility toggle**; **draggable
  catchment pin**; catchment view honours route-line/garage/stop/colour-by toggles;
  zoom controls moved bottom-right.
- **Colour-by correctness**: single-selected route line now uses its real type/operator
  colour (was hardcoded green); filter chips show the colour key only for the active
  colour-by dimension (type *or* operator).
- **Filters ⟂ routes**: the two are mutually exclusive lenses — engaging filters clears
  any route search/selection and vice-versa; network stats now follow the active filter.
  Filters tab is first and default. Direction shows **In before Out** (inbound default);
  direction + stop toggles appear only with a route selected.
- **Clarity**: tools carry a plain-English tag (hub nav + cards + Atlas subtitle =
  "Interactive route map"); badge tooltip simplified to just the DB pull time. UI audit 37/37.

### Garage marker labels + filter order
- Garage markers now read **operator-initial (garage code)** — e.g. "SC (HK)", "AR (AE)".
- Filters reordered: **Operator** now first (before Route type); the garage filter
  group relabelled **"Garage markers"**. UI audit 32/32.

### More prominent route lines
- Network route lines bolded (weight 2 → 2.8, opacity .55 → .9, round caps) and the
  colourful light Voyager basemap gently desaturated (saturate .72) so route colours
  read clearly in both themes. UI audit 32/32.

### Live fleet per route + DVLA scaffold + source cross-reference
- **Live fleet** added to the route dossier: the vehicles currently running the route
  (by registration) from TfL `/Line/{id}/Arrivals` — count + reg chips, on-demand,
  45s TTL, refreshes in Live mode. *Validated 15/15 regs against the live API.*
- **DVLA scaffold** (`sources/dvla.js`): VES lookup by reg → make / year / fuel for
  avg-fleet-age + make/model enrichment. Key-gated (`DVLA_API_KEY`) since VES isn't
  key-less; without it, live regs still show, only the age/make enrichment is skipped.
- **Source cross-reference** (per data_sources.xlsx): routes 676=676 ✓, route-stops
  35=35 ✓, status live ✓, tenders scraped ✓, garages 88/69-geocoded ✓, live fleet
  reg-for-reg ✓ — every dataset maps to its authoritative TfL/community source.
- UI audit **32/32**.

### Atlas polish pass + advanced context analysis
- **Advanced analysis in the route dossier** (previews of the dedicated tools):
  - **Tender analysis** (→ Mandate) — derived from the award history: latest £/mile
    with trend vs the previous award, last tenderer count, incumbency (consecutive
    wins by the current operator), accepted-bid premium over the lowest, contract
    time-remaining, awards-on-record.
  - **Operator footprint** (→ Cohort) — the route's operator across the whole
    network: routes run (+ % share), total PVR, propulsion mix bar.
- **Polish/correctness:** route list/table now in **numeric order** (was string
  order from the DB); icon topbar buttons have **aria-labels** + synced `aria-pressed`;
  **no horizontal overflow 320→1440** (topbar drops non-essential controls
  progressively); units setting verified to reformat figures.
- **Verified:** expanded UI audit **32/32, stable across repeated runs**; responsive
  overflow clean 320→1440; advanced cards render real data with no page errors.

### ⟳ refreshes ALL data + badge confirms it
- The refresh button now re-pulls **every dataset Atlas uses** — routes, geometry,
  stops, route-meta, tenders, garages (all from the store) **plus** the selected
  route's live status — after clearing all in-memory caches. Not limited to the
  filtered view; the active filter/selection is preserved.
- The "Updated …" badge now means **time since you refreshed** (resets to "just now"
  on ⟳ / load), with the store's **data-generation age** shown in the tooltip — so a
  refresh visibly does something instead of showing a stale data timestamp.
- *Verified:* a single ⟳ fires fetches for routes/overview/manifest/stops/meta/
  tenders/garages + Route + Status; badge → "Updated just now"; filter retained.

### Live-mode badge fix + no-store dev server
- **Live badge:** in Live mode the "Updated …" badge tracked the (rarely-changing)
  store load time, not the per-tick live-status refresh — so it looked stale while
  the ring counted down. Now it reflects the live refresh (`liveStatusAt`) and the
  tooltip reads "Live · route N status refreshed just now (every Ns)". *(verified:
  after a 10s tick → "Updated just now".)*
- **Dev server `Cache-Control: no-store`** so the browser never serves a stale tool
  page (was `no-cache`). The earlier "table filter doesn't work" report could not be
  reproduced — verified the table filters by search and chips (`1`→237/237, `73`→5/5);
  it was a stale cached page.

### Controls consolidated into the topbar (canvas-head removed)
- **What:** Dissolved the busy canvas header and moved its controls into the main
  topbar as compact **icon toggles**: mode (Route/Catchment), view (Map/Table),
  direction (Out/In), display (route-lines / garages icons + Colour Type|Operator),
  and an export icon. A small context chip shows the current selection
  ("Route 24 · outbound"). The map is now **full-height** (reclaimed ~50px).
- **How:** Relocated the markup into `.topbar` keeping every element id/data-attr,
  so the JS is unchanged; added `.iconseg`/`.ctxchip`/`.bar-sep` styles + responsive
  rules (drop subtitle/context/direction as width shrinks).
- **Verified:** UI audit still **27/27** after the move — every control works in its
  new home.

### Design alignment + controls in header + full UI audit
- **Markers & popups re-styled to the app's design language:** garage markers are
  now panel-surface chips with an operator dot + code (theme-aware, not saturated
  badges); route pills are tinted chips with a type dot; popups use the panel
  surface/border/radius + themed close button. The operating-garage highlight fills
  with the operator colour (luminance-aware text).
- **Display controls moved into the canvas header** (Routes / Garages / Colour
  Type|Operator) — the map is now free of overlays.
- **Verification:** `ui-audit.mjs` exercises every control (tabs, search, all filter
  groups, single/multi select, Map↔Table incl. filtering, direction, catchment,
  routes-here pills, garage toggles, colour-by-operator, theme, settings) —
  **27/27 passing across 5 consecutive runs.** Confirmed the table **does** filter
  by search, type chip, and live changes (the reported bug is resolved).

### "Routes here" pills, garage-operator filter, labelled markers, light default
- **Routes-here popups:** clicking the map (overlapping lines), a bus stop, or a
  garage shows the routes there as **clickable pills** → clicking one selects that
  route (network lines are now non-interactive so the click resolves all of them).
- **Garage-operator filter:** a "Garage operator" chip group filters which garage
  *markers* show (e.g. Stagecoach → only its garages: 69→12). *(verified)*
- **Labelled garage markers:** each marker is an operator-coloured badge showing the
  garage **code**, with luminance-aware text — identifiable at a glance.
- **Colour Type/Operator** is now a visible 2-button segment in the map control bar
  (was an easy-to-miss cycling button).
- **Popups redesigned** to match the app's panels (border, radius, themed close button).
- **Light theme is the default** on first visit (both tools); choice still persists.
- Garages now show by default.

### Map richness, overrides, classification, theme + verification
- **Garages:** new `build/garages.js` (londonbusroutes.net + postcodes.io geocode)
  → `garages.json` (88 garages, 69 geocoded), mirrored to the warehouse + `/api/garages`.
  Atlas: garage markers (operator-coloured, popups), **show/hide garages** + **show/hide
  route lines** toggles, **colour-by Type/Operator**, and a labelled **operating-garage
  tooltip** when a route is selected.
- **Map/Table toggle:** canvas switches between the map and a sortable route table
  (Route/Type/Operator/Garage/PVR/Length/Fleet) reflecting the current filters; row → select.
- **Overrides layer:** `pipeline/overrides.json` + `lib/overrides.js` — hand-curated
  per-route values applied last in the pipeline (win over every source). Used to set
  the **24-hour** class (no free feed exposes it) and to correct any operator/fleet field.
- **Classification** aligned to london-buses: **regular · night · 24-hour · school**
  (was day/local/superloop/express). `type` now baked in the store (override-driven),
  read by Atlas via `typeOf()`.
- **Refresh ⟳** now refreshes ALL data (store + routes + selected route detail) with a spinner.
- **Theme:** dark retuned to a darker, near-black neutral (was navy-blue); dark theme now
  uses a **dark basemap** (CARTO Dark Matter) so the map matches the chrome; fixed muted
  headers/legend/map-control contrast.
- **Verification (Puppeteer):** `theme-audit.mjs` → dark 0 contrast issues; `route-check.mjs`
  → 20/20 routes render correctly (line, stops, dossier, garage tooltip); table + filters no errors.

### Security hardening (post-audit H1–H3, M1–M2)
- **H1 stored/DOM XSS:** added an `esc()` helper and HTML-escaped every dynamic
  value interpolated into `innerHTML`/popups in both tools (status reason, stop &
  route names, operator, garage, fleet, tender, line names). *Verified:* no
  unescaped dynamic interpolations remain.
- **H2 `/ingest`:** now allowlists `entityType`, validates item shape, forces
  `kind=live`, and **drops the CORS wildcard** (same-origin only). *Verified:*
  `__pwned` → 400, bad shape → 400, no `Access-Control-*` header.
- **H3 static server:** allowlist — serves only tool `*.html` + `/data/*.json|geojson`.
  *Verified:* `transit.db` & `pipeline/*` → 404, tools/data → 200.
- **M1 CSV formula injection:** `csvCell` prefixes `=+-@` cells with `'`.
- **M2:** `*.db*` git-ignored (don't commit the binary warehouse).

### Filter-view analysis + clean count + CSV for current view
- **What:** (1) The cramped "676 shown · 1 sel" now sits on its own slim line
  ("**676** routes shown · **1** selected"), toggle + clear above it. (2) The right
  rail in the filter/network view now shows **analysis of what's shown**
  (benchmarking london-buses): Routes · Operators · Total PVR · Network length KPIs,
  a **propulsion-mix stacked bar with % ZEV**, by-route-type and top-operator
  breakdowns — all recomputed live as you filter. (3) **CSV export** now covers the
  current view: filtered route list (with operator/garage/PVR/fleet/contract) when
  nothing's selected, or the selected routes' stops when there is a selection.
- **Cross-linking:** the analysis surfaces operator/fleet/tender figures but links
  to the dedicated tools for the full experience — fleet/operators → **Cohort**,
  tenders → **Mandate**, reliability → **Headway**. (Backend for those already
  exists in the store: `route-meta`, `tenders`; the tools themselves are next.)

### Atlas reads from the DB · left-rail tabs · simpler topbar
- **What:** (1) Atlas now **reads from the warehouse** — the server exposes
  `/api/routes`, `/api/routes-overview`, `/api/route-meta`, `/api/route-stops`,
  `/api/tenders`, `/api/line-status` (reconstructed from the SQLite `current`
  table); Atlas fetches `/api/*` first, falling back to static JSON, then sample.
  (2) Left rail split into **Routes** (search + select + list) and **Filters**
  (chips + active count badge) tabs — cleaner separation of the two features.
  (3) Topbar simplified: the freshness badge now reads plain **"Updated 11m ago"**
  (no jargon "Store"); the real source is in the tooltip ("from our database" /
  "live from TfL" / "cached" / "sample"); removed the redundant pulsing dot on the
  clock.
- **Why:** Closes the read loop (DB-backed, the planned end state) and makes the
  UI self-explanatory. "What is Store?" → gone.

### SQLite warehouse — capture every datapoint (CDC), periodic + live
- **What:** A zero-dependency SQLite warehouse (`data/transit.db`, built-in
  `node:sqlite`) that stores **every datapoint we touch** — both periodic pipeline
  pulls and live tool refreshes. First ingest: 6,529 entities (routes, geometry,
  stops, meta, 2,508 tenders, status).
- **How:** Change-data-capture — an `observation` row on *every* touch (what/when/
  hash/kind), a `snapshot` only when the value's hash *changes* (deduped history),
  and a `current` table for fast latest lookups. `build/db-mirror.js` ingests the
  JSON store each run; `serve.js` exposes `POST /ingest` so the tools post what they
  fetch live (hub status, Atlas route status) through the same CDC engine.
- **Why:** "Always store everything, periodic or live, without exploding the DB."
  Verified: re-running added observations but **zero** duplicate snapshots; an
  identical live POST returned `changed:0`. This is the warehouse the store seam
  was built for (fs JSON now → query this DB later); time-series (status) accrues
  real history, reference data barely grows.

### Full tender history + UI consistency fixes
- **What:** (a) Built the **TfL tender-results scraper** — full award history
  (2,508 awards, 856 route keys, back to ~2005): operator, accepted/lowest/highest
  bid, cost-per-mile, # tenderers, joint-bid, notes, date. Atlas shows a per-route
  "Tender history" section. (b) Fixed UI: selected-route geometry/stops now read
  **store-first** (a route showed 0 stops when the live API was blocked + store was
  partial); removed stale "sample" labels (operator/fleet are real now); refreshed
  the left-rail source footer; map labels fixed (CARTO Voyager + zoom 12, no retina).
- **How:** `sources/tfl-tenders.js` parses the server-rendered `13923.aspx`
  discovery `<select>` (value=btID) + `13796.aspx?btID=` result tables;
  `build/tenders.js` fetches each award once and **caches incrementally** (re-runs
  only pull new awards — award events are immutable), groups by route newest-first.
- **Why:** "Full tender history" — now real and complete, the spine of competitive
  analysis (feeds Mandate next). Store-first selection makes route detail robust
  regardless of live-API access.

### Map labels + londonbusroutes.net scraper (real operator/garage/fleet)
- **What:** (a) Basemap switched to CARTO **Voyager** (label-rich) + default zoom 12
  + dropped `detectRetina` — street/area names now read without zooming in (the
  HiDPI-retina shrink was the cause). (b) Built a **londonbusroutes.net scraper**:
  `garages.csv` → route→garage→operator, `details.htm` → fleet/PVR/length/contract;
  merged into `route-meta.json`. Atlas reads it: 676/679 routes now have a real
  operator, 530 have fleet, all with PVR/length/contract.
- **How:** `sources/londonbusroutes.js` (quote-aware CSV parser + fixed-width
  `<pre>` parser, Windows-1252); `build/route-meta.js` merges both, derives
  propulsion from the vehicle type; tram depot excluded (lines 1–4 collided with
  bus route numbers).
- **Why:** Operator/garage/fleet aren't in any free TfL feed — scraping is the only
  source (claude.md sanctions it as last resort). **Cross-checked vs london-buses:
  14/15 operator agreement** (the one diff is a recently-retendered route where our
  live scrape is fresher). Behind the store seam, so swapping to richer sources
  (Find-a-Tender OCDS for contracts) won't touch Atlas.

### Atlas — minimal basemap, icon clear-buttons, fuller route info
- **What:** (a) Map redesigned to CARTO minimal basemaps (dark_all / Positron),
  theme-aware, showing streets + area labels and little else — no CSS tile filter.
  (b) Clear-filters / clear-selection are now compact icon buttons. (c) Pipeline
  now also captures **stops per route** (from the same Sequence call, no extra API
  cost) → `route-stops.json`, and **route-meta** (operator/propulsion/garage/PVR/
  contract/fleet) → `route-meta.json`; Atlas reads both from the store.
- **How:** `setBasemap()` swaps CARTO dark⇄light with the theme; `metaOf()` reads
  store route-meta first (in-file sample as fallback); offline route detail falls
  back to store stops + geometry.
- **Why:** "Minimal map — streets/areas only" + "correct info for every route."
  Stops are now real & complete from our own store; operator/tender/fleet are
  sample today but served through the store so swapping to real sources is a
  pipeline change only.
- **Roadmap (real sources, next):** operator + garage + PVR + fleet via a
  londonbusroutes.net scraper (cross-checked vs bustimes.org); tender/contract via
  Find-a-Tender OCDS + the LBSL programme PDF; diversion *paths* aren't published
  as geometry by TfL (only the live status text, already shown).

### Atlas wired to the store
- **What:** Atlas now reads our pipeline store first — route list from `routes.json`
  (all 676) and the whole-network map geometry from `routes-overview.geojson` (drawn
  at once, no per-route fetch, no 50-cap). Live TfL is the enhancement for per-route
  detail (stops, status, service patterns) and the fallback when the store is absent.
- **How:** `loadStore()` fetches `data/*` once and indexes overview geometry by route;
  `loadRoutes`/`drawNetwork` prefer the store; badge shows the source; single-route
  geometry falls back to store coords if a live call fails.
- **Why:** Previously Atlas depended on a live call and fell back to 10 sample routes
  when that failed (e.g. `file://`). Reading our own data shows the full network with
  no API dependency — the precomputed-overview model that makes the map instant.
  NOTE: tools must be served over http(s) for the store fetch (and the live API) to
  work — opening as a `file://` page blocks both.

### Data pipeline + store (foundation)
- **What:** A Node ETL pipeline (`pipeline/`) that ingests upstream data, normalises
  it into our shapes, validates it, and writes a versioned store (`data/*.json` +
  `routes-overview.geojson` + `_manifest.json`). First datasets: `routes`
  (+classifications, +simplified network overview) and live `status`.
- **How:** Orchestrator (`run.js`) over a dataset registry (`config.js`); thin
  `sources/tfl.js`; `build/*` normalisers; shared `lib/` (HTTP with timeout +
  backoff/jitter retries + conditional requests, persistent ETag cache, pluggable
  store sink, manifest, validation gate, geometry simplify). Daily GitHub Action
  (`.github/workflows/refresh-data.yml`) refreshes + commits the store.
- **Why:** Tools should read *our* store, not hammer TfL — the reference app
  (`london-buses`) proves a precomputed overview makes the whole-network map instant
  and API-free. Caching (HTTP validators → dataset TTL → tool-side tiers) keeps us
  within free-API limits. Store sink is pluggable (fs now → our own DB/Supabase
  later) so the swap is config, not a rewrite. Shared across all future tools.

### Refresh UX (hub + Atlas)
- **What:** Cached-by-default refresh. Load once + cache; manual ⟳; opt-in **Live**
  mode (auto-refresh every 10/15/30/60s) with a circular countdown ring.
- **How:** Shared setting `dataMode`/`liveSec`; `applyDataMode()` drives an SVG
  countdown ring (`stroke-dashoffset`) that turns amber while refreshing; manual
  refresh restarts the countdown. Atlas live mode refreshes only the selected
  route's live status (reference geometry never auto-polls).
- **Why:** Constant timer polling wastes the free API quota and isn't always wanted.
  Let the user choose; show clearly when live refresh is happening.

### Atlas — richer route dossier + network view + filters
- **What:** Atlas (merged Atlas + Radius) is the network-understanding tool. Default
  map shows the whole network coloured by route type; filters (type / operator /
  propulsion) narrow it; single- or multi-route select takes precedence. Right rail
  shows a full route dossier; Catchment mode profiles an area around a dropped pin.
- **How:** Leaflet/OSM (canvas renderer) reads geometry via the `dataSource` seam;
  route **type** derived live from the number, operator/propulsion from a labelled
  sample (→ Cohort/Mandate later). Dossier pulls live `/Line/{id}/Status` (diversion
  text), `/Route` service patterns, geometry + stops, connections, and sample
  tender/fleet. Network drawn in batches (cached instantly, fetched in one pass),
  capped at 50 for the free-API budget.
- **Why:** "See what routes are where, what type, and their tender/fleet info."
  Selection-over-filters and a default whole-network map match how the network is
  actually explored.
- **Fixes:** Catchment controls no longer leak into Route view (`[hidden]` vs
  `display:flex`); route list no longer capped at 500 (was hiding 176 routes);
  removed the staggered 1-by-1 line-load animation.

### Hub (`index.html`) — suite entry point
- **What:** The home instrument: domain-grouped nav, greeting strip, Overview /
  Attention / Activity modes, and a network-health right rail (health %, sparkline,
  per-domain meters, live counts, priority alert).
- **How:** Three-pane shell + shared tokens; live network status via the seam;
  Attention is derived from the live feed; Activity is the user's real last-opened
  history. CSV export per view; shared settings (operator/units/theme/clock).
- **Why:** One consistent shell every tool inherits; the hub reads as "the network
  itself" as its subject, matching the suite's design contract.

### Shared chrome (all tools)
- **What:** Design tokens, dark/light theme, settings (preferred operator, units,
  clock, theme), last-refreshed badge, live clock, tooltip, CSV export, graceful
  data fallbacks (live → cached → sample), accessibility (landmarks, skip link,
  focus-visible, reduced-motion).
- **How:** Copied `:root` token block; one shared settings object/key across tools;
  `dataSource` seam isolates all data access (swappable `tfl` → `db`).
- **Why:** The golden rule — every tool indistinguishable in look, structure, and
  behaviour. Consistency beats cleverness.
