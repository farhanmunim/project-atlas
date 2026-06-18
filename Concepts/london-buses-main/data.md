# Data Pipeline — London Buses

Definitive reference for every datapoint in this project: where it comes from, how
it is cleaned, how blanks get filled, and what to watch out for.

**Cadence:** weekly, Mondays 09:00 UTC, via GitHub Actions (`.github/workflows/refresh-data.yml`). Timed for AM peak so TfL `/Line/<id>/Arrivals` returns a representative active fleet. A separate **daily** sampler (`.github/workflows/sample-vehicles.yml`, 08:37 UTC) captures the same arrivals snapshot and appends it to the rolling `route_vehicle_sightings` Supabase table — this is what gives the weekly build a dense per-route recurrence signal (`days`) to separate each route's core fleet from one-off cover buses (see §2 `make`/`fleetSize` and the Historical store §). It writes only to Supabase (no git commit) so it never races the weekly committing run, and it keeps Supabase active, subsuming the old heartbeat. A twice-weekly heartbeat workflow (`.github/workflows/supabase-heartbeat.yml`, Thu+Sun 12:00 UTC) remains as a belt-and-braces read against `route_snapshots` to keep the free-tier project out of its 7-day inactivity auto-pause.
**Orchestrator:** `scripts/refresh.js` — runs the 18 pipeline steps in sequence; network-bound fetch steps soft-fail so one flaky source doesn't abort the week. Pure build steps hard-fail. Step 17 (`audit-data.js`) is a hard-fail data-quality gate so broken data can't be committed.
**Workflow safety:** the commit-and-push step retries with `git pull --rebase --autostash` (up to 3 attempts) if `origin/main` moved during the run — covers the race where a manual push or another workflow lands a commit between checkout and push. `--autostash` is needed because the pipeline writes more files than the workflow explicitly stages, so the working tree is always dirty when push time comes.
**Philosophy:** TfL API first. Scrape only to fill blanks. Always keep last-known-good when a source fails, so a flaky upstream never wipes curated data. Every fetcher persists its own freshness watermark and short-circuits when the upstream hasn't moved (geometry ZIP date, PDF `Last-Modified`, per-registration TTL, immutable-by-ID for tender awards) — see §4 below. The data-quality audit (§5b) provides the safety net for everything else: per-field plausibility checks on every record, hard-fails the refresh on schema violations.

---

## 1. Sources

