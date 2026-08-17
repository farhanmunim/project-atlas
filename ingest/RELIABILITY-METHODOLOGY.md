# TfL bus reliability methodology (EWT · OTP/OTD) — replication reference

Authoritative reference for how TfL **officially** computes bus reliability, and the
concrete spec for replicating it in `ingest/build-reliability.js` from the TfL Unified
API. Every formula/threshold below is from a **primary TfL source** (FOI methodology
notes, the QSI quarter PDF, and the LBSL tendering doc), verified by independent
adversarial cross-check. Use this as the spec; do not reintroduce un-sourced heuristics.

## Primary sources

- **`iBus Data Aggregation for QSIs v2.2` (01.04.23)** — TfL's internal methodology, FOI-released.
  THE authoritative doc. https://foi.tfl.gov.uk/FOI-1189-2526/iBus%20Data%20Aggregation%20for%20QSIs%20v2.2%2001.04.23.pdf
- **`QSI Statistics Explained v2.0` (09.12.13)** — the exact hourly formulas + on-time bands.
  https://foi.tfl.gov.uk/FOI-1362-2021/QSI%20Statistics%20Explained%20v2.0%2009.12.13.pdf
- **QSI quarter report** (definitions + service-class split). https://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf · https://content.tfl.gov.uk/uploads/forms/current-quarter.pdf
- **LBSL Tendering & Contracting 2025** (MPS, on-time window, QIC payment mechanics). https://content.tfl.gov.uk/uploads/forms/lbsl-tendering-and-contracting-2025.pdf
- **Travel in London 2024** (service-class boundary restated; reported EWT magnitudes). https://content.tfl.gov.uk/travel-in-london-2024-trends-in-public-transport-demand-and-operational-performance-acc.pdf

## 1. High-frequency routes — Excess Wait Time (EWT)

Per-hour, per QSI-point, per direction, per route (the **minimum computation unit**):

```
hSWT = Σ(SHi²) / Σ(2·SHi)      over SCHEDULED headways SHi in the hour
hAWT = Σ(OHi²) / Σ(2·OHi)      over OBSERVED  headways OHi in the hour
hEWT = hAWT − hSWT
```

- **First bus of each hour is assigned headway = 0.** (Source: QSI Statistics Explained v2.0.)
- A "headway" is the gap (minutes) between **consecutive bus passings at a QSI point**, within
  the hour block. The Σ(h²)/(2·Σh) form is **passenger-weighted** wait: it deliberately
  inflates AWT when headways are irregular (bunching/gaps), which is the whole point of EWT.
  (A naïve ½·headway only equals this when headways are regular — arXiv 2303.17888.)
- **EWT = AWT − SWT** — the extra wait vs a perfectly-scheduled service. Worked example in the
  FOI doc: `EWT = 4.39 − 3.79 = 0.60 min`. Reported to **2 dp, in minutes**.
- **AWT:SWT ratio** — secondary indicator; 1.5 ⇒ passengers wait 50% longer than intended.
- Real-world magnitudes (sanity bounds): TfL network **excess** wait ≈ **1.2 min** (2023/24),
  actual wait ≈ 6.6 min. A per-route EWT above ~3–4 min is a genuinely poor route; **double-digit
  EWT is almost certainly a measurement artifact, not reality.**
- **Long gaps**: TfL separately monitors long gaps (bunching/cancellations); commonly
  P(wait > 2×SWT)-style. Not yet pinned to an exact public threshold here — flag if implementing.

## 2. Low-frequency routes — On-Time (OTP/OTD)

Measured against the **scheduled departure** at the QSI point. Authoritative bands
(QSI Statistics Explained v2.0 — the precise version; the public PDF rounds the early bound):

| Band | Definition (relative to schedule) |
|---|---|
| **On time** | **2.5 min early → 5 min late** (i.e. ≥ −2.5 and ≤ +5 min) |
| Early | 2.5 → 8 min early |
| Late | > 5 → 15 min late |
| **Non-arrival** | > 15 min late **OR** > 8 min early **OR** missing |

```
On-Time % = (buses counted on-time / Expected Buses) × 100
```

(The customer-facing PDF says "2 min early to 5 min late"; the technical FOI note specifies
**2.5 min early**. Use 2.5 for replication; note the discrepancy.)

## 3. Service-class boundary (which metric applies)

- **High-frequency** = **≥ 5 buses/hour** (≤ 12-min interval) general weekday daytime → measured by **EWT**.
- **Low-frequency** = **≤ 4 buses/hour** (≥ 15-min interval) → measured by **On-Time %**.
- **Night routes**: high-frequency threshold drops to **≥ 4 buses/hour** weekday.
- ~80%+ of scheduled mileage is high-frequency. Decision is per route (per direction/period in
  practice); derive it from the **scheduled** peak frequency, not observed.

