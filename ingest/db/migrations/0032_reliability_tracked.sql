-- ============================================================================
-- 0032_reliability_tracked.sql
--
-- Daily TRACKED reliability estimate per route — Atlas's own EWT/OTD v2,
-- EXPERIMENTAL. Built by scripts/build-reliability-tracked.js from the
-- continuous BODS vehicle tracker's trip log (scripts/track-vehicles.js):
-- every trip's passing time at the route's timing point is interpolated from
-- its waypoint trail, giving COMPLETE observed headways within feed-healthy
-- windows — unlike the ~30-min Arrivals sampler behind route_reliability_daily,
-- which under-observes short headways and reads EWT biased high.
--
-- Formulas (TfL QSI): SWT = Σh²/2Σh over scheduled headways; AWT likewise
-- over observed; EWT = AWT − SWT (high-frequency). OTD = % departures −2…+5
-- min of schedule, unmatched departures counted as non-arrivals (low-freq).
-- Feed honesty is structural: headways are never computed across an
-- operator-outage window, and departures inside one are unmeasured — never
-- late, never non-arrivals.
--
-- Coexists with route_reliability_daily (the sampled v1) so the two can be
-- calibrated against each other and against TfL's quarterly QSI
-- (route_performance) before either is promoted as the headline figure.
-- ============================================================================

create table if not exists public.route_reliability_tracked_daily (
  route_id             text        not null,   -- route NAME as published (warehouse convention)
  day                  date        not null,
  day_type             text,                   -- weekday | saturday | sunday
  service_class        text,                   -- high-frequency | low-frequency (from route_schedule)
  swt_minutes          numeric,                -- scheduled wait (Σh²/2Σh)
  awt_minutes          numeric,                -- actual wait from observed passings
  ewt_minutes          numeric,                -- AWT − SWT (may be slightly negative = over-provision)
  scheduled_headways   int,                    -- headway count behind SWT
  observed_headways    int,                    -- headway count behind AWT
  otd_percent          numeric,                -- % measured departures on time (−2…+5 min)
  deps_measured        int,                    -- scheduled departures in feed-healthy windows
  on_time              int,
  early                int,
  late                 int,
  non_arrival          int,                    -- measured departures with no observed passing
  passings_observed    int,                    -- tracked trips contributing passings
  feed_coverage_pct    numeric,                -- share of scheduled departures measurable
  confidence           text,                   -- high | medium | low
  extracted_at         timestamptz not null default now(),
  primary key (route_id, day)
);

create index if not exists route_reliability_tracked_daily_day_idx on public.route_reliability_tracked_daily (day desc);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_reliability_tracked_daily to anon;
grant select, insert, update, delete on public.route_reliability_tracked_daily to authenticated;
grant all on public.route_reliability_tracked_daily to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_reliability_tracked_daily enable row level security;

drop policy if exists "anon can read all rows" on public.route_reliability_tracked_daily;
create policy "anon can read all rows"
  on public.route_reliability_tracked_daily
  for select
  to anon
  using (true);