| Source | Auth | Role | Notes / Limits |
|---|---|---|---|
| **TfL Unified API** (`api.tfl.gov.uk`) | `app_key` + `app_id` via `BUS_API_KEY` env var | **Primary** for route IDs, service types, timetables, stops, destinations, live arrivals (vehicleId per route) | Free tier, 500 req/min. Our scripts self-throttle to ~350 req/min. Key held in GH Actions secret + local `.env`; **never** reaches the browser. |
| **TfL geometry ZIP** (public S3) | None | Per-route geometry (inbound/outbound LineStrings) | No auth, no rate-limit published; `Route_Geometry_*.zip` updated roughly weekly. |
| **TfL iBus open data** (`ibus.data.tfl.gov.uk`, public S3) | None | Per-vehicle registration + operator + bonnet number for the entire London bus fleet (`Vehicle_<date>.xml`) | Updated every two weeks. We pick the latest `Base_Version_YYYYMMDD/` folder by lexical date. |
| **DVLA Vehicle Enquiry Service (VES)** (`driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1`) | `x-api-key` via `DVLA_API_KEY` env var | Per-registration `make`, `fuelType`, `yearOfManufacture`, `monthOfFirstRegistration` — feeds the per-route fleet aggregator | Free tier ~15 RPS / 500k req/day. We self-throttle to 5 RPS. Sticky 90-day cache (`data/source/vehicle-fleet.json`, force-committed) means weekly runs only touch ~2–5% of the fleet. Key held in GH Actions secret + local `.env`; **never** reaches the browser. |
| **londonbusroutes.net** | None | Fallback for: operator, garage, PVR, vehicle type, destinations, 24-hour aliasing, headway tier-3; **primary** for contract start date + **contract length** (`details.htm` "TQ 7"-style spec decoded per the page's own legend: type `T/N/C/A`, basis `G/Q`, duration in years, `+`=5→7 extension, plus "reduced/extended to N years" notes) | HTTP (not HTTPS). HTML is fragile — we parse with regex, not fixed-width columns (previous bug). Scrape with a 200ms courtesy delay. |
| **londonbusroutes.net `changes.htm`** | None | Cross-check for contract length: in-effect contract changes ("Contract retained/awarded … (N years)" + effective date). Most-recent in-effect change wins over `details.htm`, so a contract change is caught before the daily table reflects it | Same host/HTTP caveats. Parsed in `fetch-route-details.js`. |
| **londonbustimes.com / bustimes.org** | None | Secondary operator cross-reference | Independent of londonbusroutes.net — survives their downtime. |
| **postcodes.io** | None | Bulk postcode → lat/lon for garages | Free, generous limits. Cached in `data/source/geocode_cache.json`, persisted between runs. |
| **Photon → Nominatim (OSM)** | None | Fallback geocode for garage addresses without a clean postcode | Photon primary (OSM-backed, tolerates sustained use). Nominatim is strict — respect its 1 req/s and 60s back-off on 429. |
| **TfL Bus Performance (QSI) PDF** (`bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf`) | None | Per-route Excess Wait Time (high-frequency) + On-Time Performance (low-frequency) for the latest reporting period | Updates every ~4 weeks. Parsed with `pdfjs-dist` (position-aware) so column ordering survives Excel-export quirks. Skipped when `Last-Modified` matches the cached value. |
| **TfL per-route QSI PDFs** (`bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf`) | None | Per-route Minimum Performance Standard (MPS) — the contractual EWT/OTP/mileage threshold each route is graded against. Each PDF also carries 13 periods of current-year + last-year actuals; we currently extract only the MPS values. | ~700 small PDFs (~25 KB each). MPS is contract-defined and only changes at tender renewal, so the cache is sticky (28-day TTL with `Last-Modified` HEAD short-circuit). Per-run cap of 1000 lookups; periodic flush every 50 + SIGTERM handler. School routes (no published MPS) cache as 404 to avoid retry storms. |
| **TfL tender awards** (`tfl.gov.uk/forms/13796.aspx?btID=…`) | None | Every historical bus tender (~2,500 awards back to 2003): awarded operator, accepted/lowest/highest bids, cost per live mile, joint-bids, notes | Awards are immutable once published. Cache only fetches new btIDs; per-run cap of 4,000; periodic flush every 100 + SIGTERM handler. |
| **TfL tendering programme PDFs** (`content.tfl.gov.uk/uploads/forms/{YYYY-YYYY}-lbsl-tendering-programme.pdf`; from 2027/28 the `lbsl-` segment is dropped) | None | Upcoming tender schedule — tranche, route, issue/return/award/contract-start dates, vehicle spec, two-year-extension marker | One PDF per financial year (11 years, 2017/18 → 2027/28). Parsed with `pdfjs-dist`. Per-year `HEAD` skips closed years that haven't been re-published — drops 11 PDF parses to ~1 in steady state. Tranche/route disambiguation is positional (a leading number is a tranche only when the next cell is route-shaped), since TfL route numbers overlap the tranche-number range. |
| **Supabase Postgres** (free tier) | `service_role` key via `SUPABASE_SERVICE_ROLE_KEY` env var | **Write target** for historical state and analytics. Append-only weekly snapshot of every route, plus master vehicle table and per-snapshot fleet observations. The static-JSON read path that powers the public map is unaffected — Supabase is not on the page-load critical path. | Free tier: 500 MB DB, 5 GB egress / mo, 7-day inactivity pause (immaterial — the weekly cron keeps it active). RLS on every table; anon role gets read on `route_snapshots` only, vehicles + observations are service-role-only. Service-role key held in GH Actions secret + local `.env`; **never** reaches the browser. |

---

## 2. Datapoints — per route

Master record: `data/route_classifications.json`, keyed by route ID (upper-case).
Every field below is denormalized into this file so the frontend only needs **one** JSON fetch.

| Field | Type | Primary source | Fallback chain | Notes / traps |
|---|---|---|---|---|
| `type` | `regular` \| `night` \| `twentyfour` \| `school` | Derived: route ID prefix + TfL `service_types` | Routes.htm href-share: N<id>↔<id> ⇒ <id> is 24h | TfL often returns only `Regular`; don't trust the API alone for 24-hour detection. |
| `isPrefix` | bool | Derived from route ID regex | — | Letter-prefixed IDs (A10, EL1, W7, X26) — but never for N-routes. |
| `lengthBand` | `short` \| `medium` \| `long` | Haversine sum of direction=1 geometry, binned | — | <8 / 8–20 / >20 km. Numeric km/miles aren't stored — the frontend only needs the band. |
| `deck` | `double` \| `single` \| null | Scraper (details.htm) + manual `vehicle-lookup.json` | Daytime alias sibling for N-routes | Watch for fleet prefix stripping: "B5LH/Gemini 3 2D*" → "B5LH/Gemini 3". |
| `vehicleType` | string | Scraper (details.htm, regex-parsed) | Alias | Mojibake — fall back from UTF-8 to Latin-1 (`2D­` → `2D`). |
| `propulsion` | `hybrid` \| `electric` \| `hydrogen` \| `diesel` \| null | **DVLA fleet aggregator** (mode of `fuelType` across observed regs) | `vehicle-lookup.json` → LBR-string heuristic → last-known-good | DVLA wins because it's the authoritative fuel-type register. The LBR-string heuristic stays as fallback for routes the arrivals snapshot didn't cover (e.g. routes with no buses running at the snapshot moment). |
| `make` | string \| null | DVLA fleet aggregator (sighting-weighted mode of `make` across the **core fleet**) | Last-known-good | DVLA's manufacturer (e.g. `VOLVO`, `ALEXANDER DENNIS`). Body builder isn't separately stored — `vehicleType` carries the chassis+body string from LBR. The core-fleet filter (see §3 step 13) drops one-off cover/reserve buses so an emergency vehicle that ran the route once can't define its make. |
| `vehicleAgeYears` | number \| null | DVLA fleet aggregator (mean of `today − monthOfFirstRegistration` over the core fleet) | Last-known-good | First-registration month is closer to in-service than build year (yearOfManufacture). Rounded to 0.1 yr. |
| `fleetSize` | integer \| null | DVLA fleet aggregator (count of unique **core-fleet** regs matching the cache) | Last-known-good | Snapshot count, not the contracted PVR. Grows over weeks as `route-vehicles.json` accumulates more arrivals samples. |
| `fleetConfidence` | `high` \| `low` \| null | DVLA fleet aggregator | Last-known-good | `high` when `make`/`vehicleAgeYears`/`fleetSize` were computed from the recurring core fleet; `low` when sighting data was still too sparse to filter one-offs and the aggregator fell back to all observations. Lets the UI soften an unverified claim. |
| `fleetComposition` | `[{make, count, share}]` \| null | DVLA fleet aggregator | Last-known-good | Per-make breakdown of the **core fleet**, sorted by count desc (`share` = fraction 0–1). Lets the UI show a genuinely mixed route honestly ("mostly Switch, some ADL") instead of collapsing it to a single `make`. |
| `operator` | string | Scraper (garages.csv) | routes.htm 3rd col → bustimes.org → last-known-good | Normalise to parent brand ("Abellio" → "Transport UK" where applicable). |
| `garageName` / `garageCode` | string | Scraper (garages.csv route-column parse) | Alias → last-known-good | Some routes run from multiple garages; today we store the primary only — see "known gaps". |
| `pvr` | integer | Scraper (details.htm) | Alias → last-known-good | Peak Vehicle Requirement. Sum of PVRs across all routes ≈ total fleet demand. |
| `frequency` | `high` \| `low` \| null | TfL `/Line/<id>/Timetable` → `frequencies.json` | `times/<id>.htm` grid → `details.htm` Mon-Sat headway column → null | Binary band: `high` = ≤12 min between buses (5+/hr), `low` = >12 min (fewer than 5/hr). TfL is primary; if its timetable is sparse, the per-route HTML grid is parsed; if that also fails, `headwayMin` from the `details.htm` row is binned with the same ≤12 cutoff. School/limited-service routes (which encode endpoint names in the headway columns of `details.htm` instead of numeric headways) stay null rather than getting a spurious band. |
| `serviceClass` | `high-frequency` \| `low-frequency` \| null | TfL QSI PDF (which table the route appears in) | Last-known-good | Determines whether the route gets EWT or OTP — independent of `frequency`, since QSI grouping is set by TfL. |
| `ewtMinutes` | number \| null | TfL QSI PDF — `serviceClass = high-frequency` | Last-known-good | Excess Wait Time, in minutes (=AWT−SWT). Lower is better. |
| `onTimePercent` | number \| null | TfL QSI PDF — `serviceClass = low-frequency` | Last-known-good | Percent of departures arriving 0–5 min late. Higher is better. |
| `perfPeriod` | string \| null | TfL QSI PDF cover page (`Q3 25/26`) | Last-known-good | The 4-week reporting period the EWT/OTP figure covers. |
| `ewtMps` | number \| null | Per-route QSI PDF, "Minimum Standard" row (high-frequency) | Last-known-good | Contractual EWT threshold the route is graded against. Varies per route (observed 0.7–1.4 min); EL2 = 0.70, route 122 = 1.20. |
| `otpMps` | number \| null | Per-route QSI PDF, "Minimum Standard" row (low-frequency) | Last-known-good | Contractual OTP threshold (observed 74–90%); higher is stricter. |
| `mileageMps` | number \| null | Per-route QSI PDF, Mileage Performance section | Last-known-good | Contractual mileage-operated threshold (98% or 99%). |
| `previousOperator` | string \| null | `tenders.json` — most recent earlier award whose operator differs from current incumbent | Last-known-good (only if `tenders.json` failed to load) | Walks the route's tender history sorted by `award_announced_date` desc, returns the first operator that genuinely changed. Routes re-awarded twice to the same operator still surface their real predecessor. |
| `lastAwardDate` | YYYY-MM-DD \| null | `tenders.json` — `award_announced_date` of the **most recent** award | Last-known-good (only if `tenders.json` failed to load) | When the latest tender was decided. In the steady state this IS the current contract's award; in the transition window (~10% of routes at any time, when a re-tender has been awarded but the previous contract is still running) it's the *next* contract's award instead. Use the `currentContract*` cluster below for fields that always describe the in-service contract. |
| `currentContractAwardDate`, `currentContractCostPerMile`, `currentContractAcceptedBid`, `currentContractedAnnualMiles`, `currentContractNumberOfTenderers`, `currentContractWasJointBid`, `currentContractAwardedPropulsion`, `currentContractAwardedDeck` | mixed | `tenders.json` — the **originating** award (the most recent award whose `award_announced_date ≤ contractStartDate`). Picked by `pickCurrentContractTender` in `build-classifications.js`. | Last-known-good (only if `tenders.json` failed to load) | Always describes the in-service contract. For ~90% of routes these equal the `last*` fields above (steady state); for the ~10% in the transition window they describe the older (still-in-service) contract, and `last*` then describes the just-awarded next one. The route card splits these into separate "Current active contract" and "Next contract — awarded" sections; the second section is hidden when both clusters describe the same award. |
| `lastCostPerMile` | number \| null | `tenders.json` — `cost_per_mile` of the most recent award | Last-known-good (only if `tenders.json` failed to load) | £/live mile, directly comparable across routes regardless of length. Two-decimal precision matches TfL's published figure. |
| `nextTenderStart` | YYYY-MM-DD \| null | `tender-programme.json` — earliest `contract_start_date >= today` | Last-known-good (only if `tender-programme.json` failed to load) | When the *next* contract starts on this route — i.e. when the current contract expires. Past entries are NOT a fallback (a stale date is more misleading than null). |
| `nextTenderYear` | string \| null | `tender-programme.json` — `programme_year` of the next entry (e.g. `2026-2027`) | Last-known-good (only if `tender-programme.json` failed to load) | Surfaces which annual programme PDF the upcoming tender comes from. |

### Companion files

- **`data/frequencies.json`** — flat `{ routeId: "high" \| "low" }` map. TfL `/Line/<id>/Timetable/<firstStop>` primary; `times/<id>.htm` `<pre>` grids fallback. Consumed only by `build-classifications.js`, which also reads `headwayMin` from `data/source/route_details.json` as a tertiary fallback when both tiers above yield null.
- **`data/route_destinations.json`** — `{ outbound, inbound, service_types }` per route. TfL `/Line/<id>/Route` primary; routes.htm dashed "Origin - … - Destination" fallback. Route 969 has no API entry — hard-coded. Consumed by the frontend detail panel and by `build-classifications.js` (for `type` derivation).
- **`data/garages.geojson`** — garage geometry + operator + route allocation. Pipeline intermediate; feeds `fetch-route-details.js` and `build-garage-locations.js`.
- **`data/garage-locations.json`** — geocoded garage records (code, name, operator, lat/lon, PVR, capacity). Consumed by the frontend for garage map markers **and** the sidebar Garage filter (a multi-select checkbox dropdown grouped by operator; the selected garages' routes are unioned, then intersected with the other filters). Each garage's route set is derived client-side from `route_classifications.json`'s `garageCode` in `ui.js`. Garages with no current TfL routes (out-of-London depots like Crawley, Slough) are **skipped** at the build step (`build-garage-locations.js`) and never appear on the map or in the filter.
- **`data/operator-aliases.json`** — **manually curated** lookup of operator-name aliases (parent brand ← raw tender-form / iBus subsidiary names). Companion to `data/vehicle-lookup.json` (deck/propulsion/make) and `capacity/licences.json` (per-garage capacity). Updated by hand whenever an operator is acquired (e.g. **FirstGroup acquired RATP Dev Transit London in Feb 2025** — ~83 routes, ~1,000 buses, 10 depots), a subsidiary is renamed, or a new operator joins the network. **Currently:** the build script (`scripts/build-classifications.js`) and the route card's operator-change flag (`js/route-detail.js`) still carry their own inline copies of this mapping. **TODO:** wire both to read from `operator-aliases.json` as the single source of truth so a single edit there updates everything.
- **`data/routes-overview.geojson`** — aggressively simplified full-network map layer. Consumed by the frontend.
- **`data/routes/<id>.geojson`** — per-route full-fidelity geometry. Consumed by the frontend when a single route is selected.
- **`data/stops.json`** — canonical stop registry. Shape: `{ stops: { "<naptanId>": { name, indicator, lat, lon, routes: ["1","24",…] } } }`. ~30 k unique stops; ~6 MB on disk, ~1.3 MB gzipped over the wire. Consumed by the frontend: (a) to resolve per-route stops when a route is selected, and (b) to power the bus-stop filter (stopId → routes reverse index is pre-denormalized so the filter is O(1) per feature).
- **`data/route_stops.json`** — per-route ordered stop list: `{ routes: { "1": [{ id, towards }, …] } }`. The `towards` label is the TfL stop-flag hint ("Towards Hampstead") and is per route+stop, not per stop alone. Consumed by the frontend when rendering stops for a selected route.
- **`data/source/vehicle-fleet.json`** — registration → `{ make, fuelType, yearOfManufacture, monthOfFirstRegistration, operator, bonnetNo, lastCheckedAt, dvlaStatus }`. Pipeline intermediate; consumed by `build-classifications.js`. Force-committed (90-day TTL) so weekly runs don't re-query DVLA from scratch.
- **`data/source/route-vehicles.json`** — `{ routes: { [routeId]: [{ reg, firstSeenAt, lastSeenAt, sightings, days }, …] }, backfilledAt }`. Per-route registrations observed in TfL arrivals over the trailing 56 days. `days` = distinct calendar dates the reg was seen running the route — the recurrence signal the core-fleet filter keys on; `sightings` = total runs seen (informational). The weekly snapshot (`fetch-route-vehicles.js`) writes this run's observations; **`backfill-route-vehicle-sightings.js` then overlays accurate `days`/`sightings`** recovered from Supabase (the permanent weekly log + the daily sampler, via the `route_vehicle_recurrence` RPC) so the recurrence counts are dense from day one rather than taking weeks to accumulate. Merge-never-regress: counts become `max(existing, supabase)`; regs the daily sampler saw that the weekly snapshot missed are added. Legacy entries that predate the counts default to a single sighting. Force-committed; coverage grows week-over-week.
- **`data/source/route-performance.json`** — per-route EWT/OTP plus `pdfModifiedAt` (= the upstream PDF `Last-Modified` we last parsed). The `Last-Modified` watermark drives the skip-if-unchanged short-circuit. Force-committed.
- **`data/source/route-mps.json`** — per-route Minimum Performance Standards: `{ routes: { [routeId]: { service_class, ewt_mps_minutes, otp_mps_percent, mileage_mps_percent, pdf_modified_at, lastCheckedAt, status } } }`. ~700 routes. Cache is very sticky (28-day TTL + per-route `Last-Modified` HEAD short-circuit) because MPS only moves at tender renewal. Force-committed.
- **`data/source/tenders.json`** — every historical bus tender award keyed by btID (`{ tenders: { "1": { route_id: "341/N341", award_announced_date, awarded_operator, accepted_bid, lowest_bid, highest_bid, cost_per_mile, joint_bids, notes, … } } }`). ~2,500 rows back to 2003. Force-committed; awards are immutable so the cache only grows.
- **`data/source/tender-programme.json`** — upcoming LBSL tendering programme parsed from 11 financial-year PDFs (2017/18 → 2027/28). Shape: `{ years: [{ programme_year, source_url, pdf_modified_at, entries: [{ tranche, route_id, tender_issue_date, tender_return_date, award_estimated, contract_start_date, route_description, vehicle_type, two_year_extension }] }] }`. Each year's `pdf_modified_at` watermark drives the per-year skip-if-unchanged short-circuit. Force-committed.
- **`data/build-meta.json`** — generation timestamps shown in the footer.
- **`data/geometry-source.json`** — upstream ZIP date, read by `fetch-data.js` to skip the download + extract when unchanged, and by CI to skip re-committing unchanged per-route files.

Client-side aggregates (e.g. operator-level PVR share, electrification) are computed live in `js/stats.js` from `route_classifications.json` — no separate aggregate file on disk. Stops are **pre-baked weekly** into `stops.json` + `route_stops.json`; the frontend no longer calls the TfL API at runtime for stop data.

---

## 3. Pipeline stages (`npm run refresh`)

| # | Script | Reads | Writes | Failure behaviour |
|---|---|---|---|---|
| 1 | `fetch-data.js` | TfL geometry ZIP | `data/routes/<id>.geojson`, `geometry-source.json` | Soft fail. **Skip-if-unchanged**: if the latest ZIP date matches `geometry-source.json::zipDate`, the download and extract are skipped (≈95% of weeks). `--force` to override. |
| 2 | `fetch-route-destinations.js` | TfL API → routes.htm | `route_destinations.json` | Soft fail; per-route fallback. |
| 3 | `fetch-route-stops.js` | TfL `/Line/<id>/StopPoints` | `stops.json`, `route_stops.json` | Soft fail; last-known-good kept on failure. |
| 4 | `fetch-garages.js` | garages.csv + postcodes.io | `garages.geojson`, `geocode_cache.json` | Soft fail; geocode cache reused. |
| 5 | `fetch-frequencies.js` | TfL timetables → times/<id>.htm | `frequencies.json` | Soft fail; per-route fallback; zero ≠ high. |
| 6 | `fetch-route-details.js` | garages.geojson + details.htm + bustimes | `source/route_details.json` (incl. `headwayMin` per route from the Mon-Sat / Sunday / evening columns) | Soft fail; each source independently optional. |
| 7 | `fetch-vehicle-fleet.js` | iBus `Vehicle_<date>.xml` + DVLA VES per registration | `source/vehicle-fleet.json` (sticky 90-day cache, force-committed) | Soft fail. Per-run cap of 6000 lookups; periodic cache flush every 250 lookups; SIGTERM handler flushes on CI timeout. Cold-start week may take ~20 min; steady-state ~2 min. |
| 8 | `fetch-route-vehicles.js` | TfL `/Line/<id>/Arrivals` (Monday peak snapshot) | `source/route-vehicles.json` (this run's registrations per route, accumulated week-over-week with 56-day TTL) | Soft fail. Each Monday snapshot only sees buses currently running; the rolling-TTL accumulator builds full per-route fleet coverage over a few weeks. Recurrence counts (`days`/`sightings`) are then made dense by step 9. |
| 9 | `backfill-route-vehicle-sightings.js` | Supabase `route_vehicle_recurrence(p_since)` RPC — the permanent weekly `route_vehicle_observations` log **unioned with** the rolling daily `route_vehicle_sightings` (fed by the daily sampler) | enriches `source/route-vehicles.json` (overlays `days`/`sightings`, widens first/last seen, adds regs the daily sampler caught) | Soft fail. Leaves the file untouched (build falls back to forward-accumulated counts) if Supabase is unset/unreachable or the RPC is missing. Merge-never-regress: counts become `max(existing, supabase)`. `--dry-run`, `--window=<days>` (default 56). |
| 10 | `fetch-route-performance.js` | `bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf` (TfL QSI report) | `source/route-performance.json` (per-route EWT/OTP for the latest 4-week period); also dumps `route-performance-raw.txt` for parser debugging | Soft fail. **Skip-if-unchanged**: `HEAD` first; if `Last-Modified` matches the cached `pdfModifiedAt` the parse is skipped (PDF only republishes every ~4 weeks). PDF parsing is brittle so the script logs raw extracted text alongside parsed records. `--force` to override. |
| 11 | `fetch-route-mps.js` | `bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf` (per-route QSI PDFs) | `source/route-mps.json` (per-route MPS, sticky cache, force-committed) | Soft fail. Per-route `HEAD` short-circuit, 28-day TTL, per-run cap of 1000, flush every 50 + SIGTERM handler. School routes (no PDF published) cache as 404. |
| 12 | `fetch-tenders.js` | `tfl.gov.uk/forms/13923.aspx` (discovery) → `tfl.gov.uk/forms/13796.aspx?btID=…` (per award) | `source/tenders.json` (sticky cache, force-committed) | Soft fail. Awards are immutable; only new btIDs are fetched. Per-run cap of 4,000; flush every 100 + SIGTERM handler. |
| 13 | `fetch-tender-programme.js` | 11 LBSL programme PDFs (one per FY 2017/18 → 2027/28) from `content.tfl.gov.uk` | `source/tender-programme.json` (force-committed) | Soft fail. **Skip-if-unchanged**: per-year `HEAD`; closed years copied forward when `Last-Modified` matches cache (drops 11 PDF parses to ~1 in steady state). `--force` to override. |
| 14 | `build-classifications.js` | all above + `route-overrides.json` + `vehicle-lookup.json` + `tenders.json` + `tender-programme.json` + `route-mps.json` + last-known-good `route_classifications.json` | `route_classifications.json` | **Merges last-known-good** so one bad scrape never wipes curated fields. Frequency uses the 3-tier chain (TfL → times-page → details.htm `headwayMin`); propulsion uses DVLA fleet aggregator → LBR heuristic → vehicle-lookup → null. **Core-fleet filter:** before computing avg age / make / fleetSize the aggregator keeps only the route's *recurring* vehicles — a reg must have been seen on **≥`MIN_CORE_DAYS` (=2) distinct days**. This drops one-off cover/reserve buses (an emergency vehicle that ran the route once no longer defines its make). An absolute day floor is used (not a share-of-max): TfL `/Arrivals` only catches buses running at the snapshot instant, so a relative threshold would punish genuine regulars on sparsely-sampled routes. When sighting data is still too sparse to filter (cold start) it falls back to all observations and stamps `fleetConfidence: low`. It then filters the core fleet to the dominant propulsion, so reserves on a different drivetrain (e.g. a diesel ADL briefly covering an electric route) don't skew headline figures. make/propulsion are an **unweighted** mode over the de-noised core; `fleetComposition` records the full per-make breakdown. `serviceClass` precedence: MPS PDF (contractual) wins over the QSI Performance PDF (measurement); the wrong-class metric (EWT on low-freq, OTP on high-freq) is forced to null. School-routes default `deck=single` and `propulsion=diesel` when every upstream source returned null. `pvr=0` anywhere in the fallback chain is coerced to null. Tender enrichment derives `previousOperator` / `lastAwardDate` / `lastCostPerMile` / `nextTenderStart` / `nextTenderYear` per route. MPS values (`ewtMps` / `otpMps` / `mileageMps`) ingested from the per-route MPS cache. |
| 15 | `build-overview.js` | classifications + per-route geojson | `routes-overview.geojson`, `build-meta.json` | Hard fail. Must re-run after step 14. |
| 16 | `build-garage-locations.js` | `garages.geojson` + Photon/Nominatim | `garage-locations.json` | Soft fail; address-keyed cache, usually zero network calls. |
| 17 | `audit-data.js` | all build outputs | `data/audit/data-quality.json` | **Hard fail on CRITICAL.** Walks every record in `route_classifications`, `vehicle-fleet`, `garages.geojson`, `route-vehicles`, and `route-mps`. Three severities: CRITICAL (schema violations — broken counts, malformed dates, unknown enums, duplicate codes, missing geometry — hard-fails refresh), WARN (out-of-range values, sparse fleet coverage, cross-source disagreements incl. `make↔model`, freshness >8 days — logged but non-fatal), INFO (coverage statistics). 13-route "ghost" allowlist (TfL-internal geometry that returns HTTP 404 from `/Line/{id}`) lives at the top of the script; routes outside that set with null operator/garage trigger a WARN. Pass `--strict` to fail on WARN too. |
| 18 | `push-to-supabase.js` | `route_classifications.json` + `source/vehicle-fleet.json` + `source/route-vehicles.json` + `garages.geojson` + `source/route-performance.json` + `source/route-mps.json` (joined into route_snapshots) + `source/tenders.json` + `source/tender-programme.json` + `tender-overrides.json` | Supabase tables `vehicles` (upsert), `route_snapshots` (full denormalised route-card record under migrations 0009 + 0012 — see Historical store §), `route_vehicle_observations`, `garage_snapshots`, `route_performance`, `tenders`, `tender_programme` | Soft fail. Skipped silently if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are unset. |

### Field-precedence (in `build-classifications.js`)

```
route-overrides.json   (manual curation; always wins)
  └── DVLA fleet aggregator (for propulsion / make / vehicleAgeYears / fleetSize)
        └── scraper this run
              └── daytime alias sibling (for N-routes)
                    └── independent secondary (bustimes.org for operator)
                          └── vehicle-lookup.json (for deck/propulsion)
                                └── last-known-good route_classifications.json
                                      └── null
```

For `frequency`: `route-overrides.json` → TfL timetable → `times/<id>.htm` grid → `details.htm` `headwayMin` → null.

---

## Historical store (Supabase)

The weekly pipeline mirrors current state into a Supabase Postgres database
so we can build trend charts, run aggregations, and compare past vs present.
**The public map never reads from Supabase** — it's a write-only sink at the
end of the pipeline. The schema migrations live in [`db/migrations/`](db/migrations/);
paste each in order into the Supabase SQL Editor once.

### Dual-timestamp convention

Every row in every Supabase table carries **two** independent timestamps so we can
always answer "when did we collect this?" and "when is this data accurate as of?"
separately:

| Concept | Column name (preferred) | What it means |
|---|---|---|
| Extraction time | `extracted_at` (or `last_checked_at`/`updated_at` on `vehicles`) | When our pipeline collected the row. |
| Period covered | `data_as_of`, `snapshot_date`, `observed_at`, or `period_start`/`period_end` | When the data is *accurate as of*. |

Why two: the pipeline can re-run any time, but the data describes a specific
moment. They diverge most for `route_performance` — we run weekly but the
underlying TfL PDF only updates every ~4 weeks, so `extracted_at` advances
weekly while `period_end` only moves forward each new period.

| Table | Purpose | Write pattern |
|---|---|---|
| `public.vehicles` | DVLA-derived master fleet (`registration → make`, `fuel_type`, `year_of_manufacture`, `month_of_first_registration`, `bonnet_no`, `operator`). | Upsert by `registration` every weekly run. |
| `public.route_snapshots` | One row per (route, week) carrying the **full route-card record** — operational facts (type, length, deck, propulsion, make, vehicle_type, vehicle_age_years, fleet_size, operator, garage, pvr, frequency, stop_count); reliability snapshot (service_class, ewt_minutes, on_time_percent, perf_period); contractual MPS (ewt_mps_minutes, otp_mps_percent, mileage_mps_percent); **current active contract** (current_contract_award_date, current_contract_cost_per_mile, current_contract_accepted_bid, current_contracted_annual_miles, current_contract_number_of_tenderers, current_contract_was_joint_bid, current_contract_awarded_propulsion, current_contract_awarded_deck, current_contract_awarded_operator); **latest-tender derivations** (previous_operator, last_award_date, last_awarded_operator, last_cost_per_mile, tender_award_count, number_of_tenderers, was_joint_bid, contract_term_years, awarded_propulsion, awarded_deck, prev_awarded_propulsion, prev_awarded_deck); **previous-operator contract detail** (previous_award_date, previous_cost_per_mile, previous_accepted_bid, previous_contracted_annual_miles, previous_contract_term_years, previous_number_of_tenderers, previous_was_joint_bid); **next-tender derivations** (next_tender_start, next_tender_year, next_tender_tranche, extension_eligible, next_award_propulsion, next_award_deck). All derivations live on this row so trend queries don't need JOINs. The v2.12 tender split is reflected in migration `0012_route_snapshot_tender_split.sql` — current_*, previous_* (full row) and last_awarded_operator are added there. PK `(route_id, snapshot_date)`. | Upsert per (route_id, snapshot_date) — re-running the same week replaces; fresh weeks append. |
| `public.route_vehicle_observations` | **Permanent** append-only log: route → registration → observed_at. Built from each Monday's TfL arrivals snapshot so we can ask "which buses ran the 25 in March 2026?" historically. Kept forever. | Insert this run's fresh observations only (filtered by `lastSeenAt === generatedAt` to avoid pushing rows already in the DB). |
| `public.route_vehicle_sightings` | **Rolling** daily log of route → registration → observed_at (migration `0013`). Written by `sample-vehicles.js` once a day, pruned to a ~70-day window each run so it stays small on the free tier. Its only purpose is to give the weekly build a dense recurrence signal; it is **not** the analytics history (that's `route_vehicle_observations`). Same `(route_id, registration, observed_at)` PK, service-role-only (carries plates). | Daily upsert (ignore-duplicates) + prune of rows older than the retention window. |
| `public.garage_snapshots` | One row per (garage, week). Carries name, operator, address, postcode, lat/lon plus per-week aggregates: `total_pvr` and `route_count` summed from `route_snapshots` of the same week, plus the route arrays (main / night / school) from `garages.geojson`. PK `(garage_code, snapshot_date)`. | Upsert per (garage_code, snapshot_date). |
| `public.route_performance` | Per-route reliability — EWT (Excess Wait Time) for high-frequency routes, OTP (On-Time Performance) for low-frequency. Sourced from `bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf` (TfL's QSI report). Carries `period_start`/`period_end` (the 4-week period the data describes) and `extracted_at` (when we parsed). PK `(route_id, period_label)`. | Upsert per (route_id, period_label) — TfL publishes a new PDF every ~4 weeks so the same row gets refreshed weekly until a new period appears, then a new row is inserted. |

**Recurrence RPC:** `public.route_vehicle_recurrence(p_since timestamptz)`
(migration `0013`, `SECURITY DEFINER`, service-role-only) aggregates both
observation tables server-side into one row per (route, reg): `sightings`
(distinct runs), `days` (distinct calendar days), first/last seen. The weekly
backfill calls it instead of streaming back hundreds of thousands of raw rows.

**RLS:** anon role reads `route_snapshots` only. Vehicles, observations, and
sightings are service-role-only — the public site has no path to a registration
plate. The analytics page (when it ships) uses aggregating views or RPC, never
raw SELECT on the locked tables.

---

## 4. Skip-if-unchanged & freshness watermarks

Every fetcher writes its own freshness watermark into its cached output and reads it back at the start of the next run. There is no central "scrape index" file — each cache *is* the index for its own upstream. This avoids two-source-of-truth drift (e.g. the index says fresh but the cache file is gone) and self-heals: a deleted cache triggers a full re-fetch automatically.

| Fetcher | Watermark | Skip rule |
|---|---|---|
| `fetch-data.js` | `data/geometry-source.json::zipDate` | List S3, compare new ZIP date; skip if equal. |
| `fetch-route-performance.js` | `route-performance.json::pdfModifiedAt` | `HEAD` request, compare `Last-Modified`; skip if equal. |
| `fetch-route-mps.js` | per-route `pdf_modified_at` + `lastCheckedAt` (28-day TTL) | Per-route `HEAD`; skip body when `Last-Modified` matches cache. Cold-start week parses ~700 PDFs; steady-state week is mostly HEAD-only. |
| `fetch-tender-programme.js` | per-year `pdf_modified_at` inside `tender-programme.json` | Per-year `HEAD`; copy entries forward when `Last-Modified` is unchanged. |
| `fetch-vehicle-fleet.js` | per-registration `lastCheckedAt` | 90-day TTL — re-query DVLA only when stale. Failed lookups (404 / network) are also cached so they don't hammer DVLA on retries. |
| `fetch-tenders.js` | btID presence in cache | Awards are immutable; never re-fetch a btID once cached. |
| `fetch-garages.js` | postcode presence in `geocode_cache.json` | Geocode only postcodes not yet cached. |

All skip-capable scripts accept `--force` to bypass the cache and re-fetch. `npm run refresh` runs the orchestrator, which honours these per-script skips automatically.

---

## 5a. Data-quality audit (scripts/audit-data.js)

Runs as the final build step (step 16 of 17, before the Supabase push). Walks every record produced by the pipeline and checks every field against plausibility constraints. Exits non-zero on CRITICAL issues, which hard-fails the weekly refresh — broken data never gets committed.

| Scope | What it checks |
|---|---|
| `route_classifications.json` | `typeCounts` partitions to `count`; every route has geometry in the overview; every `garageCode` exists in `garages.geojson`; enum fields (`type`, `propulsion`, `deck`, `lengthBand`, `frequency`, `serviceClass`) match known values; per-route numeric ranges (`pvr` 1..100, `fleetSize` 1..200, `vehicleAgeYears` 0..25, `ewtMinutes` 0..20, `onTimePercent` 30..100, `ewtMps` 0.5..10, `otpMps` 50..100, `mileageMps` 80..100, `lastCostPerMile` £3..60 regular / £3..200 school, `contractTermYears` 1..12, `numberOfTenderers` 1..12); date shapes are parseable and within sane year bounds; `previousAwardDate < lastAwardDate`; electric fleets aren't claimed to be >12 years old (electric London bus fleets are post-2015); `serviceClass=high-frequency` implies `ewtMps` is populated and vice-versa for low-frequency. The 13 non-passenger ghost routes (TfL-internal geometry returning HTTP 404 from `/Line/<id>`) are allowed to have null operational fields. |
| `vehicle-fleet.json` | Every key matches UK VRM shape (5-7 alphanumeric, ≥1 letter, ≥1 digit); `dvlaStatus` is one of {200, 404, null}; `fuelType` (after normalisation) is in the known set; `yearOfManufacture` 1990..current+1; `monthOfFirstRegistration` parses as `YYYY-MM` within plausible range. Any HTTP 400 record is flagged (those are the bonnet-number leakage the parse-time filter prevents going forward). |
| `garages.geojson` | Unique TfL garage codes (catches the BN/BT/UX upstream-CSV duplicates); coordinates within Greater London + nearby contract estates (lat 51..52, lon -1..1); PVR ≤ 800 (0 is permitted — reserve/training depots). |
| `route-vehicles ↔ vehicle-fleet` | Every observed registration has a matching fleet record. |
| `route-mps ↔ classifications` | `service_class` agrees between sources for each route (only a CRITICAL when the disagreement isn't already reconciled by the MPS-wins precedence rule in `build-classifications.js`). |
| `make ↔ model` | `make` (DVLA, observed) must be a plausible manufacturer for the `vehicleType` (LBR model string). Only asserted on models a single manufacturer builds complete (chassis + body): Metrocity / MetroDecker / Solo / Versa ⇒ Switch/Optare, Citaro ⇒ Mercedes, Yutong ⇒ Yutong. Chassis/body products (Enviro, Gemini, EvoSeti, Streetdeck…) are excluded because the make is the chassis maker and the model names the body, so they legitimately differ. A contradiction means the fleet make was contaminated by a vehicle that doesn't belong to the route. **WARN today** while the core-fleet filter (§3 step 13) drains these forward over weekly cycles; **promote to CRITICAL once the count hits zero** so a contradiction can never reach the app. |
| Freshness | Every cache file's `generatedAt` is within 8 days for weekly-refreshed files, 14 days for cached files updated only when upstream moves (MPS / programme). |

Output: `data/audit/data-quality.json` — full structured report, force-committed weekly so the history is diffable (regressions show up as new entries between consecutive weeks). Console output prints the first 30 of each severity for CI logs.

Run on demand:

```
npm run audit-data            # fail only on CRITICAL
npm run audit-data-strict     # fail on WARN too
```

**Current standing (2026-06-02 audit):** 0 CRITICAL · 29 WARN · 5 INFO. The 29 WARNs split into:
- **22 fleetSize/PVR ratios > 3** (75, 83, 120, 154, 156, 161, 186, 213, 245, 249, 252, 301, 304, 306, 337, 371, 422, 430, 436, 460, E2, E8, U3). Expected ~1.3 (operational fleet + spares). Cause: the per-route DVLA aggregator was attributing too many vehicles to a single route when those vehicles operate across multiple lines from the same garage. **Being fixed by:** the core-fleet filter (§3 step 13) drops one-off cover/reserve regs; the ratios fall as `sightings`/`days` accumulate over the coming weekly cycles.
- **4 make↔model contradictions** (117 ADL/Citaro, 134 Wrightbus/MetroDecker EV, 379 + H20 ADL/Metrocity EV) — same root cause as the ratio WARNs (contaminated fleet make). The new `make ↔ model` audit check surfaces these; they drain as the core-fleet filter takes effect, after which the check is promoted to CRITICAL.
- **1 vehicleAgeYears = 13.6 on an electric route (292)** — the LBR reference says electric, but the DVLA fleet includes ≥2015 hybrids that were inherited at handover. **Action:** investigate whether the route is mid-conversion (fleet snapshot pre-cutover) vs LBR mis-classified.
- **1 missing otpMps on route 533** (a low-frequency route). **Action:** check whether 533 is in the published MPS PDF; if so, the parser missed a row.
- **1 single-deck/double-deck reconciliation** flagged separately.

Beyond the data-quality audit, `scripts/audit-summary.js` cross-checks our propulsion against bustimes.org for the routes where they're scrapeable (193/747 covered): **43 disagreements** (16 ours=diesel/theirs=hybrid, 5 ours=diesel/theirs=electric, 13 ours=hybrid/theirs=electric, 9 ours=electric/theirs=other). Most look like vehicle-lookup blind spots — e.g. `Wright StreetDeck Electroliner` (electric), `BYD BD11` (electric), `Volvo BZL` (electric), `Volvo B5LH …` (hybrid). These reach the route card via the LBR vehicle-type string. **Action:** expand `data/vehicle-lookup.json` to cover the missing chassis/body strings, then regenerate `route_classifications.json`. Tracked separately so a single weekly refresh doesn't bundle a behaviour change.

---

## 5. Data hygiene & ingress sanitisation

We scrape from external sources (TfL forms, londonbusroutes.net, bustimes.org, DVLA, postcodes.io, TfL PDFs). The scraped strings flow through to public artefacts (`route_classifications.json`, `routes-overview.geojson`) and into the XLSX export. **Defence-in-depth policy: every freeform string is sanitised before it lands in a JSON cache.**

### Shared helpers in `scripts/_lib/`

The pipeline factors common patterns into a small set of helper modules so each script declares its config and stays focused on its specific upstream:

| Module | Exports | Used by |
|---|---|---|
| `_lib/env.js` | `loadEnv()`, `userAgent(scriptName)` | every script (loadEnv); HTTP-using scripts (userAgent) |
| `_lib/http.js` | `fetchWithTimeout`, `headLastModified`, `userAgentHeaders`, `DEFAULT_TIMEOUT_MS` | every fetcher that hits an HTTP source |
| `_lib/cache.js` | `loadJsonCache`, `atomicWriteJson`, `installSignalFlush` | sticky-cache fetchers (vehicle-fleet, route-mps, tenders) |
| `_lib/pdf.js` | `extractPdfRowsByPage`, `extractPdfRows`, `initPdfWorker` | PDF fetchers (route-performance, route-mps, tender-programme) |
| `_lib/sanitize.js` | `sanitizeText`, `sanitizeRecord` | every fetcher + every build step at the JSON-write boundary |

`userAgent()` reads the package version at module load so every outbound HTTP request stamps with the same value (`london-buses-map/2.8 (route-mps)`) — no per-script version drift.

**Sanitisation helper:** [`scripts/_lib/sanitize.js`](scripts/_lib/sanitize.js) exports two functions:
- `sanitizeText(value, opts)` — strips every HTML tag, every C0 control character (except `\n` and `\t`), decodes the named/numeric HTML entities the scrapers see in practice, normalises whitespace, and caps the result at `maxLen` (default 4000 chars).
- `sanitizeRecord(value, opts)` — recursively applies `sanitizeText` to every string leaf of an object or array. Used at the JSON-write boundary so structured records get sanitised in one call.

**Applied at two layers:**
1. **Ingress** — every `fetch-*.js` script either sanitises individual fields as it parses (e.g. `fetch-tenders.js` wraps the freeform `notes` / `joint_bids`) or passes its full output through `sanitizeRecord` at the `JSON.stringify` site. Cached files in `data/source/*.json` are guaranteed clean.
2. **Build-step output** — `build-classifications.js`, `build-overview.js`, and `build-garage-locations.js` re-sanitise their outputs at the public-artefact write site. So even if a future upstream is added to the pipeline without remembering to sanitise at its own ingress, the public files stay safe.

**What this guards against:**
- HTML/script injection from any upstream that becomes hostile (TfL form notes, LBR garage names, scraped PDFs).
- Control-character pollution (NUL bytes, BEL, etc.) that could break downstream tools.
- Pathological-length strings being committed to git via the weekly refresh.

**What this is NOT:**
- A replacement for frontend HTML escaping. The frontend already uses an `escapeHtml()` helper at every `innerHTML` site that interpolates data; the sanitiser is an additional layer at the data-flow boundary.
- A full HTML parser. The output of `sanitizeText` is plain text, not HTML — by design.

---

## 6. Known traps

- **Routes 700–799** — coach / excluded from geometry ZIP. No classification entry.
- **Route 969** — TfL Line endpoint returns nothing. Hard-coded in `fetch-route-destinations.js`.
- **N-prefix ≠ night-only** — if both N128 and 128 share a routes.htm `times/` URL, `128` is 24-hour. Derive, don't assume.
- **After-midnight hours ≥ 24** — TfL encodes night departures as `24:18` / `28:08` meaning 00:18 / 04:08 next day. Always wrap with `h % 24` before binning; without it every night journey lands at 1400+ minutes and misses every band.
- **Zero headway** — TfL returns `0` when a band has no service. Skip zeros when picking the representative headway; don't treat them as "high frequency".
- **Night-route schedule names** — TfL names night schedules things like "Friday Night/Saturday Morning" and "Mo-Th Nights/Tu-Fr Morning". `classifyScheduleName` in `fetch-frequencies.js` maps those to the correct weekday/Saturday bucket via first-match keyword.
- **Scraper encoding** — londonbusroutes.net sometimes serves Latin-1 mojibake (`2D­`). Decode fallback is required.
- **Vehicle lookup drift** — when operators refresh fleets, new `vehicleType` strings appear with null propulsion/deck. `update-vehicle-lookup.js` surfaces them; they must be filled manually.
- **Multi-garage routes** — some routes are shared across 2+ garages. We currently record only the primary; the classification record single-values it. Upgrading to arrays is a schema change for the frontend.
- **Geometry ZIP date** — the workflow only commits per-route files if the ZIP date changed, to avoid a 500 KB churn commit every week.
- **CI runtime** — the refresh is budgeted for <30 min; current p50 is ~6 min. If a scraper starts hanging, cap with per-request timeouts; don't let a single slow URL eat the 30-min ceiling.
- **iBus non-VRM rows** — for a subset of First's fleet, iBus's `Registration_Number` element carries the bonnet number (e.g. `2530`) or a `TMP*****` placeholder instead of a UK VRM. The parser in `fetch-vehicle-fleet.js` filters these at ingest (predicate: 5-7 alphanumeric chars, ≥1 letter, ≥1 digit) and the cache loader prunes any pre-existing junk on every run. Without the filter DVLA returns HTTP 400 for ~26 % of the fleet.
- **TfL tender form cost-per-mile errors** — TfL has occasionally pasted the full annual bid into the "Cost per live mile" cell of the tender result page (route 290 2006, route 265 2022, btIDs 1521 / 1148 / 2073). `fetch-tenders.js` clamps any value outside £0..200 to null at parse time and retro-sanitises the existing cache on load. Don't expect those tenders to have a cost-per-mile in the data; they truly don't have a recoverable one upstream.
- **TfL PDF cross-classification disagreement** — TfL's two QSI PDFs (the quarterly performance digest and the per-route MPS PDFs) occasionally disagree on whether a route is high- or low-frequency. The canonical case is H25, which the performance PDF lists under the high-freq table but whose MPS PDF says low-freq. `build-classifications.js` resolves this by trusting the MPS PDF (contractual; set per tender) over the performance PDF (a measurement that can misclassify). The wrong-class metric is then forced to null.
- **Ghost routes (non-passenger geometry)** — 13 route IDs are present in TfL's master geometry ZIP but return HTTP 404 from `/Line/<id>` and aren't listed by londonbusroutes.net or `garages.geojson`: `108D, 281N, 281R, 481D, T1-T3, UL13/19/26/30/40/61`. Best inference: rail-replacement variants, diversion codes, internal scheduling labels. They're allowlisted in `scripts/audit-data.js::GHOST_ROUTES` so the audit doesn't fire on their null operational fields. If the list grows, the audit emits WARNs for the new entries until they're either resolved or added to the allowlist after manual review.
- **Garage capacity is semi-manual** — per-garage operating-centre vehicle capacity (DVSA operator licence) is **not available via any bulk/API source**. The data.gov.uk OLBS CSV (`OLBSLicenceReport_*`) carries only the *licence-wide* authorised total (e.g. London General's one licence = 2507 across 19 garages), not per-operating-centre. The web service that shows the per-OC figure (`vehicle-operator-licensing.service.gov.uk/view-details/licence/<id>`) is **Incapsula bot-protected — HTTP 403 to fetch, the operating-centre search endpoint, AND both headless and headful Puppeteer**. So there's no server-side scrape. The workflow: run the **bookmarklet** in `capacity/extract-bookmarklet.js` on each operator's licence page (a real browser passes Incapsula) — it copies that licence's operating centres as JSON; paste each into `capacity/licences.json`. Then `npm run build-garage-capacity` matches each OC to a garage by postcode (same-operator preferred on collisions; larger figure = main depot over satellite; a name fallback covers near-miss postcodes) → writes `data/garage-capacity.json`; `npm run build-garage-locations` joins it into `garage-locations.json`. **Per-OC `vehicles` are individual authorised maxes — they do NOT sum to the licence total** (the total is a separate licence-wide cap), so don't use the total as a checksum. Capacity changes only at licence variation (~yearly). Frontend shows it as a Capacity KPI (absolute number) in the garage popup, garage drawer, and operator drawer (operator-level only when *every* garage of that operator has a figure).

---

## 7. Hosting & platform limits

| Dimension | Limit | Headroom today |
|---|---|---|
| **Cloudflare Pages** (free) | 500 builds/mo, unlimited bandwidth, 25 MiB per file, 20 000 files per deploy | We are static only — no deploy-time build. Largest deployed files are `stops.json` and `route_stops.json` at ~6 MB each (lazy-loaded on stop-search focus; ~1.3 MB each gzipped). Comfortably within. |
| **GitHub free plan** | 2 000 Actions minutes/mo (private repos; unlimited for public) | Weekly refresh uses ~6 min → ~25 min/mo. |
| **GitHub Actions job** | 6 h per job; 30-min timeout configured here | Plenty. |
| **Repo size** | No hard limit, but >1 GB warns; single file >100 MB blocked | Committed data ~3–4 MB. |
| **TfL API** | 500 req/min with key | Self-throttled to ~350. |
| **DVLA VES** (free tier) | ~15 req/s, 500k req/day | Self-throttled to 5 RPS. Sticky 90-day cache means weekly runs touch ~2–5% of the fleet (~200–500 calls), well under any limit. |
| **postcodes.io** | ~10 req/s bulk; no published hard cap | Cache hit rate ~100% on stable weeks. |
| **Nominatim** | 1 req/s, ≥1s between requests, UA required, 60s back-off on 429 | Photon is primary so we almost never hit Nominatim. |

**Secret storage:** `BUS_API_KEY` and `DVLA_API_KEY` live in GitHub Actions secrets and in a local `.env` (gitignored). They are used **build-time only**; the frontend fetches static JSON/GeoJSON. Vehicle registrations are kept server-side in `data/source/route-vehicles.json` and are **never** exported to the browser; only the per-route aggregates (`make`, `propulsion`, `vehicleAgeYears`, `fleetSize`) are surfaced.

---

## 7. Manual curation surfaces

- `data/route-overrides.json` — per-route field overrides; any set field wins over every other source.
- `data/vehicle-lookup.json` — vehicleType → `{ deck, propulsion }`. Run `npm run update-vehicle-lookup` after a refresh to discover new entries.
- `data/tender-overrides.json` — per-btID corrections for typos / row-shift artefacts in the upstream TfL tender form (e.g. btID 2010 had a misplaced `cost_per_mile` of 4,205,196). Applied during `push-to-supabase.js`.
- `capacity/licences.json` — raw DVSA operating-centre data (address + authorised vehicles per operating centre, per operator licence). The hand-curated source for garage capacity, refreshed via the `capacity/extract-bookmarklet.js` bookmarklet (no screenshots; see "Garage capacity is semi-manual" in §6). `data/garage-capacity.json` is **generated** from it by `npm run build-garage-capacity` — don't hand-edit the generated file. Then `npm run build-garage-locations`.

These files are the only hand-maintained data in the project. Everything else is regenerated weekly.
