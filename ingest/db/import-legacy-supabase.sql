-- ============================================================================
-- import-legacy-supabase.sql — one-shot import of the OLD Supabase warehouse's
-- history into the self-hosted Postgres (Coolify `atlas-db`).
--
-- The new warehouse was rebuilt from sources in July 2026, so it only carries
-- history from the rebuild onward. The old Supabase project (read-only after
-- hitting the free-tier storage cap, Data API dead) still answers direct
-- Postgres connections — this script attaches it via postgres_fdw and merges
-- the historical rows in. Everything is conflict-safe and idempotent:
--   • natural-key tables (snapshots, performance, dailies, accidents, …)
--     → INSERT … ON CONFLICT DO NOTHING — rows the new DB already has win;
--   • tenders → arbitered by the tfl_tender_id unique key;
--   • tender_programme → null-safe NOT EXISTS (its unique key has nullables);
--   • arrival_samples (surrogate bigserial id) → imported WITHOUT id, only
--     rows recorded before the new DB's earliest sample (no overlap possible).
-- Column lists are computed dynamically as the intersection of old and new
-- columns, so minor schema drift between the two databases can't break it.
--
-- RUN ON: the atlas-db container terminal (Coolify), as the postgres superuser
-- (bypasses RLS; fdw needs superuser anyway). The Supabase direct host is
-- IPv6-only — Docker containers usually can't reach it — so use the SESSION
-- POOLER (IPv4, port 5432, NOT the transaction pooler on 6543):
--
--   wget -O /tmp/import-legacy.sql https://atlas.farhan.app/ingest/db/import-legacy-supabase.sql
--   psql -U postgres \
--     -v sb_host='aws-0-<region>.pooler.supabase.com' \
--     -v sb_user='postgres.fctmehpvfejiedreqafr' \
--     -v sb_password='<the database password>' \
--     -f /tmp/import-legacy.sql
--
-- (Session-pooler host + user are on the Supabase dashboard → Connect. If the
-- VPS can reach IPv6, sb_host='db.fctmehpvfejiedreqafr.supabase.co' with
-- sb_user='postgres' works too.)
--
-- The foreign server (and the password stored in its user mapping) is dropped
-- again at the end of the run. Safe to re-run.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── attach the old warehouse ────────────────────────────────────────────────
create extension if not exists postgres_fdw;

drop server if exists legacy_supabase cascade;
create server legacy_supabase
  foreign data wrapper postgres_fdw
  options (host :'sb_host', port '5432', dbname 'postgres',
           sslmode 'require', fetch_size '10000');

create user mapping for current_user
  server legacy_supabase
  options (user :'sb_user', password :'sb_password');

drop schema if exists legacy cascade;
create schema legacy;

import foreign schema public
  limit to (vehicles, route_snapshots, route_vehicle_observations,
            route_vehicle_sightings, garage_snapshots, route_performance,
            tenders, tender_programme, accidents, bus_crowding,
            route_schedule, arrival_samples, route_reliability_daily)
  from server legacy_supabase into legacy;

-- ── merge: natural-key tables — old rows fill the gaps, new rows win ────────
do $$
declare
  t    text;
  cols text;
  n    bigint;
  tables text[] := array[
    'vehicles',                    -- reg-keyed; adds buses that left the fleet pre-rebuild
    'route_snapshots',             -- (route_id, snapshot_date) — the CDC history
    'garage_snapshots',            -- (garage_code, snapshot_date)
    'route_vehicle_observations',  -- (route_id, registration, observed_at)
    'route_vehicle_sightings',     -- (route_id, registration, observed_at)
    'route_performance',           -- (route_id, period_label) — old QSI periods
    'tenders',                     -- unique tfl_tender_id — awards TfL no longer lists
    'accidents',                   -- collision_id (mostly dupes; harmless)
    'bus_crowding',                -- (route_id, busto_year) — earlier BUSTO years
    'route_schedule',              -- (route_id, snapshot_date) — older schedule states
    'route_reliability_daily'      -- (route_id, day) — our own EWT/OTD history
  ];
