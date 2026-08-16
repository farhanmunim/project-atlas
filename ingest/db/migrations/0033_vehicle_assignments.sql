-- ============================================================================
-- 0033_vehicle_assignments.sql
--
-- Per-vehicle DAILY route assignments from the continuous BODS tracker —
-- one row per (registration, route, day), so a bus that works route A in
-- the morning and route B at night gets TWO rows for that day, each with
-- its first/last-seen window and trip count. This is what the once-daily
-- 08:37 fleet sample structurally cannot see (it catches each bus once).
--
-- Built by scripts/build-vehicle-assignments.js from the tracker's trip log
-- (data/tracking/trips-<day>.jsonl) on the 00:37 chain — persisting the
-- intra-day allocation story before the 16-day log rotation discards it.
-- Complements route_vehicle_observations (the long-running daily sightings);
-- deliberately a separate table so recurrence analyses over the sampled
-- history stay unbiased.
-- ============================================================================

create table if not exists public.vehicle_route_assignments_daily (
  registration  text        not null,   -- vehicle reg (joins vehicles / fleet / live GPS)
  route_id      text        not null,   -- route NAME as published (warehouse convention)
  day           date        not null,
  trips         int,                    -- completed tracked trips on this route this day
  first_seen    timestamptz,            -- first trip start on this route this day
  last_seen     timestamptz,            -- last trip end on this route this day
  km_observed   numeric,                -- total observed km across those trips
  extracted_at  timestamptz not null default now(),
  primary key (registration, route_id, day)
);

create index if not exists vehicle_route_assignments_daily_day_idx   on public.vehicle_route_assignments_daily (day desc);
create index if not exists vehicle_route_assignments_daily_route_idx on public.vehicle_route_assignments_daily (route_id, day desc);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.vehicle_route_assignments_daily to anon;
grant select, insert, update, delete on public.vehicle_route_assignments_daily to authenticated;
grant all on public.vehicle_route_assignments_daily to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.vehicle_route_assignments_daily enable row level security;

drop policy if exists "anon can read all rows" on public.vehicle_route_assignments_daily;
create policy "anon can read all rows"
  on public.vehicle_route_assignments_daily
  for select
  to anon
  using (true);
