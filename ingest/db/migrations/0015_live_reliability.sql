-- ============================================================================
-- 0015_live_reliability.sql
--
-- Atlas's OWN live-reliability estimates — a higher-frequency supplement to
-- TfL's quarterly published QSI figures (route_performance, populated from the
-- QSI PDF in 0003). TfL publishes EWT / OTP / mileage once per ~4-week period;
-- this pipeline reconstructs the SAME metrics continuously from the live TfL
-- prediction feed so Atlas can show a fresher (if necessarily less precise)
-- reliability signal between official releases.
--
-- Three tables, one per stage of the derivation:
--
--   route_schedule          — the SCHEDULED baseline per route (one row per
--                             route per snapshot_date). Carries the Scheduled
--                             Waiting Time (SWT), the categorical service class
--                             (high- vs low-frequency), scheduled trips/day and
--                             scheduled km. Refreshed weekly from the TfL
--                             Timetable + Route/Sequence endpoints by
--                             fetch-schedule.js. This is the denominator for
--                             EWT and for lost-mileage.
--
--   arrival_samples         — RAW observations appended frequently (~every
--                             30 min) by sample-headways.js: one row per
--                             (route, timing-point stop, vehicle) carrying the
--                             soonest predicted arrival. Accumulating these lets
--                             build-reliability.js reconstruct OBSERVED headways
--                             (sort a stop's distinct vehicle passings by time,
--                             diff consecutive). High-volume + append-only, so
--                             it is pruned to a rolling window by the sampler.
--
--   route_reliability_daily — the DERIVED daily rollup (one row per route per
--                             day) build-reliability.js writes: AWT, EWT (=AWT−
--                             SWT) for high-frequency routes, OTD% for low-
--                             frequency, plus operated/lost km. This is what
--                             Atlas reads alongside route_performance.
--
-- ── ACCURACY CAVEAT (read before trusting these numbers) ────────────────────
-- These are ESTIMATES, not TfL's measured figures. They differ because:
--   • We sample TfL's PREDICTED arrivals (expectedArrival), not the measured
--     actual departure at a calibrated timing point — predictions drift.
--   • Sampling is periodic (~30 min), so short headways between samples are
--     under-observed and gaps can be missed → AWT/EWT are approximate.
--   • Observed headways are reconstructed from distinct vehicle passings, which
--     can double-count or miss a vehicle whose id the feed dropped.
--   • Operated km is inferred from distinct observed vehicle-trips × route
--     length, a coarse proxy for TfL's odometer-based mileage.
-- Treat route_performance (the QSI PDF) as authoritative; treat this table as a
-- fresher directional supplement. Every consumer should surface it as such.
--
-- arrival_samples carries a vehicle_id (a UK reg plate, like the vehicles /
-- sightings tables) so — consistent with that precedent — it is service-role-
-- only (NO anon grant). route_schedule and route_reliability_daily are
-- non-sensitive aggregates, so they carry the usual anon SELECT grant for the
-- analytics page.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── route_schedule — scheduled baseline (SWT, class, scheduled km) ──────────
create table if not exists public.route_schedule (
  route_id        text    not null,
  snapshot_date   date    not null,
  service_class   text,                 -- 'high-frequency' | 'low-frequency'
  swt_minutes     numeric,              -- Scheduled Waiting Time at the timing point
  scheduled_trips integer,              -- scheduled departures/day at the timing point
  scheduled_km    numeric,              -- scheduled_trips × route length (km)
  headway_min     numeric,              -- representative scheduled headway (mins)
  source          text,                 -- e.g. 'tfl-timetable'
  primary key (route_id, snapshot_date)
);

create index if not exists route_schedule_route_idx on public.route_schedule (route_id);

-- ── arrival_samples — raw observed predictions (append-only, pruned) ────────
create table if not exists public.arrival_samples (
  id           bigserial   primary key,
  route_id     text        not null,
  stop_id      text,
  direction    text,
  vehicle_id   text,                                   -- reg plate (sensitive)
  expected_at  timestamptz,                            -- soonest predicted arrival
  recorded_at  timestamptz not null default now()      -- when we sampled it
);

create index if not exists arrival_samples_route_recorded_idx
  on public.arrival_samples (route_id, recorded_at);

-- ── route_reliability_daily — derived daily rollup ──────────────────────────
create table if not exists public.route_reliability_daily (
  route_id                  text    not null,
  day                       date    not null,
  service_class             text,                       -- determines which metric is meaningful
  awt_minutes               numeric,                    -- Actual Waiting Time  (high-freq)
  swt_minutes               numeric,                    -- Scheduled Waiting Time (copied from route_schedule)
  ewt_minutes               numeric,                    -- AWT − SWT            (high-freq)
  otd_percent               numeric,                    -- % on-time departures (low-freq)
  scheduled_km              numeric,
  operated_km               numeric,
  lost_km                   numeric,                    -- scheduled_km − operated_km
  mileage_operated_percent  numeric,                    -- operated/scheduled × 100
  sample_count              integer,                    -- raw arrival_samples behind this row
  primary key (route_id, day)
);

create index if not exists route_reliability_daily_day_idx on public.route_reliability_daily (day);

-- ── Data API grants ─────────────────────────────────────────────────────────
-- route_schedule + route_reliability_daily are non-sensitive aggregates → anon
-- may read (analytics page); pipeline writes via service_role.
grant select on public.route_schedule to anon;
grant select, insert, update, delete on public.route_schedule to authenticated;
grant all on public.route_schedule to service_role;

grant select on public.route_reliability_daily to anon;
grant select, insert, update, delete on public.route_reliability_daily to authenticated;
grant all on public.route_reliability_daily to service_role;

-- arrival_samples carries a registration plate → service-role-only (NO anon),
-- matching the vehicles / route_vehicle_sightings precedents.
grant all on public.arrival_samples to service_role;
-- bigserial → grant the sequence to service_role too (anon never inserts).
grant all on sequence public.arrival_samples_id_seq to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS on all three so grants don't over-expose; service_role bypasses
-- RLS, so the pipeline writes work regardless. anon-readable tables get an
-- explicit all-rows read policy; arrival_samples gets none (locked to service).
alter table public.route_schedule          enable row level security;
alter table public.route_reliability_daily enable row level security;
alter table public.arrival_samples         enable row level security;

create policy "anon can read all rows"
  on public.route_schedule
  for select
  to anon
  using (true);

create policy "anon can read all rows"
  on public.route_reliability_daily
  for select
  to anon
  using (true);