## 4. Measurement methodology (the part we get wrong today)

- **Source data = iBus AVL passings** — *measured* vehicle positions (≈10 m / ≈10 s accuracy),
  **not predicted arrivals**.
- **Location = QSI Points only**, a **subset of scheduled Timing Points**, **excluding the
  terminus** and **the penultimate timing point if within 1 km of the terminus**. NOT every stop.
- **Window** = 05:00–23:59 daily (day services); night services 00:00–04:59 at selected points.
- **Scheduled headways** from the **registered timetable** (TfL Timetable API / TXC).
- **Aggregation** (3 fixed steps): **I** across QSI points (weight = Expected/Observed Buses) →
  **II** across hours (weight = **Passenger Journeys**) → **III** across routes (weight = EB/OB).

## 5. Contract / MPS framework (context, not needed to compute the raw metric)

- Each route has a contracted **MPS** (EWT for HF, On-Time % for LF).
- QIC payment: graduated — **every 0.010 min EWT** or **0.2 pp On-Time** is one step vs MPS;
  **bonus 0.15%/step** above, **deduction 0.1%/step** below, capped **+15% / −10%** of contract price.
- **Lost mileage**: deductible (in operator control) is unpaid + deducted; non-deductible isn't.

---

## 6. Why Atlas's current estimate is biased HIGH (root-cause map)

Observed in the warehouse (2026-06): high-freq EWT **median ≈ 16.8 min, max 41, some negative**;
route 1 = 27.5 min vs TfL's ~1–2. Causes, mapped to the methodology above:

1. **Predicted, not measured passings.** `sample-headways.js` records TfL `/Arrivals`
   *predictions*; a bus seen once then gone between samples fabricates a huge gap.
2. **~30-min sampling cadence.** Far too coarse for ≤12-min high-freq headways → real buses
   missed → observed headways (and Σ(h²)) massively inflated → AWT/EWT blow up.
3. **All stops, not QSI points.** We diff at every stop incl. termini, where layover gaps are
   huge and irregular — exactly the points TfL excludes.
4. **No per-hour blocks / first-bus-zero.** `build-reliability.js` diffs across the whole day's
   sparse samples and keeps any gap 0–120 min as a headway, so a 90-min sampling hole counts as a
   90-min headway. TfL computes per **hour** with the first bus of the hour at headway 0.
5. **Lost mileage is meaningless here** — `operated_km` ≈ sampled vehicle-trips only (~2–10% of
   scheduled), so `mileage_operated_percent` is sampling coverage, not lost mileage. (Already
   excluded from the app display.)

## 7. Fix spec for `ingest/build-reliability.js` (status)

1. **Sample far more frequently** (the biggest lever) — ✅ **done**: `sample-headways.js` now takes
   `SAMPLE_SWEEPS` (default 4) sweeps per run, ~`SAMPLE_SWEEP_INTERVAL_SEC` (180s) apart, so the
   */30 cron yields much denser coverage. **Passing detection** — ✅ **done**: `passingsByStop()`
   times each passing by the **most-converged** sighting (smallest `expected_at − recorded_at`),
   i.e. the prediction closest to the actual passing, not the earliest/furthest-out one.
2. **Restrict to QSI points** — ✅ **done** (migration `0021`): `fetch-schedule.js` derives a
   mid-route QSI-point set (`qsi_point_stop_ids`), excluding the terminus and any stop within 1 km
   of either end; `sample-headways.js` observes all of them so AWT spans the corridor. (NB this also
   fixed a latent bug — `push-to-supabase.js` never populated `timing_point_stop_id`, so the sampler
   had been recording *every* stop incl. termini.) Approximation: the Unified API doesn't flag true
   timing points, so we use evenly-spaced stops; SWT is read at the representative point (≈invariant
   across mid-route points, so EWT = AWT-across-points − SWT-at-point stays consistent).
3. **Per-hour headway blocks** — ✅ **done**: `awtHourly()` buckets passings by clock-hour, first
   bus of each hour carries no headway, headways diffed only within the hour, service hours only.
   Plus passing-event clustering so a vehicle's later trips count. (Self-test: `--selftest`.)
4. **Aggregate** weighted by observed buses (EB/OB; passenger-journey weights unavailable → OB) —
   ✅ **done**. `ewt_minutes` stored to 2 dp.
5. **Low-freq OTD** — ✅ **done** (migration `0021`): `fetch-schedule.js` stores per-trip
   `scheduled_departures` (minutes-after-midnight by day-type, already parsed from the Timetable);
   `build-reliability.js` scores each observed passing at the timing point against the nearest
   *scheduled* departure in TfL's 2.5-early..5-late window (`otdAgainstSchedule`), falling back to
   the synthetic grid only until the schedule is populated.
