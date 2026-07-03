-- ============================================================================
-- 0026_crowding_profile.sql
--
-- Mirror the per-route crowding DETAIL into the warehouse (single source of
-- truth) — the same data the app reads from /api/v1/crowding-profile (TfL BUSTO,
-- static store). Complements bus_crowding (the per-route summary): this holds the
-- load-along-route profile (V/C by stop in sequence) and the time-of-day curve
-- (V/C per timeband, per day type). Kept as JSONB (nested arrays). Keyed
-- (route_id, busto_year) — snapshotted per BUSTO year like bus_crowding — so the
-- crowding profile accrues year-over-year for trend analysis. Refreshed by
-- mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.crowding_profile (
  route_id      text        not null,                -- route name, e.g. "25"
  busto_year    text        not null,                -- BUSTO year, e.g. "2025-2026"
  profile_dir   text,                                 -- busiest direction ("1"|"2")
  load_profile  jsonb,                                -- [{seq,name,vc}] V/C by stop in sequence
  time_of_day   jsonb,                                -- { Weekday:[{t,vc}], Saturday:[…], Sunday:[…] }
  fetched_at    timestamptz not null default now(),
  primary key (route_id, busto_year)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.crowding_profile to anon;
grant select, insert, update, delete on public.crowding_profile to authenticated;
grant all on public.crowding_profile to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.crowding_profile enable row level security;

drop policy if exists "anon can read all rows" on public.crowding_profile;
create policy "anon can read all rows"
  on public.crowding_profile
  for select
  to anon
  using (true);
