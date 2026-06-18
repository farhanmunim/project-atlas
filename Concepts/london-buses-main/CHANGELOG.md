# Changelog

All notable changes to **London Buses**, summarised by release.

Tags: **NEW** new feature · **FIX** bug fix · **DATA** data & coverage · **UX** user-facing improvement.

---

## Upcoming

- Analytics page reading from the historical store — charts and trends across the network (fleet-age trend, electrification, operator share, fleet capacity, operator churn).
- **30 Oct 2026 — historical-store Data API grant change.** The hosted Postgres provider is removing the implicit Data API grant on `public`-schema tables. All existing tables in this project keep their grants. Any new table or view added on or after that date must include explicit `GRANT` statements + RLS — `db/migrations/_template.sql` is the new starting point. See the internal data notes for the procedure.

---

## v2.13 — Garage popup parity & small UX touches

_2026-06-02_

- **NEW** Clicking a garage marker exposes the same **View all routes operated here** CTA that's been on the side drawer — same shape, same downstream behaviour. Filters the network to that garage's routes without opening the drawer.
- **NEW** Both CTAs also flash the "Operating from here" tooltip above the chosen garage marker — the same visual that fires when a single route is focused now fires for a garage. New `highlightGarageByCode(code)` helper in `js/map.js` keeps the two entry points (popup + drawer) in lockstep.
- **NEW** Colour swatches on the Route Type filter pills — only when colouring routes by type — so the legend connection between pill and line is direct. `paint-mode.js` toggles `html.paint-by-type`; CSS reveals the dots only when that class is on.
- **FIX** Route 339's tender block showed Tower Transit as the awarded operator next to Stagecoach London as the current operator — both correct historically, confusing together. Stagecoach acquired Tower Transit's Lea Interchange operations in 2024 and inherited the contract; the awarded-operator display now folds to "Stagecoach". Same handling already applied to RATP Dev → First (Feb 2025). `OPERATOR_ACQUISITION_PAIRS` in `js/route-detail.js` lists the parent links; `data/operator-aliases.json` is the canonical record.

---

## v2.12 — Tender split into three sections & sharper map

_2026-06-02_

- **NEW** Tender block on the route card splits into three sections: **Current active contract** (the originating award — the one a route is actually running on today), **Next contract — awarded** (only when a re-tender has landed for a not-yet-started contract), and **Previous operator** (the last genuine change of hands). Rows in each section follow the same order — Operator, Tranche, Awarded on, Contract start, Length, Cost/mile, Contracted miles, Awarded vehicle, Joint bid, Bids received — so the three boxes read like-for-like. Resolves the long-standing case where a route in the transition window (e.g. 100) showed "Awarded Feb 2026" next to "Contract start Sep 2019".
- **NEW** Operator pill in every tender section, with an inline `change` flag when the next-contract awarded operator differs from the current incumbent. FirstGroup / RATP Dev (Feb 2025 acquisition) treated as the same operator on the flag, so ~10 affected routes don't show a false change. Curated lookup: `data/operator-aliases.json`.
- **NEW** Hover tooltips on every route-card label expose source + freshness in a consistent `Source: X. Freshness: Y.` format.
- **UX** Map tiles serve at 2× on hi-DPI displays via `detectRetina: true` — road names and labels stay crisp at larger window sizes.
- **FIX** Deck type corrected on **141 routes** mis-labelled DD. Cause: `deriveDeck()` regex read door-count markers (`2D` = dual door) as deck markers. Curated vehicle lookup now takes precedence over the regex, so Enviro200 / BYD D8UR / Streetlite always render SD.
- **FIX** Two regressions from a refactor mishap that broke the route-card panel — restored.

---

## v2.11 — Garage filter & filtered-route list

_2026-05-22_

- **NEW** Garage filter in the sidebar — a multi-select dropdown of garages grouped by operator. Pick one or more (even across operators) to narrow the network to their routes. It's a stackable filter like the others, so it combines with Operator, Route Type, Propulsion, etc. (and matches the garage drawer's "View all routes operated here").
- **NEW** The Routes panel now lists every route matching your active filters (bus stop, operator, type, propulsion, deck, frequency) — not just coloured lines on the map. Click any route to open its full card.
- **DATA** Contract lengths corrected across 400+ routes — now read directly from a public reference (with reduction/extension notes applied) and cross-checked against a second source, replacing the old estimate-from-award-gaps heuristic (e.g. an implausible 10-year term dropped to 5). Coverage 725/747.

---

## v2.10 — Tranche on the route card

_2026-05-11_

- **NEW** Tranche reference on every route card (Tender · Current contract). Shows the tendering-programme batch a route's upcoming tender sits in (e.g. `913`). Coverage 712/747 routes. Also added to the XLSX Routes sheet.

---

## v2.9 — Data accuracy corrections

_2026-05-11_

