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

> **Modular by construction.** Even though it's one tool, keep processes/functions
> modular (per-concern render helpers, the `dataSource` seam, pipeline `build/<name>.js`
> per dataset) so any layer/analysis can be lifted into a standalone tool later.

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
  warehouse output) ship as static assets. The store reader tries `/api/*` first,
  404s in prod, and falls back to `./data/*.json`. The `data/*.db` warehouse is
  gitignored and **not** deployed (JSON is the prod read layer).
- **Data refresh = the GitHub Action** [`.github/workflows/refresh-data.yml`].
  It runs the pipeline on a schedule, commits refreshed `data/*.json`, and the
  push auto-triggers a Cloudflare Pages rebuild. That commit is the bot's
  (`transit-instruments-bot`) — the "commit as Farhan" rule above is for *our*
  manual commits, not this automated data commit.
- **Live data** — volatile feeds go **browser → TfL directly** via the `tfl`
  seam (CORS-open): line status, arrivals/vehicles, disruptions. No server needed.
- **Live bus GPS (BODS SIRI-VM)** — needs a server-side key, so it's a
  **Cloudflare Pages Function** at [`functions/api/live/vehicles.js`], reproducing
  serve.js's `/api/live/vehicles` on the same URL (10s edge-cached). `BODS_API_KEY`
  is a Cloudflare project **secret**, never shipped to the browser. If the parse
  logic in `pipeline/sources/bods.js` changes, change the Function too.
- Pages build config: **no build command**, output directory **repo root** (`/`);
  the `functions/` dir at root is auto-detected.

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
/* surfaces */     --ink:#0a0e16; --ink-2:#0c111b;
                   --panel:#111725; --panel-2:#151c2c; --panel-3:#1a2233;
                   --line:#1f2a3d; --line-2:#2a384f; --line-3:#3a4a66;
/* ink on dark */  --paper:#e7edf6; --paper-2:#9fb0c8; --paper-3:#647691; --paper-4:#3f4d63;
/* data accents */ --amber:#f5a524; --cyan:#37c5c5; --violet:#8b7bf0; --green:#3fb87a; --alert:#ff5470;
/* motion */       --ease:cubic-bezier(.4,0,.2,1);
/* type */         --mono:"SF Mono",…,monospace;  --sans:"Inter",system-ui,…,sans-serif;
```

**Colour meaning (keep it consistent):**
- **Amber** = primary data / the selected thing. **Cyan** = secondary data.
- **Violet / green** = additional categorical accents.
- **Red (`--alert`) is reserved for genuine alerts** — breaches, disruptions,
  danger. Never use it as decoration. (Exception: a tool whose *subject* is the
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
their *meaning* never changes. See *Theming, settings & preferences*.

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
  - **Preferred operator** — the "you" highlighted across tools (Mandate's held
    routes, Cohort's "your fleet"). One place to set it; every tool reads it.
  - **Units & formats** — distance (km/mi), time (24h/12h, minutes vs `mm:ss`),
    currency display, date format (default en-GB). Tools format via these, never
    hardcode a unit.
  - **Default view / home tool**, density (comfortable/compact) if useful, and
    the theme.
- **Persistence.** Preferences persist across sessions and are **shared across
  all tools** (one settings object, one storage key) so the suite feels unified —
  set your operator once, every instrument respects it. Read settings at startup
  before first render; re-render on change.
- **Apply, don't decorate.** A preference must actually change behaviour: units
  reformat every value, preferred-operator re-highlights, theme restyles via
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
  refresh button and last-refreshed badge are standard too — see *Topbar layout*.
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
  which endpoint(s) feed it and at what cadence (see the *Output* column in
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

> Net: components depend on *our* data shape via the seam, never on TfL's wire
> format or on where the bytes come from. API-direct now, DB-backed later, with
> the tools unchanged.

### Pipelines, ingestion & automation

When we gather data — API pulls, file downloads, or **scraping** the JS-rendered /
PDF / gated sources flagged in `data_sources.xlsx` — the pipeline must be
**robust, optimized, and gracefully degrading**. These run unattended in future
(GitHub Actions, cron, or a scheduled job), so they fail safely on their own.

- **Prefer the cleanest source.** Official API → bulk open dataset / CKAN → file
  download → scrape. Scraping is the **last resort**, only for sources with no
  machine-readable feed; check terms/robots and keep within them.
- **Robust by default:** timeouts on every request; retries with exponential
  backoff + jitter; treat any single source as fallible. One source failing must
  not abort the whole run or corrupt the store.
- **Graceful fallback / degrade:** on fetch failure keep the **last good data**
  (don't overwrite a good record with an error or empty); mark records with
  `fetched_at` + status so staleness is visible downstream (feeds the tools'
  "stale/cached" badge). Partial success is success — persist what you got.
- **Optimized & polite:** match poll cadence to the source's real refresh (the
  *Output* column — don't re-pull a quarterly PDF hourly); use conditional
  requests (ETag / If-Modified-Since) and incremental/delta fetches; cache;
  dedupe; respect rate limits and back off on 429/5xx.
- **Validate before it lands** (ties to *Validation*): schema/row-count/sanity
  checks on ingested data; quarantine or reject bad batches rather than poisoning
  the store; alert on anomalies (row count cratered, all-nulls, totals don't
  reconcile).
- **Idempotent & re-runnable:** a re-run produces the same end state (upsert on a
  stable key, no dupes); safe to retry after a crash. Checkpoint long runs so a
  failure resumes rather than restarts.
- **Automation-ready & observable:** parameterised (no hardcoded secrets — keys
  via env/secrets), structured logging, a clear exit code and run summary
  (fetched / updated / skipped / failed) so a scheduled job surfaces health.
  Scrapers that drive a headless browser are heavier — schedule accordingly and
  keep them isolated from the light API pulls.
- **Decoupled from the app.** Pipelines write to the store; tools read via the
  seam. The two never share a code path — a slow/failed scrape never blocks a
  tool render (the tool just shows its last-good/cached state).

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
  *current* state (selected entity, active filters, mode) — what the user sees is
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

## Checklist (each change/phase)

- [ ] Three-pane shell, 52px topbar, matches the existing app
- [ ] Topbar right: last-refreshed badge + manual refresh `⟳` + clock; refresh repaints panes & resets the badge
- [ ] Dark/light theme toggle via `data-theme`; defaults to OS pref, choice persists; both themes meet contrast
- [ ] Reads shared user settings (preferred operator, units/formats) at startup; preferences actually change behaviour & persist across tools
- [ ] `:root` tokens copied; no hardcoded colours; quantitative values in mono
- [ ] Red only for alerts
- [ ] Left rail drives canvas + right rail; mode toggle switches canvas views
- [ ] Semantic landmarks, single h1, tablist for modes, lists as `<ul>`
- [ ] Skip link, focus-visible, reduced-motion, aria-hidden on decorative SVG
- [ ] No horizontal overflow 320–1440px; panes collapse sensibly
- [ ] Large data SVGs have width override
- [ ] Official TfL API used as primary source where available; source + cadence documented
- [ ] Data access behind a swappable seam (normalised shapes, async); no inline `fetch` in components; backend selectable by config (tfl → db later)
- [ ] Fallbacks degrade gracefully (live → cached → labelled sample); badge shows the state
- [ ] Validated: rendered values cross-checked against the source via headless browser + Node/Python; reproducible script
- [ ] CSV export of the current view (respects selection/filters/mode)
- [ ] Import &/or inline editing wired where it makes sense (imported/edited data is first-class; bad input reported)
- [ ] New layer/section wired into Atlas's display toggles + context groups (modular helpers)
