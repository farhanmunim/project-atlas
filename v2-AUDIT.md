# v2 (Route Lens) — Extensive Audit

Audit of `v2/index.html` — the floating-card "Route Lens" app served at `/v2`.
Method: full static code/data review + headless-browser runtime audit (behaviour,
interactions, data-correctness, responsiveness 320–1440px, accessibility, HTML
semantics, network origin). Date: 2026-06-22.

## Verdict

Behaviour and data are **solid**: every control works, rendered values match the
API (PVR 31 = API 31 spot-check), **all data flows through our `/api/v1`** (zero
direct TfL/external calls), **no console/page errors**, and **no horizontal overflow**
at any width 320–1440px. The real gaps are **output escaping (XSS)**, **keyboard
accessibility**, and **mobile** (the context rail is hidden on phones).

---

## HIGH

### H1 · Output escaping / XSS — `esc()` exists but is skipped on several sinks
`esc()` (v2:843) is applied correctly in the dossier and road-incident popups, but
omitted where dynamic strings are written to `innerHTML` / Leaflet `bindTooltip` /
`bindPopup`. Most dangerous are the **CSV-import** paths (fully user-supplied):

| Sink | Line | Untrusted source |
|---|---|---|
| `renderLensCard` bar label | ~1434 | CSV cell value (lens dimension) |
| `buildLegend` swatch label | ~1205 | CSV distinct value |
| `popupHTML` keys + values | ~1287–1291 | CSV headers + cells |
| `ingest` `<select>` option **text** | ~1018 | CSV header (value attr is quoted, text isn't) |
| `renderList` combobox | ~571 | route `name`/`od` from API |
| `drawBridges` tooltip | ~1112 | bridge `name`/`road` |
| live-bus tooltip | ~773 | `reg`/`publishedLine` |

Fix: wrap every interpolated dynamic string in `esc()` (and for the option text,
escape the text node, not just the `value`).

### H2 · Keyboard accessibility — custom controls are non-focusable `<div>`s
- 7 **card collapse headers** are `<div class="card-h">` with click handlers — no
  `role="button"`, `tabindex`, key handler, or `aria-expanded`.
- The **combobox options** (`.opt`) and the **filter/year chips** (`.ychip`) are
  clickable `<div>`s — not focusable, no `aria-pressed`, no key support.
- Result: collapse, route pick, filtering, and year toggles are **mouse-only**.
Fix: make them real `<button>`s (or add `role`/`tabindex=0`/Enter+Space handlers)
and reflect state with `aria-expanded` / `aria-pressed`; give the combobox
`role="combobox"`/`aria-expanded` and the list `role="listbox"`/`option`.

### H3 · No landmarks / skip link / reduced-motion
- **Landmarks = 0** — topbar/rails/map are all `<div>` (no `header`/`nav`/`main`/`aside`).
- **No skip link** to the map/content.
- **No `@media (prefers-reduced-motion)`** — chevron rotate, switch slides, heat
  animation run regardless of the user's OS setting.
(`h1`, `lang="en-GB"`, `<title>`, and input labels are all present and correct.)

---

## MEDIUM

### M1 · Mobile — the right rail is hidden, so there's no route info on phones
CSS `@media (max-width:720px){ #rightrail{display:none} }` removes the **dossier +
lens readout** entirely on phones. The route-info card (the thing we just polished)
doesn't exist on mobile. Fix: collapse it into a bottom sheet / move it under the
map on narrow screens rather than hiding it.

### M2 · Dead code that also contradicts the architecture
`api()`, `TFL`, and `APP_KEY` (v2:449–450, 518) and `coordsFromLineStrings`
(~911–923) are unused after the API rewiring. Worse, line 450 (`APP_KEY = ""; //
paste a TfL app_key here`) **invites putting a key in browser source** — against the
"never expose a key to the browser" rule. Remove all four.

### M3 · Stale-ingest race on rapid route/direction switch
The dossier guards against a late async resolve (`if(state.routeName!==name) return`),
but `loadAtlasAccidents()`/`drawBridges` (~826, 1083–1093) recompute the corridor and
`ingest()` with **no such guard** — a slow `/accidents` fetch resolving after the user
switched routes will plot the previous corridor's collisions. Add the same token check.

### M4 · Stale error copy references a non-existent Worker proxy
On `/accidents` / `/bridges` failure (~1099, 1125) the status says "likely CORS; point
the base URL at your Worker proxy." Atlas has **no Worker proxy** and the calls are
same-origin. Misleading; rewrite.

### M5 · Direction mapping is unverified
`fetchRoute` maps outbound→`dirs[0]`, inbound→`dirs[1]` over sorted `direction` values,
which are `"1"`/`"2"` in `routes-overview.geojson`. Whether `"1"` is genuinely *outbound*
is **not verified against the pipeline encoding** — the labels could be swapped. Confirm
against `pipeline/build/routes.js` / the TfL sequence direction, or label by an
explicit field.

### M6 · Contrast — `--faint` text below WCAG AA
`--faint` (#5C6772) on the dark panel ≈ **3.3:1**, under the 4.5:1 AA threshold for the
small section-annotation / meta / hint text. Darken the background usage or lighten
`--faint` for small text.

### M7 · Performance — full rebuilds on the hot paths
- `drawNetwork()` recreates ~1,300 polylines + per-feature event/tooltip bindings, and
  it's called **again on every filter-chip toggle** (`applyFiltersUI`). Consider
  restyle-in-place or cached geometry.
- Network live-buses redraws (clear + re-add) potentially thousands of canvas dots
  every 12 s; also add an `if(!tgBuses.checked) return` guard inside the `refreshBuses`
  `.then` so a toggle-off mid-flight doesn't re-add the layer.

---

## LOW

- `withinCorridor` is an O(points × ~600 sampled path pts) synchronous loop (bbox
  prefilter + early-exit mitigate it) — can briefly block on the full STATS19 set.
- `buildPoints` uses lenient `parseFloat` for CSV lat/lon (accepts `"51.5°"`); range
  checks mitigate.
- A lens `'(blank)'` bucket has no legend/colour entry (renders grey, no key row).
- `state.latCol = latC || headers[0]` silently maps the first two columns when
  detection fails — can yield a confusing "0 of N mapped" for arbitrary CSVs.
- Magic numbers (corridor 3000 m, bus poll 12 s, path-sample cap 600, jitter, etc.) —
  mostly commented; tokenise if it grows.

---

## What's already good (keep)

- Fully `/api/v1`-driven; no inline external fetches; graceful last-good on the live
  snapshot; consistent `getJSON`/`atlasBase` seam.
- No console errors; no overflow 320–1440; `h1`/`lang`/`title`/input-labels correct;
  `:focus` styles on inputs; data values reconcile with the API.

## Suggested fix order

1. **H1 escaping** (small, high-impact — especially the CSV paths).
2. **M2 dead code** (removes the key-in-browser invite) + **M4 stale copy**.
3. **H2/H3 a11y** (buttons + `aria-*` + skip link + reduced-motion).
4. **M1 mobile** context rail.
5. **M3 race guard**, **M5 direction check**, **M6 contrast**, **M7 perf**.