6. **Sanity-gate** — ✅ **done**: negative EWT ⇒ null; a minimum observed-bus count
   (`MIN_OBSERVED_BUSES`) is required before publishing; within-hour headways capped at 60 min.
7. **History depth** — ongoing: TfL aggregates over a quarter; accrue **several weeks** of the
   denser samples before treating a route's estimate as meaningful.

> The app surfaces this as a clearly-labelled **experimental** estimate (cyan, `~`-prefixed, "not
> comparable to TfL's QSI"). With items 1, 3, 4, 6 landed the per-route EWT is no longer inflated by
> cross-hour sampling holes; coverage tightens (thin-sample routes now read null rather than a wrong
> number) and improves as denser history accrues. Items 1 (true passing detection), 2 (full QSI
> points) and 5 (per-trip OTD) remain to reach QSI-comparable accuracy.

## 8. Tracked v2 — build-reliability-tracked.js (continuous BODS observation)

The sampled estimator above is bounded by its observation method (~30-min Arrivals
sweeps under-observe short headways → EWT biased high; audited Aug 2026: mean ~2.6 min
vs TfL ~1.1). **v2** replaces the observed side entirely: the continuous SIRI-VM
collector (`track-vehicles.js`, 25 s sweeps) logs every completed trip with a waypoint
trail; `build-reliability-tracked.js` interpolates each outbound trip's **passing time
at the route's timing point** and feeds complete passing sequences through the pure QSI
core (`_lib/reliability-tracked.js`) → `route_reliability_tracked_daily` (migration
0032). Served at `/api/v1/history/reliability-tracked`; coexists with v1 for
calibration.

Mapping to the TfL spec — deliberate simplifications, to close during calibration:

| TfL spec | v2 today |
|---|---|
| Per-hour, per QSI point (≈5), per direction | Whole-day, ONE timing point, outbound only |
| First bus of each hour = headway 0 | No hourly reset — day-level headway chain |
| In-control filtering via operator returns | None (gross); operator feed OUTAGES excluded as unmeasured (hour vs 14-day median) |
| iBus AVL (complete by construction) | BODS SIRI-VM (coverage varies by operator — the burn-in artifact source) |

Observed failure modes (first live days, Aug 2026): **under-observation** (missing
trips → false gaps → EWT reads 10–20+ min — exactly the "double-digit EWT is a
measurement artifact" case above) and **duplicate/split observations** (one physical
trip logged twice → compressed headways → strongly negative EWT). Both sit outside a
plausibility band; the day-2 plausible band (confidence=high, EWT −1…8 min) already
read mean 2.79 / median 1.86 min. **The apps display only that band; the API serves
every raw row as calibration material.** Promotion to headline estimate requires the
band to converge on TfL's QSI per route as feed-health medians mature (~14 days) and a
per-operator observation-rate correction lands.

### Two systematic faults found in external audit (fixed 2026-08-17)

Route 25 weekday read SWT 24.6 / AWT 40.9 / OTD 5.9% with 143 of 306 departures
non-arrival — implausible on its face. Root causes, both reproduced exactly:

1. **Doubled scheduled departures.** TfL publishes "Monday to Thursday" AND
   "Friday" as separate timetable schedules; both classify as `weekday`, and
   `fetch-schedule.js` concatenated them — every departure twice (306 = 2×153).
   Zero-gaps are skipped by the headway core so EWT survived, but OTD matched each
   real passing to one twin and counted the other as a **non-arrival**, and
   `scheduled_trips` doubled — inflating lost-mileage too. Fix: departures for a
   day-type come from the **single most representative schedule** (widest day
   coverage, then most journeys — `_lib/schedule-pick.js`, unit-tested). Corrects
   route_schedule rows as they refresh (weekly TTL).
2. **The overnight service break counted as a headway.** Route 25's 00:38→04:45
   scheduled gap (247 min) entered Σh²/2Σh and alone pushed SWT from ~4.7 to 24.6.
   Fix: a scheduled gap ≥ `SERVICE_BREAK_MIN` (90 min) now splits the day into
   service segments for BOTH the scheduled and observed series — neither a
   scheduled break nor an observed gap spanning it is a waiting headway (the
   schedule defines the operating periods). Hourly low-frequency services (60-min
   headways) are unaffected.

Historical `route_reliability_tracked_daily` rows written before the fix can be
recomputed with `node scripts/build-reliability-tracked.js --day=YYYY-MM-DD` once
the schedule rows have refreshed.
