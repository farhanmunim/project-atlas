# Changelog — Transit Instruments

---

## 2026-08-20 — Road-data source audit: STATS19 2025, OSM bridge cross-check

Farhan asked whether the accidents / roadworks / incidents / low-bridges sources
are the best available open sources. Audit findings + actions:

- **Accidents (STATS19)**: the full validated 2025 collision + vehicle files were
  live upstream while our year window stopped at 2024 — a whole year missed.
  YEARS now leads with 2026 (404s harmlessly until published, so future years
  arrive the day DfT ships them). Rebuilt: 7,507 collisions, 2021–2025 (1,464
  from 2025). STATS19 remains the only collision-level open source; TfL's Bus
  Safety quarterly dashboard is a candidate complement but tfl.gov.uk 403s this
  environment so it could not be validated — parked, not implemented.
- **Low bridges**: the EPOWR workbook's upstream Last-Modified is Oct 2019 — the
  "annual" refresh never happened. New `sources/osm-maxheight.js` (Overpass,
  POST + UA + Kumi mirror fallback, drivable-public-road classes only, segments
  clustered per physical bridge, metres+imperial parsed, unit-tested 7 cases):
  every EPOWR structure gets the nearest OSM reading within 75 m attached
  (osmHeightM/osmDeltaM), and OSM-only restrictions ≤4.5 m are appended as
  src:"osm" records — 516 cross-checked, 159 added (Rotherhithe Tunnel 2.0 m,
  Inner Temple 3.4 m…), 877 → ~1,036 structures. Enrichment is soft (Overpass
  down → EPOWR base stands); OSM_MAXHEIGHT_FILE env = dev fixture.
- **Roadworks / live incidents**: TfL Road Disruptions stays the right source
  (126 live rows, 121 works, at audit time). DfT Street Manager evaluated and
  rejected for now: registration-gated JWT API (not open), England-wide payload
  for marginal London gain over TfL's feed.

## 2026-08-19 — Gap-sweep fixes: letter backfill, 3-day roster union, PVR-0 honesty

From the external programmatic gap sweep:

- **Stop-letter backfill** (build/routes.js): the flag letter is a property of the
  physical stop, so bare stops (diversion-frozen or failed-fetch routes serving
  pre-letter last-good copies) now inherit the letter any freshly-fetched route
  recorded for the same NaPTAN id — fill-only, never overwrites. First run filled
  9,215 stops; zero unlettered routes and zero fillable gaps remain.
- **Fleet roster: 3-day union** (build/fleet.js): the assignments union now spans
  the last three tracked days, not just yesterday — a one-day operator feed
  outage (67/191/377/W6 had zero Aug-18 rows) can no longer blank a route's
  roster. Fleet: 7,986 regs, 608/642 routes with vehicles; remaining 34 empties
  are school routes that aren't running in the holidays.
