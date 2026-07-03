-- ============================================================================
-- 0027_localities.sql
--
-- Mirror the locality-label reference dataset into the warehouse (single source
-- of truth) — the same data the app reads from /api/v1/localities (OpenStreetMap
-- place=town|suburb for Greater London, ODbL, static store). Powers the map's
-- "Place names" layer. Flat one-row-per-place. Refreshed by
-- mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.localities (
  name          text        not null,
  lat           numeric     not null,
  lng           numeric     not null,
  kind          text,                                 -- "town" | "suburb"
  fetched_at    timestamptz not null default now(),
  primary key (name, lat, lng)
);

create index if not exists localities_kind_idx on public.localities (kind);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.localities to anon;
grant select, insert, update, delete on public.localities to authenticated;
grant all on public.localities to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.localities enable row level security;

drop policy if exists "anon can read all rows" on public.localities;
create policy "anon can read all rows"
  on public.localities
  for select
  to anon
  using (true);
