-- ============================================================================
-- 0011_keep_alive.sql — internal heartbeat table.
--
-- The Supabase Heartbeat workflow (.github/workflows/supabase-heartbeat.yml)
-- POSTs one row into this table every day. The INSERT is the point — a
-- PostgREST SELECT against an existing table was tried first (commit
-- 8b32598 + the original 1efa9c1 design) but Supabase's inactivity tracker
-- did not count it: the project was paused on 2026-05-18 despite every
-- heartbeat run reporting HTTP 200. Community-converged-on pattern (see
-- travisvn/supabase-inactive-fix, et al) is an explicit write into a
-- dedicated keep-alive table, which is what this is.
--
-- The table is internal — never read by the public site or the analytics
-- page. Only the pipeline's service_role writes to it. Storage is trivial
-- (one row per day, ~365 rows/year).
-- ============================================================================

create table if not exists public.keep_alive (
  id           bigserial primary key,
  inserted_at  timestamptz not null default now()
);

create index if not exists keep_alive_inserted_at_idx
  on public.keep_alive (inserted_at desc);

-- ── Data API grants ──────────────────────────────────────────────────────
-- Service-role-only. No anon / authenticated grants because nothing on the
-- public site or analytics page reads this table. Following the explicit-
-- grant pattern from _template.sql so it survives the 30 Oct 2026 Data API
-- grant change unchanged.
grant all on public.keep_alive to service_role;
grant all on sequence public.keep_alive_id_seq to service_role;

-- RLS enabled defensively. service_role bypasses RLS so the heartbeat
-- insert still works; the policy-less state means no other role can read
-- the table even if its grants were widened by mistake later.
alter table public.keep_alive enable row level security;