begin
  foreach t in array tables loop
    -- columns present on BOTH sides, in the old table's order
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into cols
      from information_schema.columns c
     where c.table_schema = 'legacy' and c.table_name = t
       and exists (select 1 from information_schema.columns p
                    where p.table_schema = 'public' and p.table_name = t
                      and p.column_name = c.column_name);
    if cols is null then
      raise notice '%: not found on the legacy side — skipped', t;
      continue;
    end if;
    execute format(
      'insert into public.%I (%s) select %s from legacy.%I on conflict do nothing',
      t, cols, cols, t);
    get diagnostics n = row_count;
    raise notice '%: % historical rows imported', t, n;
  end loop;
end $$;

-- ── merge: tender_programme — its unique key (programme_year, tranche,
--    route_id) has nullable columns ON CONFLICT can't arbitrate on reliably,
--    so dedupe with a null-safe NOT EXISTS instead ─────────────────────────
do $$
declare cols text; n bigint;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into cols
    from information_schema.columns c
   where c.table_schema = 'legacy' and c.table_name = 'tender_programme'
     and exists (select 1 from information_schema.columns p
                  where p.table_schema = 'public' and p.table_name = 'tender_programme'
                    and p.column_name = c.column_name);
  if cols is null then
    raise notice 'tender_programme: not found on the legacy side — skipped';
    return;
  end if;
  execute format(
    'insert into public.tender_programme (%s)
       select %s from legacy.tender_programme o
        where not exists (select 1 from public.tender_programme n
                where n.programme_year is not distinct from o.programme_year
                  and n.tranche        is not distinct from o.tranche
                  and n.route_id       is not distinct from o.route_id)',
    cols, cols);
  get diagnostics n = row_count;
  raise notice 'tender_programme: % historical rows imported', n;
end $$;

-- ── merge: arrival_samples — surrogate id, so import WITHOUT it and take only
--    rows recorded before the new DB's earliest sample (idempotent by cutoff) ─
do $$
declare cols text; n bigint;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into cols
    from information_schema.columns c
   where c.table_schema = 'legacy' and c.table_name = 'arrival_samples'
     and c.column_name <> 'id'
     and exists (select 1 from information_schema.columns p
                  where p.table_schema = 'public' and p.table_name = 'arrival_samples'
                    and p.column_name = c.column_name);
  if cols is null then
    raise notice 'arrival_samples: not found on the legacy side — skipped';
    return;
  end if;
  execute format(
    'insert into public.arrival_samples (%s)
       select %s from legacy.arrival_samples o
        where o.recorded_at < coalesce(
                (select min(recorded_at) from public.arrival_samples),
                ''infinity''::timestamptz)',
    cols, cols);
  get diagnostics n = row_count;
  raise notice 'arrival_samples: % historical rows imported', n;
end $$;

-- ── detach + clean up (removes the stored password with it) ─────────────────
drop schema legacy cascade;
drop server legacy_supabase cascade;

-- ── after-state: row counts + how far back the history now reaches ──────────
select 'route_snapshots'          as dataset, count(*) as rows, min(snapshot_date)::text as earliest from public.route_snapshots
union all select 'garage_snapshots',          count(*), min(snapshot_date)::text from public.garage_snapshots
union all select 'route_performance',         count(*), min(period_label)         from public.route_performance
union all select 'route_reliability_daily',   count(*), min(day)::text            from public.route_reliability_daily
union all select 'route_schedule',            count(*), min(snapshot_date)::text  from public.route_schedule
union all select 'arrival_samples',           count(*), min(recorded_at)::text    from public.arrival_samples
union all select 'route_vehicle_observations',count(*), min(observed_at)::text    from public.route_vehicle_observations
union all select 'route_vehicle_sightings',   count(*), min(observed_at)::text    from public.route_vehicle_sightings
union all select 'vehicles',                  count(*), null                      from public.vehicles
union all select 'tenders',                   count(*), null                      from public.tenders
union all select 'tender_programme',          count(*), null                      from public.tender_programme
union all select 'accidents',                 count(*), null                      from public.accidents
union all select 'bus_crowding',              count(*), min(busto_year)::text     from public.bus_crowding
order by 1;

analyze;
