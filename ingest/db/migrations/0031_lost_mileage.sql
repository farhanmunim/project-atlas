-- ============================================================================
-- 0031_lost_mileage.sql
--
-- Daily GROSS lost-mileage estimate per route — Atlas's own, EXPERIMENTAL.
-- Built by scripts/build-lost-mileage.js from the continuous BODS vehicle
-- tracker's observed-trip log (scripts/track-vehicles.js), matched against the
-- scheduled departures in route_schedule. "Gross" because causes are invisible
-- externally: TfL's contractual figure nets out-of-control losses via operator
-- returns we cannot see. Feed honesty is structural: hours where an operator's
-- SIRI-VM feed cratered are counted as UNMEASURED, never as lost — so lost_km
-- can under-report during outages but should not over-report.
-- Calibration: aggregated over a quarter this should converge on TfL's
-- published scheduled-mileage-operated % (route_performance).
-- ============================================================================

create table if not exists public.route_lost_mileage_daily (
  route_id                  text        not null,   -- route NAME as published (warehouse convention)
  day                       date        not null,
  day_type                  text,                   -- weekday | saturday | sunday
  scheduled_trips           int,                    -- from route_schedule for this day type
  measured_scheduled_trips  int,                    -- scheduled trips in feed-healthy windows
  observed_trips            int,                    -- trips the tracker saw on this route
  matched_trips             int,                    -- observed trips matched to a scheduled departure
  lost_trips                int,                    -- measured scheduled trips with no match
  curtailed_trips           int,                    -- matched but ended short of the terminus
  scheduled_km              numeric,
  operated_km_est           numeric,
  lost_km_est               numeric,
  lost_pct                  numeric,                -- lost / measured scheduled km
  unmeasured_trips          int,
  unmeasured_km             numeric,
  feed_coverage_pct         numeric,                -- share of service hours with a healthy feed
  confidence                text,                   -- high | medium | low
  extracted_at              timestamptz not null default now(),
  primary key (route_id, day)
);

create index if not exists route_lost_mileage_daily_day_idx on public.route_lost_mileage_daily (day desc);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_lost_mileage_daily to anon;
grant select, insert, update, delete on public.route_lost_mileage_daily to authenticated;
grant all on public.route_lost_mileage_daily to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_lost_mileage_daily enable row level security;

drop policy if exists "anon can read all rows" on public.route_lost_mileage_daily;
create policy "anon can read all rows"
  on public.route_lost_mileage_daily
  for select
  to anon
  using (true);