- **PVR 0 → null** (sources/londonbusroutes.js): LBR prints PVR 0 where a route
  shares its bus with a paired route (389/399's single Barnet circular bus) —
  0 is a wrong value, null is an honest unknown; TVR follows.
- Verified-not-fixable (upstream absences, documented): 969/R10 PVR (absent from
  LBR AND the tender awards), 493 fleet string (LBR), tenders for 378/N118/SCS
  (absent from all 2,521 published TfL awards — N118 runs under a different
  operator than 118, so not bundled; SCS is a direct award), crowding for 34
  school routes + N118/N472/SCS/SL11 (all newer than the BUSTO year), garage
  PVR/capacity for out-of-area depots with no TfL allocations (Byfleet,
  Purfleet, Slough, Crawley… — derivation from route allocations gives 0).

## 2026-08-19 — Audit follow-up: propulsion downgrade path; 533 confirmed withdrawn

- **Propulsion downgrades** (reconcilePropulsion, lib/normalize.js): LBR's
  vehicle-type string is the CONTRACTED fleet — routes awaiting delivery run
  diesel/hybrid loans for months, so an EV/FCEV spec can over-claim. New guarded
  downgrade: ≥6 observed vehicles with ≤25% zero-emission overrides an
  electric/hydrogen claim with the observed majority (hybrid beats diesel on a
  tie). Electric counts toward hydrogen claims (DVLA reports FCEV as
  ELECTRICITY) so genuinely-hydrogen routes (7) never downgrade. route-meta now
  reconciles against the bustimes-corrected vehicles registry (falling back to
  the raw DVLA fleet mix), so N7's DVLA-diesel E40Hs land "hybrid" correctly.
  Result: exactly the four audited routes changed — 23 electric→diesel,
  200 electric→diesel, H20 electric→diesel, N7 hydrogen→hybrid; zero collateral
  (all 41 upgrades intact). test-functions 72/72 (6 new cases).
- **Route 533 stays absent — correctly**: withdrawn 15 Aug 2026 after 7 years
  (the Hammersmith Bridge shuttle, Hammersmith–Castelnau), replaced by the
  restructured 209. Both TfL's API and LBR have removed it; restoring it would
  fabricate a dead route.
- Verified stop letters ARE live in prod (auditor hit a stale edge cache) and
  that the tracked-reliability fixes are NOT yet running on the VPS — the
  atlas-ingest container needs a redeploy to pick up the merged code (nightly
  00:39 run still wrote SWT 24.63/306 deps with old code).

## 2026-08-17 — Audit batch 2: school routes restored, stop letters, garage corrections, tracked-reliability fixes

Second external-audit batch. Each claim verified before fixing:

- **37 school routes restored to route-meta** (676 routes, was 639). Cause was NOT
  an LBR regression (the auditor's guess) but our own TfL-scoping filter colliding
  with TfL's term-time behaviour: /Line/Mode/bus delists school-day-only services
  over the summer holidays (all ~35 6xx routes 404 from the Line API right now),
  and the filter dropped LBR's still-live contract records with them. The filter
  now exempts numeric school-band routes (5xx–9xx) that LBR knows (operator or
  PVR present — placeholder rows like brand-new 592 stay out). route-meta is
  documented as a superset of routes (~676 vs ~641). LBR's raw HTML entities
  (…&amp;amp;…) are now decoded at the source boundary too.
- **Stop-flag letters** — route-stops stops gain `letter` (TfL stopLetter, from
  the same Route/Sequence call — zero extra API cost): "Upton Park Station → A".
  Flows warehouse (route_stops mirror carries it automatically) → data →
  /api/v1/route-stops → both apps (/' stop popups show a letter roundel; /v2
  tooltips append "· Stop A"; the TfL live fallback seam carries it too) → docs.
- **Garage corrections**: route 86 removed from Lea Interchange's routes array
  (verified with our own tracking: 53 route-86 vehicles, 107 cross-route
  assignment rows, ALL on Romford NS routes, zero LI) via a new curated
  garage-route-fixes.json; CP Canons Park placed at HA7 1QA (London Sovereign's
  VOL operating centre, matching LBR's "Parr Road, HA7" — its licence match
  also corrects from London United to London Sovereign PK0002250) and NM North
  Mymms at AL9 7TS (Sullivan's Southern Cross garage, Swanland Road) — both
  previously sat on registered-office addresses ~13 km away.
- **Tracked reliability (v2) — two systematic faults fixed** (route 25 audit:
  SWT 24.6, OTD 5.9%, 143/306 non-arrivals):
  1. TfL publishes "Monday to Thursday" and "Friday" as separate schedules, both
     classifying as weekday — fetch-schedule concatenated them, doubling every
     departure (306 = 2×153). OTD then matched each real passing to one twin and
     called the other a non-arrival; scheduled_trips doubled, inflating
     lost-mileage. Departures now come from the single most representative
     schedule per day-type (_lib/schedule-pick.js, unit-tested).
  2. The overnight service break (25's 00:38→04:45, 247 min) entered Σh²/2Σh as
     a headway and alone pushed SWT 4.7→24.6. Scheduled gaps ≥90 min now split
     both series into service segments (SERVICE_BREAK_MIN, unit-tested; hourly
     LF services unaffected). Verified against the real 306-dep schedule row:
     SWT 24.6 → 3.99.
  Schedule rows self-correct as the weekly TTL rolls; tracked rows recompute
  nightly; pre-fix rows are recomputable via --day backfill.
- Remaining night-route propulsion staleness (N18/N118/…) resolves via the now
  fully-paginated assignments-union fleet roster + DVLA reconcile over the next
  nightly runs; 365 correctly held back by the 75% supermajority guard (3 of 5
  observed electric).

test-reliability-tracked 31/31 (9 new: service breaks, schedule-pick).

## 2026-08-17 — External-audit fix batch: propulsion classifier, fleet roster union, RATP purge, history offset

Fixes driven by Farhan's external audit feedback (Bromley TB staleness, registry
coverage gaps, Transport UK branding):

- **Propulsion classifier** (build/route-meta.js `propFromVehicle`, now exported +
  unit-tested): electric regex learns ADL's `E400EV`/`E200EV` spellings and Volvo's
  `BZL` chassis — fixes routes 314 and SL3, which LBR already described as electric
  but the classifier read as diesel. Routes whose LBR strings are genuinely stale
  (61, N171, 4, 365) self-correct via the fleet→reconcilePropulsion path below.
- **Fleet = daily roster** (build/fleet.js): the overnight live-arrivals sweep now
  unions yesterday's per-vehicle route assignments from our own public API
  (`history/vehicle-assignments`, paginated via the new `offset` param) — day-only
  and school routes (all of Bromley's) get regs, DVLA enrichment, and thereby
  propulsion reconciliation, despite the 03:17 UTC build time. Labels/docs across
  `/`, `/v2`, /docs, API.md, README, llms.txt now say "rostered"/"daily roster".
- **History API pagination**: `offset` (≤100k, PostgREST-native) added to
  `/api/v1/history/*` in both the prod Function and the serve.js dev mirror +
  discovery text + docs — enables walking full days of vehicle-assignments.
- **Transport UK ≠ RATP**: canonical operator renamed "Transport UK London Bus"
  (was "… (RATP)") in operator-aliases.json, londonbusroutes.js, both apps'
  colour keys/initials/samples; tenders recomposed offline from the 2,521-award
  byId cache (raw variants preserved on operatorRaw). "(RATP)" now appears 0
  times across route-meta/garages/tenders.
- **Tenders resilience**: index fetch soft-fails — a 403/network failure
  recomposes byRoute from the append-only award cache instead of aborting.
- Audit facts verified, not patched: 638/684 are absent from TfL's own Line API
  ("not recognised") — a TfL network-model scoping fact, not an Atlas data loss;
  the N18-class observed-electric routes were already corrected by the existing
  fleet-supermajority reconcile.

test-functions 66/66 (5 new propFromVehicle cases, rename check, VOL helpers).

## 2026-08-17 — Garage operator licences from the DVSA VOL register (automated)

Farhan asked for automated licensed capacities per garage. The VOL search
front-end is Incapsula-protected and session-tokened (human-only), so the
source is the DVSA bulk register export on data.gov.uk (OGL, ~weekly,
observed 0–14 days behind the live register):

- sources/dvsa-vol.js — fetches the London & SE OLBS CSV once per daily
  run, dedupes licence rows (repeat per director/TM), filters to PSV
  (P-prefix), indexes by operating-centre postcodes. Pure helpers
  (extractPostcodes, pickLicence) unit-tested (test-functions 60/60).
- build/garages.js — postcode-matches each garage to its best valid PSV
  licence → garages[].licence { number, holder, type, status,
  authorisedVehicles }. SEMANTICS GUARDED: authorisedVehicles is the
  LICENCE-wide legal ceiling (Ash Grove shows capacity 130 physical vs
  930 licence-wide for East London Bus & Coach across all its depots) —
  it never feeds utilisation. Soft-fail carries last-good licence blocks;
  a <20-match run is treated as degraded. First run: 63–65/86 garages
  matched (rest = postcode drift between garage and registered OC
  addresses — a future matching refinement).
- App: garage dossier gains an "Operator licence" section; the popup's
  capacity stat tooltips the licence-wide figure. Docs: /docs garages
  section (sources, capacity-vs-licence distinction, fallback), cadence
  row, API.md, README, CLAUDE.md source-catalogue note (front-end is
  never to be scraped).

Fully automated: rides the existing daily refresh; no new tasks, keys or
Coolify action.

## 2026-08-16 — Documentation audit sweep (all surfaces)

Full stale-spot audit after the week's features. Fixed: CLAUDE.md history
list gains vehicle-assignments; /docs lifecycle 00:37 line gains
vehicle_route_assignments_daily; /docs cadence rows gain
vehicle-assignments and route-destinations; /docs lost-mileage row gains
the burn-in caveat (14-day feed-health medians; filter confidence=high);
README tenders row now names the bid spread + contractedMilesPA;
ingest/RELIABILITY-METHODOLOGY.md gains section 8 — the tracked-v2
implementation mapped against the TfL spec (per-hour/QSI-point vs our
day-level/one-point simplifications, the two observed artifact modes,
the plausible-band display gate, and the promotion criteria).

## 2026-08-16 — First tracked data landed; display gates for the calibration window

Farhan completed the Coolify backlog (migrations 0032/0033 + PostgREST
restart — NOTIFY alone didn't reload the schema cache) and backfilled
Aug 14–15. First real results:

- vehicle-assignments: WORKING AS DESIGNED — 9,306 assignments / 7,260
  vehicles on the 14th, 1,817 (~25%) worked >1 route in a day (e.g.
  LV73FFH: route 86 daytime + N86 overnight). The intra-day allocation
  story is now permanent.
- reliability-tracked: two-sided burn-in artifacts confirmed — under-
  observed routes read wildly high EWT, duplicate/split observations read
  negative (route 100: −35 min). BUT the plausible band is already
  strong: 136 high-confidence high-freq routes on day 2 read mean EWT
  2.79 / median 1.86 min (TfL ~1.1). Responses:
  - builder log now reports class-consistent means + the plausible-band
    share (the old log mixed HF/LF and read far worse than reality);
  - apps gate the tracked display to confidence=high AND EWT −1…8 min
    (dossier, table, CSV in /; dossier in /v2) — the API deliberately
    keeps serving every raw row as calibration material, and /docs says
    so with filter guidance.

Still pending on Coolify: the diversions-refresh task hasn't fired
(dataset timestamp unmoved through two slots) — next check 23:17 UTC.

## 2026-08-16 — Vehicle-finder filter: ?reg= on the live GPS endpoint

Direction confirmed: Atlas's API is the data backbone for eventually
building our own LVF-style vehicle finder. The data was already complete
(identity = vehicles.byReg; per-day route history incl. mid-day moves =
history/vehicle-assignments; long sampled history = vehicle-sightings);
the one ergonomic gap was live position by registration — consumers had
to pull the whole-London feed and filter client-side.

- /api/live/vehicles (+ the /api/v1/live/vehicles mirror in serve.js)
  now takes ?reg=LX58CWU — comma-separable, case/space-insensitive,
  ANDs with ?line=. Filtering happens on the shared 10-s-cached snapshot,
  so upstream BODS load is unchanged.
- Docs: /docs live tables, API.md example, llms.txt gains the four-line
  VEHICLE-FINDER recipe, CLAUDE.md LVF note updated (finder capability
  fully native).

## 2026-08-16 — Per-vehicle daily route assignments (intra-day reallocations)

Farhan asked whether we capture a bus working route A in the morning and
route B at night. Honest answer: the 08:37 fleet sample structurally
can't (one observation per bus per day) — but the continuous tracker
already SEES every trip; it just wasn't persisted before the 16-day log
rotation. Now it is:

- Migration 0033 vehicle_route_assignments_daily — one row per
  (registration, route, day): trips, first_seen/last_seen window,
  km_observed; anon-read RLS; bundle regenerated (33 migrations).
- build-vehicle-assignments.js chained fourth on the 00:37 task; pure
  grouping in _lib/tracking-day.js (groupAssignments), unit-tested
  (43-check suite now) incl. the exact morning-A/evening-B case; same
  guards as the sibling builders.
- API: /api/v1/history/vehicle-assignments (both mirrors), filters
  reg/route/from/to; documented in /docs (endpoint + columns + the
  sightings-vs-assignments distinction), API.md, README, CLAUDE.md.
- Backfillable for logged days (trip logs keep 16 days):
  npm run build-vehicle-assignments -- --day=YYYY-MM-DD.

Coolify: needs migration 0033 pasted (batch with 0032) + the atlas-ingest
redeploy already outstanding.

## 2026-08-16 — route-destinations dataset (API-consumer request)

External feedback asked for a lightweight termini dataset ("Beckton
Station → East Ham" list labels) rather than downloading the ~2.5 MB
route-stops. Shipped end-to-end at zero upstream cost:

- build/routes.js derives route-destinations.json from the FINAL
  (post-freeze) stop sequences — canonical termini, never diverted ones;
  either direction may be absent (loop workings); validated ≥400 routes.
- /api/v1/route-destinations in prod Function + serve.js mirror +
  discovery; documented in /docs (own section), API.md, README, llms.txt.
- App: dossier Stops block now heads with "origin → destination" from the
  store; route-list CSV gains a Termini column.
- Other feedback triaged: network-pulse tile (queued — needs 0032 +
  lost-mileage burn-in), live vehicle position (already possible:
  /api/live/vehicles reg join), fleet-move detection (already possible:
  route-snapshots diffs; a derived endpoint is a candidate later).

## 2026-08-16 — Contracted tender mileage stored (derived), collector confirmed live

- Tender mileage: TfL does NOT publish annual mileage on award pages, but
  publishes both terms of the division — accepted bid (£/yr) and cost per
  live mile. The app derived it client-side only; now deriveAward()
  computes contractedMilesPA = round(acceptedBid ÷ costPerMile) at build
  time (null when either term missing or £/mile failed its sanity clamp),
  so the API serves it too. App prefers the stored value (client fallback
  kept for older data); CSV gains "Contracted miles/yr"; documented in
  /docs (Derived, with formula) + API.md. Unit-verified incl. clamp/null
  paths. Local tenders rebuild blocked (TfL 403s the sandbox proxy) —
  field populates on the nightly VPS refresh, which reaches TfL fine.
- Coolify audit vs prod evidence: collector IS live (lost-mileage rows for
  Aug 14+15; BODS key, 0031, redeploy, track-vehicles task all done).
  Early lost_pct reads high (mean ~30%) — expected burn-in: the feed-
  health medians need ~14 days before outage windows can be excluded, and
  confidence filtering applies. Outstanding: migration 0032 paste
  (reliability-tracked 404s) and the diversions-refresh task on
  atlas-refresh; one more atlas-ingest redeploy recommended to guarantee
  the tracked builder + geometry-mirror upgrade are in the container.

## 2026-08-15 — Tender bid spread: verified, semantics documented, CSV completed

Farhan asked whether TfL publishes highest/lowest/winning bids and whether
we should scrape them. Verified: we already do, since the Mandate era —
TfL's per-award pages publish "Accepted Bid", "Lowest Individual Compliant
Bid", "Highest Individual Compliant Bid" (+ tenderers, £/mile, joint-bid
note) and tfl-tenders.js parses all of them into the append-only byId
cache; coverage today 99%/99%/95% across 3,014 awards on 856 routes. They
flow to the API (tenders.byRoute), the dossier (bid range + winner +
premium calc), and the warehouse (tenders table).

New this pass:
- Semantics documented after an empirical check: acceptedBid < lowestBid
  in ~2/3 of records — NOT an anomaly; the low/high columns are the range
  of INDIVIDUAL compliant bids, while the accepted bid can be a cheaper
  package/joint award apportioned per route. /docs and API.md now state
  this with TfL's verbatim column names.
- CSV lockstep gap closed: route-list export gains Accepted/Lowest/Highest
  bid £/yr + Tenderers columns (they were in the API and dossier but not
  the export).
- Stale /docs freshness row updated for the intraday diversions refresh.

## 2026-08-15 — Fresher data everywhere it can be, within free limits

Farhan asked for the most current data possible. Audit finding: every live
feed was already at or near its upstream floor — the wins were the client
TTLs sitting above those floors, and diversions only rebuilding nightly.

- Live buses: default poll interval 15 s → 10 s (the BODS cadence + our
  10 s edge cache — the true floor; faster returns identical bytes).
- Selected-route live status 60 s → 30 s and live fleet 45 s → 30 s (TfL
  caches Status and Arrivals upstream at 30 s — the real floor).
- Live disruptions per selection 5 min → 60 s (a new diversion now shows
  in the dossier within a minute of selecting the route).
- Diversions dataset: new intraday diversions-only VPS refresh
  (REFRESH_ARGS="--only=diversions", cron 17 7,11,15,19,23 UTC) — the
  structured diff (missed stops/geometry) now lands within ~4 h instead of
  next morning. No script change needed (vps-refresh.sh already takes
  REFRESH_ARGS and skips empty commits); worst case ~186 Cloudflare Pages
  builds/month vs the 500 free.
- Deliberately unchanged: routes/stops (TfL revises at most daily — daily
  build is the right cadence), road incidents (upstream ~5 min),
  /api/live/vehicles edge cache (10 s = BODS's politeness floor), v2 bus
  poll (12 s). Free-limit headroom after changes: TfL ~500 req/min keyed
  (route-scoped calls, edge-shared), BODS one upstream hit per 10 s max.

## 2026-08-13 — UI polish batch: garage codes, clean-map defaults, colour hierarchy, TVR

Five requested changes, verified headless (termini counts, marker labels,
palette order, TVR maths) with zero JS errors:

- Garage badges now use the requested operator codes: SCL Stagecoach ·
  ARL Arriva · GAL Go-Ahead · TUK Transport UK · FRG First · MLN Metroline ·
  UNO Uno · FAL Falcon (OP_INITIALS map; unknown operators keep derived
  initials).
- Clean-map defaults on route search: stop markers now show TERMINI ONLY
  (start + finish anchor the route); the full stop sequence is behind the
  Stops layer toggle (default off, persisted opt-in). Live buses switch OFF
  on every fresh search — re-enable per selection. Legend updated.
- Operating garage: the permanent "Operating from here" label is gone; the
  marker now carries an amber accent ring + glow (.gm-hl), with the meaning
  kept discoverable on hover.
- Multi-route colour hierarchy: replaced the near-clashing palette with a
  deterministic ordered set — amber, cyan, violet, green, pink, azure,
  lime, purple — hues spaced for hard adjacent contrast at matched
  luminance; alert-red stays reserved.
- TVR (Total Vehicle Requirement) = floor(PVR × 1.13), full lockstep:
  derived in build/route-meta.js (recomputed when overrides change PVR;
  637 routes, zero formula violations on regen), served via route-meta,
  shown in the / dossier + table (new TVR column, colspan 20) + both CSV
  exports and the /v2 Route card (client fallback computes it until the
  API refresh lands), documented in /docs + API.md. metaOf() now passes
  tvr through.

## 2026-08-13 — EWT/OTD v2: tracked reliability estimator (phase 1, end-to-end)

The estimated-MPS revisit. Method: the observed side moves from ~30-min
Arrivals sampling (audited bias: EWT ~2.6 vs TfL ~1.1; OTD ~48% vs ~80%+)
to the continuous BODS trip tracker — every trip's timing-point passing
time (waypoint-trail interpolation) gives COMPLETE observed headways within
feed-healthy windows, removing the bias by construction. Storage: a
separate table so v1/v2/TfL-QSI calibrate against each other before any
promotion.

- Warehouse: migration 0032 route_reliability_tracked_daily (EWT/AWT/SWT,
  headway counts, OTD + on_time/early/late/non_arrival breakdown,
  passings_observed, feed_coverage_pct, confidence; anon-read RLS); bundle
  regenerated (32 migrations).
- Ingest: shared _lib/tracking-day.js extracted (trip-log/schedule/timing-
  point/feed-window loaders — build-lost-mileage refactored onto it, byte-
  identical behavior) + new build-reliability-tracked.js chained third on
  the 00:37 task. Same honesty gates: partial-day refusal, outage windows
  never spanned, soft-skips for missing log/env/table.
- API: /api/v1/history/reliability-tracked (prod Function + serve.js
  mirror), filters route/from/to/day_type/confidence.
- Apps: / dossier now shows "tracked" + "sampled" side by side in the
  Atlas-estimate block, table gains "Trk rel. (exp)" column (colspan 19),
  CSV gains Trk EWT/OTD/confidence/day columns; /v2 dossier shows
  ~EWT/~OTD tracked above the sampled line. All cyan EXPERIMENTAL.
- Tests: suite extended to 22 checks incl. an end-to-end synthetic day
  (trip log → waypoint passing times → EWT: perfect day reads 0.0, every
  5th trip missing reads ≈2.0); builder guard smokes; all suites green.
- Docs: /docs endpoint + full column reference + lifecycle/cadence,
  API.md, README, llms.txt, CLAUDE.md.

Calibration plan: 2–4 weeks of tracked vs sampled vs TfL quarterly QSI
per route; promote tracked to the headline estimate only on demonstrated
convergence. First rows the morning after the collector's first full day.

## 2026-08-13 — Route lines faithful to TfL (full-fidelity geometry end-to-end)

Farhan compared route 175 side-by-side with the old london-buses site and the
Atlas line looked angular. Diagnosis (verified, not assumed): the data was
correct — termini/stops/extent identical to TfL — but Atlas drew its
deliberately simplified overview (0.0005° RDP ≈ 31-pt median vs TfL's ~247)
for selected routes too. Fix, end-to-end:

- Pipeline: build/routes.js now emits data/route-geometry/<id>.json per route
  — TfL's RAW Route/Sequence ring, 5 dp, both directions + lengthKm, no
  simplification. Overview tightened 0.0005°/4dp → 0.0001°/5dp (empirically
  ~31% of raw points; median 62/feature; 1.8 MB raw / 425 KB gz).
- Freeze, smarter than the overview's blanket keep: the just-run diversion
  diff decides — structurally unchanged flagged routes (no missed/added
  stops, no published redraw) safely get their canonical ring written in
  full fidelity (119 of 147 frozen routes recovered at bootstrap, incl.
  175); structurally-changed ones withhold the file (last-good persists,
  absent → overview fallback). Stale files pruned on full runs.
- API: /api/v1/route-geometry/<id> in the prod Function + serve.js mirror
  (validated id, JSON 404 with fallback pointer, discovery entry).
- Apps: / ensureSeq and /v2 geometryFor are now detail-first — selected
  routes draw the road-faithful ring (175: 267 pts vs 28 before), network
  layer keeps the (now 5× finer) overview. Diversion overlay unchanged —
  separate, dashed, on top of the canonical line.
- Warehouse: mirror-reference-data upgrades route_geometry rows to the
  full-fidelity rings where published (overview coords stand elsewhere).
- Verification: new pipeline/verify-geometry.mjs cross-checks stored rings
  vs TfL live (point counts equal, max dev <1 m on all sampled routes;
  overview within stated tolerance) + 4 new validate-atlas checks (59
  total). Headless: / draws 267-pt 175 line, /v2 fetches route-geometry/175
  and renders — zero JS errors. Docs: /docs new dataset section +
  routes-overview corrections, API.md, README, llms.txt, CLAUDE.md.

## 2026-08-10 — EWT/OTD v2 groundwork: waypoint trails + tracked-reliability core

Preparation for replacing the biased sampled reliability estimate with one
derived from the continuous BODS tracker (audited bias: sampled EWT mean
~2.6 min vs TfL ~1.1; OTD ~48% vs ~80%+ — the ~30-min Arrivals sampling
under-observes short headways by construction).

- Trip tracker now records a sparse waypoint trail per trip
  (`wp: [[minuteFromStart, alongKm]…]`, one point per ≥2.5 min, cap 48 +
  endpoints) so passing times interpolate on the trip's REAL pace per
  segment instead of one flat speed. Landed before the collector's first
  deployment so day-one trip logs already carry trails. Old checkpoints
  without `wp` still close cleanly (resume-compatible).
- `estimatePassingMin` (lost-mileage lib) upgraded: piecewise-linear over
  the cleaned monotone trail when present; whole-trip clamped-speed line as
  fallback/extrapolation. Benefits the lost-mileage matcher immediately.
- New pure core `_lib/reliability-tracked.js` — daily EWT (AWT−SWT, each
  Σh²/2Σh) and OTD (−2…+5 min, unmatched departures = non-arrivals) from
  timing-point passing times, computing headways only WITHIN feed-healthy
  windows (an outage gap is never a service gap; departures inside outages
  are unmeasured, not non-arrivals). Not yet wired to a builder/warehouse
  table — that's the EWT/OTD v2 build proper (planned, pending approval).
- Tests: test-lost-mileage extended to 38 checks (waypoint capture, pace-
  aware interpolation, cap, resume-compat); new test-reliability-tracked
  suite, 19 checks against hand-computed QSI references (uniform → SWT h/2,
  15/5 bunching → AWT 6.25, every-4th-missing → EWT 2.5, boundary ±,
  outage-window honesty pairs with controls). Live smoke: 4 min against
  real BODS — 7,160 open trips, 100% carrying trails, 0 malformed,
  monotone time verified.

## 2026-08-10 — Experimental gross lost-mileage estimator (end-to-end)

New daily per-route GROSS lost-mileage estimate — "which routes' scheduled
trips never ran" — from continuous BODS trip tracking, full lockstep:

- Warehouse: migration 0031 `route_lost_mileage_daily` (PK route_id+day; trips
  scheduled/measured/observed/matched/lost/curtailed, km scheduled/operated/
  lost, lost_pct, unmeasured trips/km, feed_coverage_pct, confidence,
  anon-read RLS); bundle regenerated (31 migrations).
- Collector: `ingest/scripts/track-vehicles.js` — long-lived daemon polling the
  BODS SIRI-VM London bbox every 25 s through a per-vehicle trip state machine
  (`_lib/trip-tracker.js`: open on first on-route fix, close on line/dir
  change, 150 m off-route streak, or 10-min gap; geometry projection via
  our own routes-overview). Daily JSONL trip logs + per-operator hourly
  feed-health counts on the /app/data volume, 16-day retention, SIGTERM
  checkpoint of OPEN trips only (resume ≤30 min; a smoke test caught and
  fixed a flush-then-save double-write). Scheduled Task every 30 min as a
  keepalive via run-task.sh's lock. Needs BODS_API_KEY on atlas-ingest.
- Matcher: `build-lost-mileage.js`, chained after build-reliability (00:37) —
  interpolates each outbound trip's passing time at the route's timing point
  (route-stops projected onto geometry), greedy-matches to route_schedule
  departures ±12 min; unmatched = lost, <85% coverage = curtailed; operator
  feed outages (hourly count vs 14-day median, 40% floor) excluded as
  UNMEASURED, never lost; refuses partial collector days (<500 trips
  network-wide); soft-skips missing log/env/table. Calibration target: TfL's
  quarterly ~3% lost. Unit suite `test-lost-mileage.js` — 28 checks.
- API: `/api/v1/history/lost-mileage` (prod Function + serve.js mirror) —
  filters route/from/to/day_type/confidence.
- Apps: `/` dossier "Lost mileage" card in the Atlas-estimate block, table
  column "Lost mi (exp)", CSV export columns; `/v2` dossier "Lost mileage —
  Atlas estimate" section. All cyan/~-prefixed EXPERIMENTAL.
- Docs: /docs (endpoint row, full column reference, methodology, cadence,
  lifecycle diagram), llms.txt, README, API.md, CLAUDE.md, SELF-HOSTING.md
  (new task row + BODS_API_KEY env). reliability-daily's lost_km columns
  marked superseded for lost-mileage questions.

Honesty rules: gross by construction (no in-/out-of-control split — says
trips didn't run, not why); never comparable to TfL's contractual
deductions; feed outages are unmeasured, not lost. First rows appear the
morning after the collector's first full day.

---

## 2026-08-10 — Drop TfL's misattributed statuses (the 376/379 class)

Farhan spotted route 376 carrying a Special Service note about route 379.
Verified against TfL directly: the record ("YARDLEY LANE, E4: Route 379 will
be on diversion due to a parked vehicle…", validity April→November) is
attached to line 376's status while route 379 itself reports Good Service —
a genuine TfL data fault, wrong line AND missing from the right one. New
routesNamedIn() in lib/tfl-status.js parses route names cited in a reason
("Route 379 will…", "ROUTES 238 and 376", "Routes 304 & 376:", lettered
forms); build/diversions.js drops any status whose reason names routes that
do not include the flagged line (road-only prose is untouched; precision
over recall — genuinely affected lines carry text naming them). Applied to
both the active-candidate and upcoming-freeze paths, with an observability
count in the run log. First run: 18 misattributed statuses dropped
network-wide (the fault is a class, not a one-off); 376 keeps its two
genuine works (Plashet Grove, Boundary Lane), 379 stays absent; dataset
161→159. 8 new unit cases (test-functions 56/56) · validate-atlas 55/55 ·
docs updated (live-status caveats + route-diversions detection).

---

## 2026-08-10 — Vehicle body/type enrichment: DVLA → bustimes.org → LBR chain

Farhan set the vehicle-data source priority: DVLA first, then an LVF-class
community source, then londonbusroutes. Investigated LVF (lvf.io) honestly:
it is a login-gated vehicle FINDER built on TfL location data — no make/body
register, and the finder capability (reg ↔ route, history) is already native
to Atlas (vehicles + history/vehicle-sightings). The community source that
genuinely carries spec data is bustimes.org, with an open documented REST
API — verified live: vehicle_type.name gives chassis + BODY ("Volvo B5LH
Wright Eclipse Gemini 3"), plus deck, operator fleet code, and a fuel value
that corrects DVLA's known hybrid misreporting. New sources/bustimes.js
(normaliser unit-tested; politeness: one lookup per reg EVER, misses
re-checked monthly, ~300ms spacing, 250-lookup run cap, backoff-and-stop on
429/5xx, identified UA, persistent committed cache vehicle-body-cache.json).
build/vehicles.js now enriches under the priority contract: DVLA values
never overwritten; bustimes fills body/deck/fleetCode; ONE documented
exception — bustimes hybrid/electric upgrades a diesel/null bucket, flagged
propulsionSource:"bustimes". First live run: 250/662 regs enriched (cap),
159 hybrid misreports corrected, deck vocab clean. Lockstep: migration 0030
(vehicles body/deck/fleet_code/propulsion_source) + bundle + mirror step;
live-bus popup shows fleet code + body; docs page vehicles section rewritten
with the chain + LVF verdict; llms.txt, README, API.md, catalogue (bustimes
promoted to active source; LVF catalogued as not-a-source with contact
path). validate-atlas 55/55 (5 new checks) · test-functions 48/48.

A running log of major features. Each entry: **what** we built, **how**, and **why**.
Newest first. Dates are when the work landed.

---

## 2026-08-10 — /docs for humans AND agents: joins, vocab, limits, examples, llms.txt

The 100%-comprehension pass. New sections: Keys & limits (key NAMES and where
they live — never values; every limit a consumer can hit: no caller key, no
enforced rate limit today but edge-cache TTLs are the real floor, history
limit<=1000/default 200, payload sizes); Every endpoint (the complete URL
inventory incl. the legacy GPS path and the filter grammar); How everything
joins (the key map — the three route-key conventions (lowercase id, published
name, UPPERCASED perf keys), NaPTAN/reg/garage/borough/direction joins, the
ONS-code-vs-name borough inconsistency stated honestly); Vocabularies &
formats (every closed value set incl. the TfL severity scale, plus format
rules: camelCase vs snake_case, [lng,lat] vs lat/lng vs the road-disruptions
point-string, the non-ISO date exceptions, null-means-unknown); Worked
examples (runnable curl+jq for discovery, per-route bundles, diversions,
live, history trend/diff); For AI agents (deterministic integration rules).
Plus /llms.txt at the site root (llms.txt convention): a condensed
machine-readable summary of entry points, join rules, vocabularies and
semantics — linked from the docs page; serve.js mirrors it with text/plain.
Now 30 sections / 32 tables / 232 field rows. Verified: zero overflow
320-1280px, no broken anchors, zero JS errors, llms.txt 200.

---

## 2026-08-10 — /docs completeness pass: history row columns, live payloads, shape fixes

A programmatic completeness audit (walk EVERY record of every dataset for the
union of field paths + pull real rows from every history and live endpoint,
then diff against the docs text) found and fixed real gaps: (1) the
route-classifications shape was documented wrong — it is a flat
{ [id]: {name,type} } map with no routes envelope; (2) the entire history
group's ROW COLUMNS were undocumented — now every endpoint has its full
column list with semantics, including route-snapshots' ~60-column CDC record
(identity / vehicle & fleet / operation / performance & MPS / the complete
current_contract_* and previous_* award families / the forward tender view)
and honest caveats (lost_km reflects sampling coverage; snake_case vs
camelCase; garage-snapshots uses lon not lng); (3) the live TfL passthrough
payloads now have key-field tables — status (severity codes, the isNow and
empty-affectedStops caveats), disruptions, arrivals (vehicleId joins,
timeToStation, timeToLive), road-disruptions (including the point-is-a-
JSON-string quirk); (4) the /api/v1 discovery response is documented;
(5) fleet field-presence + gas-bucket caveat; (6) manifest lastError
persists after recovery — judge health by status. Now 26 tables / 183 field
rows; audit re-run: every data leaf, history column and live field name
appears in the page. Verified: no overflow, no broken anchors, no JS errors.

---

## 2026-08-10 — /docs: the complete API data reference

New documentation page at atlas.farhan.app/docs (docs/index.html — single
self-contained page on the shared tokens, dark/light via the shared settings
key, served by Cloudflare Pages directory-index + a serve.js dev mirror route,
linked from both apps' chrome). Documents every dataset and every field the
API serves — ~166 field rows across 23 tables: meaning, upstream source,
exact processing (derivations, canonicalisation, decode tables, comma-
convention handling, band lower-bound safety rule, etc.), validation gates
with their real bounds, fallback tiers, upstream cadence vs our refresh
cadence, plus the live group (params, TTLs, SIRI-VM fields), the history
group (filters, methodology incl. the EWT formula and the experimental
labelling), an integrity section (the 50/43/18-check validation stack) and
licensing/attribution. Field inventory generated from the live data files;
processing facts extracted from the builders — including honest caveats
(fleet is a point-in-time sample; contractStart/End is an 8-route curated
map pending the OCDS ingester; BUSTO omits school routes). Verified headless:
zero JS errors, all nav anchors resolve, zero horizontal overflow 320–1440px,
theme toggle works, /docs links live in both apps.

---

## 2026-08-05 — iBus geometry source, degraded-feed gates, full source audit

Farhan's hunch confirmed: ibus.data.tfl.gov.uk is a public S3 bucket of dated
fortnightly schedule releases, each shipping Route_Geometry_<ver>.zip — one
XML per route of ordered lat/lng per direction, TfL's own AVL path, keyless,
back to mid-2025. Verified against the W12 story: the 20260703 drop passes
Selborne Walk at 7 m (true baseline, 310 pts), 20260731 carries the diverted
line 207 m away and passes every temporary stop at 3–11 m. New
`sources/ibus.js` (S3 listing + dependency-free zip reader + parser, all
unit-tested) and an automatic recovery tier in build/diversions.js: when a
flagged route shows missed stops but no geometry diff (a polluted baseline),
it walks the dated iBus versions and diffs against the first one whose line
passes all the missed stops — proven end-to-end by deliberately re-polluting
W12's baseline and watching it recover as `baselineSource: ibus:20260703`
with the correct segments. Zero downloads unless recovery is needed.
The audit also caught a live TfL failure mode: the bulk /Line/Mode/bus/Status
intermittently returns an all-Good-Service snapshot while per-line calls still
carry the disruptions — which would have emptied the diversions dataset AND
the freeze set. Both build/diversions.js and build/status.js now gate on it
(zero disruptions after a run that saw many = degraded snapshot → retry once,
then keep last-good). New `pipeline/check-sources.mjs` sweeps every consumed
source (TfL Unified, iBus incl. a deep geometry cross-check vs the store,
BODS, DVLA key, londonbusroutes, postcodes.io, EPOWR, Datastore CKAN, STATS19,
BUSTO, Overpass, QSI host, tender pages): 18/18 healthy. Probing also fixed
two wrong assumptions (STATS19 is GET-only; Overpass requires a User-Agent).
test-functions 43/43 · validate-atlas 50/50 · verify-diversions 12/12.

---

## 2026-08-05 — W12-class baseline recovery from git history + advance freeze

Farhan was right: the W12 diverted geometry DID exist. Walking the daily data
commits showed the stored line passed Selborne Walk at 3 m through 9 July,
then read ~213 m away by the 19-July snapshot — TfL redraws Route/Sequence
~10 days IN ADVANCE of a planned closure, so routes flagged only when their
window opens had already had their baselines silently overwritten (the
"polluted baseline" class: missedStops fire, diversionSegments empty). Two
fixes. (1) `pipeline/backfill-diversion-baselines.mjs`: for every route with
that signature, walk the data-commit history newest→oldest and restore the
first snapshot whose line passes ALL the episode's missed stops within 60 m —
self-validating recovery. All 18 polluted routes recovered (W12 from the
17-July snapshot); published-geometry episodes went 8 → 18. W12's recovered
diversion path passes its 17 temporary added stops at 3–11 m and the bypassed
segment passes the Selborne stops at 2–3 m — independent confirmation.
(2) Advance freeze: `windowStartsWithin` (lib/tfl-status.js) + a 14-day
lookahead in build/diversions.js — routes whose diversion window opens soon
join the freeze set (dataset field `upcomingFreeze`, honoured by the routes
builder's fallback too), so an advance redraw can never overwrite a canonical
baseline again. test-functions 39/39 · validate-atlas 50/50 ·
verify-diversions 12/12 · zero JS errors.

---

## 2026-08-05 — Diversion noise control + unit-validation suite; front-end kept as verification layer

Hardening pass on the diversions feature. The tier-3 live-GPS estimator now
actively rejects dead runs: pings within 300 m of any garage are never
captured, and a trace is only drawn if it's ANCHORED — first and last points
within 200 m of the route line, i.e. the bus left the corridor and rejoined
it. A garage/positioning journey leaves and never comes back so it can never
anchor; a bus mid-diversion isn't drawn until it rejoins. Newest 6 traces max.
New `pipeline/test-functions.mjs` (35 checks) validates the custom functions
against independent reference implementations: tfl-status validity-window
logic (incl. the W12 isNow regression case), distToLineM vs haversine (±0.5%),
deviatingSegments thresholds, lengthKm/simplify, and the normalize.js
DVLA/operator canonicalisation. It caught a real gap: the segment noise filter
measured path length, which a single-vertex spike's legs alone can exceed —
now filters on leave→rejoin separation (≥150 m of roadway actually bypassed)
with a ≥400 m travelled-distance escape for loop diversions. Rebuilt against
live TfL: same 8 published-geometry routes survive, spike-noise hole closed.
Full re-verify: test-functions 35/35, validate-atlas 50/50,
verify-diversions 12/12 (zero JS errors), dev /api/v1 byte-parity 18/18.
Decision recorded in CLAUDE.md: Atlas is primarily the API, and `/` + `/v2`
stay as the deliberate visual-verification layer the headless scripts drive —
not to be removed.

---

## 2026-08-05 — Route diversions: automatic detection, real diverted geometry, baseline freeze

Diversions are now a first-class, fully automatic dataset. TfL publishes no
structured diversion data (the status feed's affectedRoutes/affectedStops are
always empty) — but for planned diversions TfL *redraws* Route/Sequence
(verified on W12/Selborne Road: the stop list drops the missed stops, the
lineString follows the diversion roads, live buses track it within metres). So
`pipeline/build/diversions.js` detects flagged routes from live bus status
(new `lib/tfl-status.js` — TfL's validityPeriods.isNow is unreliable for
in-progress works, date windows are checked directly; build/status.js fixed
too) and diffs TfL's current sequence against our canonical baseline →
per-direction missedStops / temporary addedStops, and the real diverted
geometry (diversionSegments + bypassedSegments) when TfL has redrawn
(geometryStatus "published" vs "unpublished"). Critically, the builder runs
BEFORE build/routes.js and hands it the flagged set: the routes builder now
FREEZES last-good stops+geometry for diverted routes, so a temporary diversion
never silently overwrites the canonical route (the pre-existing bug: the store
had absorbed W12's diverted state as if permanent). Self-heals when episodes
end. Served at /api/v1/route-diversions (Function + serve.js mirror), mirrored
to warehouse route_diversions (migration 0029, append-only per episode →
automatic diversion history), validated in validate-atlas (7 new checks).
App `/`: three-tier map overlay (store diff dashed amber + bypassed dotted red
+ missed/temporary stop markers → live text-parse fallback → live-GPS
estimated dashed cyan traces for unpublished geometry), upgraded dossier
diversion panel, Diverted table column, CSV columns (route list + per-stop
flags), legend entries. App `/v2`: always-on divnLayer overlay + Route-card
Diversion section. First live run: 161 active episodes, 8 with published
geometry. Zero new crons or secrets — rides the existing daily refresh and
ingest mirror.

---

## 2026-07-27 — API verification sweep + National Highways feed retired

Full verification pass of the public API against the committed data: all 17
`/api/v1` datasets byte-identical across the store, the dev mirror, and
production; live group cross-checked against TfL direct (676 lines, ids
aligned); all 9 history endpoints serving fresh warehouse rows with filters
honoured; prod Functions ↔ serve.js endpoint tables in sync. One casualty
found: National Highways withdrew the keyless UnplannedEvents RSS (every
legacy URL — m.highwaysengland.co.uk, trafficengland.com, m.highways.gov.uk —
now funnels to a 404 on nationalhighways.co.uk; the replacement API is keyed).
`/api/v1/live/national-highways` now returns an honest `410 Gone` with a
pointer to `road-disruptions` instead of a permanent 502, the dead fetch/parse
code is gone from both Functions, and `/v2` no longer fires a doomed request
per refresh (road incidents = TfL control centre only). Docs updated
(README + API.md). If SRN events are ever wanted back, the keyed National
Highways API (api.data.nationalhighways.co.uk) is the route — needs a
registered key as a Cloudflare secret, like BODS.

---

## 2026-07-04 — Legacy Supabase history import script

Farhan recovered the old Supabase project's direct-database password, which
reopens the history we couldn't export during the migration (the Data API was
dead but raw Postgres still answers). `ingest/db/import-legacy-supabase.sql`
attaches the old DB to the new warehouse over `postgres_fdw` (session pooler,
IPv4 — the direct host is IPv6-only and unreachable from Docker) and merges
13 tables of history: route/garage CDC snapshots, vehicle observations +
sightings, QSI periods, our reliability dailies, arrival samples, tenders the
cache lost, tender programme, accidents, BUSTO years, schedule states.
Conflict-safe by construction — natural-key tables use ON CONFLICT DO NOTHING
(new rows always win), tender_programme dedupes with a null-safe NOT EXISTS
(its unique key has nullable columns), arrival_samples imports without its
surrogate id and only rows recorded before the new DB's earliest sample.
Column lists are computed as the old∩new intersection so schema drift can't
break it, and the foreign server (with the stored password) is dropped at the
end. Dress-rehearsed on a local Postgres 16 pair seeded with edge cases:
correct counts, drift tolerated, second run imports zero. Runbook section
added to ingest/SELF-HOSTING.md.

Run against the real thing it recovered ~116k rows: 8,964 route snapshots,
95,963 vehicle observations, 4,260 reliability dailies, 3,262 departed-fleet
regs, 1,192 garage snapshots, 671 QSI periods, 2,028 schedule states, 111
programme rows (tenders/accidents/crowding: 0 — already complete from the
rebuild).

**Follow-up fix: the PostgREST 1000-row cap.** The recovered volumes exposed
three warehouse READS that never paginated (fine at post-rebuild sizes,
truncated now): `backfill-route-vehicle-sightings.js` (the recurrence RPC —
was silently capped at 1000 of ~15k rows) now pages with a stable order;
`sample-headways.js` pages `route_schedule` newest-first and keeps each
route's latest snapshot (it previously read the table unfiltered — with
history imported it could have picked stale timing points); and
`build-reliability.js`'s pager pins a deterministic ORDER so pages can't
overlap/skip on multi-page scans.

---

## 2026-07-03 — v2 "TfL print style" (consultation-map look)

A new Layers toggle in `/v2` that restyles the map after TfL's printed
consultation maps (the "Routes 19 and 38 — proposed" genre): a light,
label-free CARTO voyager base; each selected route drawn as a solid colour
line over a white casing, coloured per route from a consultation palette
(red / pink / navy / green …); route-number lozenges spaced ~every 4 km down
each corridor; place names re-styled to spaced-caps grey with a white halo;
white-filled stop rings; and a paper "Key" card (bottom-left) listing each
route's lozenge + termini. Implemented as `data-mapstyle="print"` on `<html>`
plus a per-route split of the corridor segments (`state.routeSegDetail`) so
multi-compare colours each route separately — the dark glass design stays the
default and everything reverts cleanly on toggle-off. Persisted in the shared
settings key (`printMap`); enabling it auto-enables Place names (the point of
the style). Hidden while the Crowding colour layer owns the line (V/C bands
are the signal there). Validated headless: lozenge count/colours, Key rows
(termini), 530 place labels, clean revert, no page errors.

---

## 2026-07-03 — Everything operational refreshes daily

All operational datasets now re-pull daily instead of weekly, in both loops:
the static store's TTLs (routes, route-meta/PVR/operator/garage, garages,
tenders, performance → 1 day; fleet/vehicles already daily) and the warehouse
full refresh (Mon-only → every day at 09:23 UTC), so `route_snapshots` /
`garage_snapshots` accrue one row per route per DAY — the granularity the
fleet-move / PVR-change / propulsion-change analysis wants. Cheap by
construction: conditional requests (ETag/Last-Modified), incremental tender
fetches and the capped DVLA cache mean an unchanged upstream costs almost
nothing. The four annual publications (STATS19, EPOWR bridges, BUSTO
crowding, OSM localities) stay on monthly re-checks — daily would only
hammer sources that change once a year.

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
- **TfL geometry schema change caught + fixed:** TfL renamed the Route_Geometry XML
  root from `TransXChange` to the namespaced `rg:Network_Data`, so every one of the
  749 ZIP entries parsed to null — step 1 "succeeded" with 0 routes and cascaded into
  0-route classifications and an empty route_snapshots push. `parseRouteXml` now
  accepts all observed roots, and the extraction is a hard validation gate (<400
  routes written → throw, keep last-good) instead of silently poisoning the index.

**Verified populated** (all 19 tables): vehicles 9,441 · accidents 7,118 · tenders 2,509 ·
tender_programme 1,240 · route_snapshots 749 · route_schedule 676 · route_performance 667 ·
bus_crowding 606 · observations 6,753+ · route_stops/route_geometry 1,345 · bridges 877 ·
crowding_profile 606 · localities 530 · garage_snapshots 65 — the three sampler tables
(arrival_samples, route_reliability_daily, route_vehicle_sightings) fill on their crons.

## 2026-07-03 — All automation on the VPS: GitHub Actions fully retired

The static-store refresh (the last GitHub Action) moved to the VPS, completing the
"code on GitHub, site on Cloudflare, everything else ours" architecture. GitHub is now
plain git hosting + the Pages deploy trigger; `.github/workflows/` is empty.

- **New `atlas-refresh` Coolify resource** — `pipeline/refresh.Dockerfile` (idle
  node:24-alpine + git) with `pipeline/vps-refresh.sh` on a Scheduled Task at
  03:17 UTC daily, replicating `refresh-data.yml` exactly: fresh shallow clone →
  `npm ci --omit=dev` → `pipeline/run.js` → `validate-atlas.js` as a hard gate
  before any commit → commit `data/` as `transit-instruments-bot` → push with
  rebase-retry → the push triggers the Cloudflare Pages rebuild. A `/work` volume
  persists the HTTP validator cache; a lock dir prevents overlapping runs; auth is
  a fine-grained PAT (`GIT_PUSH_TOKEN`, contents:rw on this repo only).
- Verified end-to-end (43/43 validation checks, bot commit pushed from the VPS,
  Pages rebuilt), then deleted `refresh-data.yml` and the four `ingest-*.yml`
  workflows (their cadences run as the atlas-ingest Scheduled Tasks).
- **Task-timeout fix (same day):** Coolify's ScheduledTaskJob killed the headway
  sampler ("has timed out") — it's a ~15–18 min multi-sweep by design, and the
  weekly/nightly refreshes are just as long. All five tasks now run detached via
  wrappers (`ingest/scripts/run-task.sh`, `pipeline/vps-refresh-task.sh`): the task
  returns instantly, work continues in-container, per-name `/tmp` locks prevent
  overlap (in /tmp so container restarts can't strand a stale lock), output in
  `/tmp/task-<name>.log`. Trade-off: Coolify always reports success — failures live
  in the logs and surface as stale data.

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
