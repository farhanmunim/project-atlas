-- ============================================================================
-- 0013_route_vehicle_sightings.sql
--
-- Adds a high-frequency, ROLLING store of route → registration observations,
-- plus an aggregation RPC the weekly build uses to recover each route's core
-- fleet.
--
-- Why a second table instead of reusing route_vehicle_observations?
--   • route_vehicle_observations is the PERMANENT analytics log — one weekly
--     snapshot per (route, reg, week), kept forever so we can answer "which
--     buses ran the 25 in March 2026?".
--   • route_vehicle_sightings is written DAILY by sample-vehicles.js. Daily
--     granularity is only needed to tell a route's recurring fleet from one-off
--     cover buses (build-classifications.js core-fleet filter), and only over a
--     trailing window. Keeping daily rows forever would blow the free tier
--     (~10k rows/day), so this table is pruned to a rolling RETENTION window by
--     the sampler. Separating the two keeps the analytics log clean + small and
--     the recurrence signal bounded.
--
-- Both tables carry registration plates, so — like route_vehicle_observations
-- and vehicles — this table is service-role-only (NO anon grant).
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.route_vehicle_sightings (
  route_id      text        not null,
  registration  text        not null,
  observed_at   timestamptz not null,
  primary key (route_id, registration, observed_at)
);

create index if not exists idx_rvs_observed_at on public.route_vehicle_sightings (observed_at);
create index if not exists idx_rvs_route       on public.route_vehicle_sightings (route_id);

-- ── Grants — service-role-only (carries registration plates) ────────────────
-- Created before the 30 Oct 2026 auto-grant change so anon/authenticated would
-- inherit nothing by default anyway; we make the lock-down explicit and grant
-- only the service role the pipeline writes with.
grant all on public.route_vehicle_sightings to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- service_role bypasses RLS; enabling it with no anon policy means the public
-- anon role can never read a registration plate from this table.
alter table public.route_vehicle_sightings enable row level security;

-- ── route_vehicle_recurrence(p_since) ───────────────────────────────────────
-- Returns, per (route, reg) observed since p_since, how many distinct runs and
-- distinct calendar days the reg ran the route, plus first/last seen. Unions
-- the rolling daily sightings with the permanent weekly observations so the
-- backfill benefits from BOTH the dense recent daily samples AND the months of
-- weekly history already in route_vehicle_observations (so the fix lands on the
-- next build, not only after daily data accrues).
--
-- Aggregating server-side keeps the payload to ~one row per (route, reg)
-- (~13k rows) instead of streaming back hundreds of thousands of raw rows.
create or replace function public.route_vehicle_recurrence(p_since timestamptz)
returns table (
  route_id      text,
  registration  text,
  sightings     bigint,
  days          bigint,
  first_seen    timestamptz,
  last_seen     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with obs as (
    select route_id, registration, observed_at
      from public.route_vehicle_observations
     where observed_at >= p_since
    union
    select route_id, registration, observed_at
      from public.route_vehicle_sightings
     where observed_at >= p_since
  )
  select
    route_id,
    registration,
    count(distinct observed_at)                                  as sightings,
    count(distinct ((observed_at at time zone 'UTC')::date))     as days,
    min(observed_at)                                             as first_seen,
    max(observed_at)                                             as last_seen
  from obs
  group by route_id, registration;
$$;

-- Only the pipeline's service role may run it (the function reads plate-bearing
-- tables; SECURITY DEFINER means it would otherwise run with the owner's rights
-- regardless, so we also restrict who can call it).
revoke all on function public.route_vehicle_recurrence(timestamptz) from public;
grant execute on function public.route_vehicle_recurrence(timestamptz) to service_role;
