-- ============================================================================
-- 0014_accidents.sql
--
-- Bus/coach-involved road collisions in Greater London, from the DfT STATS19
-- open road-safety dataset (collision + vehicle tables joined on
-- collision_index, filtered to vehicles of type 10/11 and the M25-ish bbox).
-- Feeds Atlas's accidents layer (the old "Sentinel" KSI view).
--
-- One row per STATS19 collision_index. Idempotent on collision_id — a re-run
-- with a freshly-published DfT year upserts affected rows in place; published
-- collisions are immutable so steady-state runs only add new ids.
--
-- STATS19 is OPEN public road-safety data (no personal/sensitive content —
-- no plates, no casualties at row level), so unlike the vehicle/sightings
-- tables this one carries an anon SELECT grant for the public analytics page.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.accidents (
  collision_id    text        primary key,
  lat             numeric,
  lng             numeric,
  severity        text,                              -- fatal | serious | slight
  collision_date  date,
  borough         text,                              -- ONS local-authority district code
  vehicles        smallint,
  extracted_at    timestamptz not null default now()
);

-- Indexes for the analytics access patterns: filter/aggregate by severity and
-- by date (KSI-over-time, severity breakdowns).
create index if not exists accidents_severity_idx       on public.accidents (severity);
create index if not exists accidents_collision_date_idx on public.accidents (collision_date);

-- ── Data API grants ──────────────────────────────────────────────────────
-- Open public dataset → anon may read (analytics page). Pipeline writes via
-- service_role. Created before the 30 Oct 2026 auto-grant change but stated
-- explicitly per _template.sql so it survives that change unchanged.
grant select on public.accidents to anon;
grant select, insert, update, delete on public.accidents to authenticated;
grant all on public.accidents to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS so the grants above don't expose more than intended; the read
-- policy makes all rows visible to anon (open data). service_role bypasses
-- RLS so the pipeline upsert still works.
alter table public.accidents enable row level security;

create policy "anon can read all rows"
  on public.accidents
  for select
  to anon
  using (true);
