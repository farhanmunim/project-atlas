# Atlas — Audit Findings & Remediation Log

Multi-agent due-diligence audit (68 agents, adversarial cross-verification, london-buses
comparison) run 2026-06-18. 47 findings confirmed, 5 refuted. This log tracks each
finding and its remediation status. Supersedes the prior single-pass audit.

## Scores at audit time

| Dimension | Score | Rationale |
|---|---:|---|
| Product Health | 58/100 | Core shell + live map work; flagship reliability metric was missing; some settings decorative. |
| Launch Readiness | 47/100 | Data-integrity/trust regressions (badge lied "fresh", dates transposed, sample mislabelled). |
| Technical Quality | 55/100 | Clean modular intent; CDC warehouse ephemeral in CI; five builders ungated. |
| UX | 62/100 | Coherent shell + rich analysis; stale live markers leaked into Magnify; no Enter/comma search. |
| Security | 82/100 | CSV injection neutralised, BODS key server-side, API prose escaped; one low XSS, light-theme contrast. |

## Remediation status

### ✅ Fixed (committed)

**Live tracking / mode state (HIGH)**
- `setMode()` now calls `applyDataMode()` — stale live markers + frozen countdown ring no longer leak into Magnify mode. *(root cause of the reported marker bugs)*
- `viewAllRoutes()` calls `applyDataMode()` + recomputes proximity once geometry loads.
- Live freshness badge no longer fakes "just now" on a failed pull — `liveStatusAt` stamped only on success; `liveFailed` → badge shows "Live feed unreachable".

**Data correctness / trust (HIGH)**
- `fmtDate` parses en-GB `DD/MM/YY(YY)` explicitly (Date.parse misread it as US MM/DD → contract dates transposed for ~214 routes). All dates render DD/MM/YYYY.
- "Data refresh: Cached/Live" setting now actually gates auto-polling (`autoPolling()`); was decorative.
- Sample data no longer mislabelled "cached" (`routesState!=="offline"` guard).
- Network operator ZEV now PVR-weighted everywhere (list + drill-down agree).

**Security / a11y**
- Operator name escaped in filter-chip `data-v` attribute (only raw-string XSS sink).
- Light-theme accent hues re-tuned to clear WCAG AA (~4.5:1) as text on white.
- Map `role="application"` → `role="region"`; topbar icon SVGs `aria-hidden`.

**UX**
- Search: Enter-to-select + comma multi-select; selected routes shown as removable chips on the left rail.
- Table Length column re-renders on unit change; routes-layer toggle persists.
- `routesNear()` probes the whole filtered network — click-to-identify works with a route selected.
- `refreshAll` clears fleet + disruption caches too; Clear-pin resets the canvas subheader; Clear-all resets the map view.
- Live-bus markers pop on both basemaps (contrasting halo); richer vehicle popup + live-fleet propulsion.

**Product — #1 gap closed**
- **Route reliability** (EWT/OTP vs MPS + % mileage operated) now renders per route — was advertised in the empty-state but absent. 749 routes, Q4 25/26. Pipeline builder ported in parallel so it refreshes through the warehouse.

### 🔧 In progress / queued

| Area | Finding | Severity | Status |
|---|---|---|---|
| Pipeline | `routes-overview.geojson` + 5 builders have no min-row validation gate → a partial outage overwrites last-good with a hollow file | HIGH | queued (validation gates) |
| Ingest | Last-known-good fallback inert in CI (`route_classifications.json` neither committed nor cached) | HIGH | queued (widen actions/cache) |
| Ingest | A soft-failed route-destinations fetch hard-aborts the whole weekly run (incl. Supabase push) | HIGH | queued |
| Warehouse | SQLite CDC DB ephemeral in CI — timeline never persists | MEDIUM | queued |
| Feature | "Accidents/Sentinel" layer advertised in copy but absent | MEDIUM | queued (build layer or trim copy) |
| vs LB | Deck / frequency-band / prefix route classification + filters | HIGH | queued |
| vs LB | Structured tender comparison (previous operator, contract term, awarded spec, current/next split) | HIGH | queued |
| vs LB | Contract-expiry network-wide (only 8 hardcoded routes today) | HIGH | queued |
| vs LB | Core-fleet filtering + confidence labelling; structured make/model | MEDIUM | queued |
| Pipeline | £/mile clamp (0–200) + decimal-comma handling to stop absurd outliers | MEDIUM | queued |

### Refuted on cross-check (not issues)
CSV formula-injection guard is correct; free-form TfL disruption prose is escaped at every sink;
onConflict keys / idempotency / BUS_API_KEY bridge / heartbeat anti-pause / hard-fail audit gate all correct.

### Where Atlas already leads london-buses (keep)
Derived network analysis (route role, sinuosity, interchange intensity, corridor overlap),
live operations + diversion panel, and garage utilisation — all richer than the predecessor.
