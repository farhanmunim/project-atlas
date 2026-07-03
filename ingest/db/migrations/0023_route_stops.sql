-- ============================================================================
-- 0023_route_stops.sql
--
-- Mirror the route-stops reference dataset into the warehouse so the DB is a
-- single source of truth. Ordered stop sequences per route and direction —
-- the same data the app reads from /api/v1/route-stops (static store). Reference
-- data (changes only on network revisions), refreshed by mirror-reference-data.js
-- on the weekly ingest. One row per (route_id, direction); the stop sequence is
-- kept as a JSONB array (id, name, lat, lng, lines) — lossless vs the API shape.
-- ============================================================================

create table if not exists public.route_stops (
  route_id      text        not null,               -- route name, e.g. "25", "N15", "SL9"
  direction     text        not null,               -- "outbound" | "inbound"
  stops         jsonb       not null default '[]',   -- ordered [{id,name,lat,lng,lines}]
  n_stops       integer,
  fetched_at    timestamptz not null default now(),
  primary key (route_id, direction)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_stops to anon;
grant select, insert, update, delete on public.route_stops to authenticated;
grant all on public.route_stops to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_stops enable row level security;

drop policy if exists "anon can read all rows" on public.route_stops;
create policy "anon can read all rows"
  on public.route_stops
  for select
  to anon
  using (true);
