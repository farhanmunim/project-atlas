-- ============================================================================
-- _template.sql — copy this when adding a new migration.
--
-- IMPORTANT: From 30 October 2026 Supabase no longer auto-grants Data API
-- access to new `public`-schema tables. Existing tables (everything in this
-- repo through 0010) keep their grants forever. But every NEW table or view
-- you add after that date MUST include explicit GRANT statements below or
-- supabase-js / PostgREST / GraphQL will return 42501 against it.
--
-- Procedure for a new migration:
--   1. cp _template.sql 00NN_short_name.sql
--   2. Replace `your_table` everywhere.
--   3. Edit columns + indexes for the actual table.
--   4. Decide which roles need which verbs. Default below is conservative:
--        anon          → SELECT  (the analytics page needs this when it ships)
--        authenticated → SELECT (no auth flow today, future-proof only)
--        service_role  → ALL    (the pipeline writes via this role)
--      If the table holds sensitive data (e.g. registration plates), drop
--      the anon grant — `vehicles` and `route_vehicle_observations` are the
--      precedents in this repo.
--   5. Edit / remove the example RLS policy at the bottom.
--   6. Paste into the Supabase SQL Editor, then commit the file.
-- ============================================================================

create table if not exists public.your_table (
  id            bigserial primary key,
  -- TODO: real columns
  created_at    timestamptz not null default now(),
  -- Dual-timestamp convention used across this schema (see data.md §
  -- "Historical store"): `extracted_at` = when the pipeline collected the
  -- row; `data_as_of` = the period the data describes.
  extracted_at  timestamptz not null default now(),
  data_as_of    date
);

-- Indexes for the access patterns the analytics page will need.
-- TODO: tighten to match the real query shapes.
create index if not exists your_table_data_as_of_idx
  on public.your_table (data_as_of);

-- ── Data API grants (REQUIRED for tables created after 30 Oct 2026) ────────
-- Without these, supabase-js requests against this table return HTTP 401 /
-- PostgREST error code 42501. The exact GRANT to fix it is in the error
-- body, but it's cheaper to get it right at creation time.
grant select on public.your_table to anon;
grant select, insert, update, delete on public.your_table to authenticated;
grant all on public.your_table to service_role;

-- Sequence access — required separately when columns use `bigserial` /
-- `serial` (the sequence is its own object). Drop these two lines if the
-- table has no auto-increment columns.
grant usage, select on sequence public.your_table_id_seq to anon;
grant usage, select on sequence public.your_table_id_seq to authenticated;
grant all on sequence public.your_table_id_seq to service_role;

-- ── Row Level Security ────────────────────────────────────────────────────
-- Enable RLS so the GRANT above doesn't accidentally expose every row to
-- anon. The pipeline writes via service_role which bypasses RLS, so write
-- policies are usually unnecessary.
alter table public.your_table enable row level security;

-- Read policy — adjust the USING clause to whatever filter the analytics
-- page should see. The example below is the simplest possible: all rows
-- visible to the anon role. Drop the policy entirely if the table is
-- service-role-only (e.g. anything carrying a registration plate).
create policy "anon can read all rows"
  on public.your_table
  for select
  to anon
  using (true);
