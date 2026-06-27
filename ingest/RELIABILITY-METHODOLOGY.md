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

## 7. Fix spec for `ingest/build-reliability.js` (prioritised)

1. **Sample far more frequently** (the biggest lever). For high-freq routes the headway-sampler
   must run every ~1–3 min in service hours, not ~30. Detect an actual **passing** as the moment a
   vehicle's `timeToStation` crosses ~0 (or its prediction disappears after counting down), giving
   a *measured-ish* passing time rather than a far-future prediction.
2. **Restrict to QSI points**: from `/Line/{id}/Route/Sequence` keep scheduled **timing points**,
   drop the terminus and any point within 1 km of it. Compute per point, per direction.
3. **Per-hour headway blocks** with `hSWT = Σ(SH²)/Σ(2·SH)`, `hAWT = Σ(OH²)/Σ(2·OH)`,
   `hEWT = hAWT − hSWT`; **first bus of each hour → headway 0**; restrict to 05:00–23:59.
4. **Aggregate** Step I (EB/OB) → II (passenger journeys; approximate with EB if unavailable) →
   III. Store `ewt_minutes` to 2 dp.
5. **Low-freq OTD**: per scheduled departure at the QSI point, band as 2.5-early/5-late etc.;
   `OT% = on-time / expected`. Needs per-trip scheduled times from the Timetable API.
6. **Sanity-gate**: drop/flag implausible outputs (e.g. EWT < 0 or > ~10 min, or below a minimum
   passings-per-hour density) rather than publishing them.
7. **History depth**: TfL aggregates over a quarter. For stable, QSI-comparable figures accrue
   **several weeks** of dense samples before treating a route's estimate as meaningful.

> Until items 1–3 land, the app surfaces this only as a clearly-labelled **experimental** estimate
> (cyan, `~`-prefixed, "not comparable to TfL's QSI"). The honest fix is denser sampling at QSI
> points with measured passings — then the same UI shows credible numbers.
