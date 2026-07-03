-- ============================================================================
-- 0025_bridges.sql
--
-- Mirror the low-bridge / height-restriction reference dataset into the warehouse
-- (single source of truth) — the same data the app reads from /api/v1/bridges
-- (London Datastore EPOWR, static store). Flat one-row-per-structure so it's
-- directly queryable (e.g. "bridges under 4.4 m in Newham"). Reference data,
-- refreshed by mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.bridges (
  bridge_id        text        primary key,          -- EPOWR structure id, e.g. "TQ4906283214"
  lat              numeric,
  lng              numeric,
  height_m         numeric,                           -- conservative clearance (lower band bound), metres
  height_imperial  text,                              -- e.g. "Between 15'0\" and 16'6\""
  name             text,
  road             text,
  structure_type   text,                              -- bridge | tunnel | barrier
  borough          text,
  fetched_at       timestamptz not null default now()
);

-- Analytics access patterns: clearance thresholds + by borough.
create index if not exists bridges_height_idx  on public.bridges (height_m);
create index if not exists bridges_borough_idx on public.bridges (borough);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.bridges to anon;
grant select, insert, update, delete on public.bridges to authenticated;
grant all on public.bridges to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.bridges enable row level security;

drop policy if exists "anon can read all rows" on public.bridges;
create policy "anon can read all rows"
  on public.bridges
  for select
  to anon
  using (true);