- **FIX** Average fleet age was being skewed by reserve vehicles of the wrong drivetrain briefly covering a route — a 14-year diesel on an electric route would add a year or two. Now only vehicles matching the route's dominant propulsion count. Route 339 went from 4.8 y to 2.9 y on this fix alone.
- **FIX** Garages were duplicated by code (BN/BT/UX) and the list included out-of-London placeholder depots with no network code and zero PVR. Deduped and filtered — a cleaner 81 garages.
- **FIX** Tender records occasionally carry the full annual bid in the cost-per-mile cell (route 290 2006, route 265 2022 etc.) producing £4M/mile headlines. Cost-per-mile is now clamped to a sane range.
- **FIX** School routes default to single-deck diesel when every upstream source returned null (London school services are uniformly single-deck diesel minibuses/coaches).

---

## v2.8 — MPS standards & contract start dates

_2026-05-01_

- **NEW** Contractual EWT / OTP / Mileage standards per route, from official per-route performance reports. A new "MPS" KPI tile sits next to the actual EWT / OTP so contract-vs-actual reads at a glance.
- **NEW** Contract start date on the route card (~700 / 747 routes covered).
- **NEW** Combined Tenders sheet in the XLSX export — historical awards (~2,500 since 2003) + upcoming programme entries in one stream. Rows filter to the search-pinned routes when set.
- **NEW** Search pills in the topbar now drive the export — typing `25, 30, 100` and pressing Export emits a workbook restricted to those routes (every sheet follows the same selection).
- **UX** Joint bid row now always shows Yes / No (was previously hidden when "No"). Tender section restructured into Current / Previous; tooltips rolled out across every route-card label.
- **FIX** Cost-per-mile reader was misreading European decimal commas (`6,25` was becoming `625`). 3 historical awards corrected.
- **FIX** A few operators rendered grey on the stats panels instead of their brand colour. Now consistent everywhere.
- **FIX** Stops toggle button no longer lingers after clearing the route search.

---

## v2.7 — Tender data on every route card

_2026-04-30_

- **NEW** Tender history surfaces on every route card: previous operator, awarded vehicle, cost per mile, contract length, total awards, bids received, joint bid flag.
- **NEW** Card restructured into Route / Fleet / Tender · Current / Tender · Previous sections.
- **DATA** ~2,500 historical tender awards (back to 2003) and 10 years of upcoming-tender programme data refreshed weekly.

---

## v2.6 — Frequency rules & propulsion fix

_2026-04-28_

- **NEW** Frequency band collapsed to binary: H = 5+ buses/hour, L = fewer.
- **FIX** 11 routes (D7, D8, 58, 187, 228, 251, 276, 314, 316, 384, 487) corrected from "diesel" to "electric".

---

## v2.5 — Network Overview & operator / garage drawers

_2026-04-24_

- **NEW** Network Overview panel — KPI tiles (Routes / Operators / Garages / PVR), clickable per-operator table, PVR-weighted Fleet Mix.
- **NEW** Operator drawer (Routes operated · Garages · PVR · % of network) and Garage drawer (Routes · PVR · % of network) with a "View all routes" CTA.
- **NEW** Global Clear-all button resets every filter, marker and search in one click.
- **NEW** XLSX export gains a Fleet Mix block in the Network overview sheet.
- **NEW** Direction toggle on single-route cards (outbound ⇄ inbound).

---

## v2.4 — Bus-stop filter

_2026-04-23_

- **NEW** Bus-stop filter — search any stop and filter the network to routes serving it.

---

## v2.3 — Night-route frequencies & garage electrification

_2026-04-21_

- **FIX** All 120 night routes now resolve a frequency band (after-midnight departures were previously mis-bucketed).
- **NEW** Garage popup gains an Electrification row (% of garage's PVR run by electric routes).

---

## v2.2 — API-first data pipeline

_2026-04-17_

- **DATA** An official transport API as the primary source for routes, destinations, timetables and stops. Fallbacks engage only when the API is sparse.
- **NEW** Per-route HTML grid fallback for frequency when the API is silent.
- **FIX** Multiple correctness improvements to operator and garage attribution.

---

## v2.0 — Operator garages, split filters, multi-sheet export

_2026-04-15_

- **NEW** Operator-coloured garage markers on the map.
- **NEW** Split filter design — Routes / Garages tabs in the sidebar.
- **NEW** XLSX export with three sheets (Routes / Garages / Network overview).

---

## v1 — Foundation

_2026-04-13 → 2026-04-14_

The initial v1.0 → v1.8 series established the core map, data pipeline and route detail experience.

- **NEW** Interactive map of every London bus route (~700) with route-type colouring.
- **NEW** Route search with autocomplete; click-map identify tool to find nearby routes.
- **NEW** Route detail panel — number, endpoints, stop count, direction toggle, operator, garage, vehicle type, deck, propulsion, frequency, length.
- **NEW** Filter system (route type, operator, deck, propulsion, frequency) with live filtering.
- **NEW** Multi-route selection via pill-based input; export filtered routes to CSV.
- **NEW** Per-operator statistics panel (Routes %, PVR %, EV %).
- **NEW** Manual override system (`data/route-overrides.json`) — any field can be hand-edited and wins over data.
- **DATA** Weekly automated build pipeline; auto-deploys to a static host.
- **DATA** API key moved to environment variables; modular module architecture.
