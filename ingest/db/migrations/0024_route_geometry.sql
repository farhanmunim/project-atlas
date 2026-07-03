-- ============================================================================
-- 0024_route_geometry.sql
--
-- Mirror the route line geometry into the warehouse (single source of truth) —
-- the same data the app reads from /api/v1/routes-overview (routes-overview.geojson,
-- static store). One row per (route_id, direction); the line coordinates are kept
-- as a JSONB array (GeoJSON [lng,lat] pairs) with the geometry type, so both
-- LineString and MultiLineString round-trip losslessly. Reference data, refreshed
-- by mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.route_geometry (
  route_id      text        not null,               -- route name, e.g. "25"
  direction     text        not null,               -- "1" outbound | "2" inbound (as in the geojson)
  geom_type     text,                                -- "LineString" | "MultiLineString"
  coordinates   jsonb       not null default '[]',   -- GeoJSON coordinates ([lng,lat] pairs)
  length_km     numeric,
  n_stops       integer,
  route_type    text,
  fetched_at    timestamptz not null default now(),
  primary key (route_id, direction)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_geometry to anon;
grant select, insert, update, delete on public.route_geometry to authenticated;
grant all on public.route_geometry to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_geometry enable row level security;

drop policy if exists "anon can read all rows" on public.route_geometry;
create policy "anon can read all rows"
  on public.route_geometry
  for select
  to anon
  using (true);
