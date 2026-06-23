-- ============================================================================
-- 0020_bus_crowding.sql
--
-- Bus crowding per route, from TfL's BUSTO open dataset
-- (crowding.data.tfl.gov.uk → "MAX DEMAND HOUR BY ROUTE BY TIMEBAND"). One row
-- per (route, year): the route's busiest point — peak V/C (= load ÷ capacity at
-- the max-demand hour), banded comfortable→crowded, plus the per-day-type peak.
-- Feeds Atlas's Crowding layer + the route dossier's Crowding readout.
--
-- BUSTO is published annually, so the (route_id, busto_year) key lets the table
-- accrue year-over-year (a multi-year crowding history) without overwriting past
-- years. A re-run of the same year upserts in place.
--
-- BUSTO is OPEN aggregate demand data (no personal content), so it carries an
-- anon SELECT grant like accidents/route_performance.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.bus_crowding (
  route_id        text        not null,             -- route name, e.g. "25", "N15", "SL9"
  busto_year      text        not null,             -- BUSTO year folder, e.g. "2025-2026"
  peak_vc         numeric,                           -- peak volume-to-capacity (load ÷ capacity)
  band            text,                              -- comfortable | moderate | busy | crowded
  load            numeric,                           -- passengers on board at the peak point
  capacity        numeric,                           -- vehicle capacity at the peak point
  seats           numeric,
  boardings       numeric,
  day_type        text,                              -- Weekday | Saturday | Sunday
  peak_time       text,                              -- quarter-hour of the peak, e.g. "15:45:00"
  timeband        smallint,
  direction       text,
  stopcode        text,
  stopname        text,
  stop_sequence   numeric,
  max_load        numeric,                           -- max load seen anywhere on the route
  max_capacity    numeric,
  weekday_vc      numeric,                           -- per-day-type peak V/C
  saturday_vc     numeric,
  sunday_vc       numeric,
  extracted_at    timestamptz not null default now(),
  primary key (route_id, busto_year)
);

-- Analytics access patterns: filter/aggregate by band and by year.
create index if not exists bus_crowding_band_idx on public.bus_crowding (band);
create index if not exists bus_crowding_year_idx on public.bus_crowding (busto_year);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.bus_crowding to anon;
grant select, insert, update, delete on public.bus_crowding to authenticated;
grant all on public.bus_crowding to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.bus_crowding enable row level security;

create policy "anon can read all rows"
  on public.bus_crowding
  for select
  to anon
  using (true);
