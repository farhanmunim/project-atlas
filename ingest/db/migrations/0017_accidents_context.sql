-- ============================================================================
-- 0017_accidents_context.sql
--
-- Enrich public.accidents with decoded STATS19 collision-context attributes:
-- road type, speed limit, junction detail, light/weather/road-surface conditions.
-- These come straight from the DfT collision table (decoded to clean labels in
-- ingest/scripts/fetch-accidents.js) and power the app's "aggregate by" lens
-- dimensions + richer risk breakdowns. All nullable (STATS19 leaves some blank).
--
-- Additive only — existing rows keep their values; the next ingest backfills the
-- new columns on upsert (collision_id is the stable key). Run once in the
-- Supabase SQL Editor. Idempotent.
-- ============================================================================

alter table public.accidents add column if not exists road_type     text;  -- Single/Dual carriageway, Roundabout, One-way street, Slip road
alter table public.accidents add column if not exists speed_limit   text;  -- "20 mph" … "70 mph"
alter table public.accidents add column if not exists junction      text;  -- T/staggered, Crossroads, Roundabout, Not at junction …
alter table public.accidents add column if not exists light         text;  -- Daylight, Dark — lit/unlit/no lighting
alter table public.accidents add column if not exists weather       text;  -- Fine, Raining, Snowing, Fog/mist …
alter table public.accidents add column if not exists road_surface  text;  -- Dry, Wet/damp, Frost/ice, Snow, Flood …

-- Index the two most-used analytical filters (alongside the existing severity/date).
create index if not exists accidents_road_type_idx   on public.accidents (road_type);
create index if not exists accidents_speed_limit_idx on public.accidents (speed_limit);
