-- ============================================================================
-- 0029_route_diversions.sql
--
-- Live route-diversion episodes mirrored from the static store (single source
-- of truth) — the same data the app reads from /api/v1/route-diversions. Built
-- daily by the Atlas pipeline (build/diversions.js): a route flagged by TfL's
-- live bus status with an active service alteration, diffed against the
-- last-good canonical route (stops + geometry) to yield the missed stops and
-- the diverted geometry segments.
--
-- One row per (route, episode): detected_at marks when the pipeline first saw
-- the episode, and rows are never deleted — an episode whose fetched_at stops
-- advancing has ended, so the table accrues a permanent diversion history.
-- Refreshed by mirror-reference-data.js on the existing ingest cadence.
-- ============================================================================

create table if not exists public.route_diversions (
  route_id            text        not null,   -- lowercase TfL line id, e.g. "w12"
  route_name          text        not null,   -- display name, e.g. "W12"
  detected_at         timestamptz not null,   -- first pipeline run that saw this episode
  status              text        not null,   -- TfL severity description, e.g. "Special Service"
  severity            int,                    -- TfL statusSeverity (10 = Good Service)
  reasons             jsonb,                  -- [{ reason, category, since, until }]
  since               timestamptz,            -- earliest validity start across reasons
  until_ts            timestamptz,            -- latest validity end across reasons
  geometry_status     text,                   -- "published" (TfL redrew the line) | "unpublished"
  missed_stops        jsonb,                  -- { outbound:[{id,name,lat,lng}], inbound:[...] }
  added_stops         jsonb,                  -- temporary stops added by the diversion, same shape
  diversion_segments  jsonb,                  -- { outbound:[[[lng,lat],...]], inbound:[...] }
  bypassed_segments   jsonb,                  -- baseline segments not currently served, same shape
  fetched_at          timestamptz not null default now(),
  primary key (route_id, detected_at)
);

create index if not exists route_diversions_fetched_idx on public.route_diversions (fetched_at desc);
create index if not exists route_diversions_route_idx   on public.route_diversions (route_id);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_diversions to anon;
grant select, insert, update, delete on public.route_diversions to authenticated;
grant all on public.route_diversions to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_diversions enable row level security;

drop policy if exists "anon can read all rows" on public.route_diversions;
create policy "anon can read all rows"
  on public.route_diversions
  for select
  to anon
  using (true);
