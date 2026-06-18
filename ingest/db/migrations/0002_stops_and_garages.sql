-- ============================================================================
-- 0002_stops_and_garages.sql
--
-- Adds two missing dimensions to the weekly snapshot model:
--   1. stop_count on route_snapshots — captures growth/shrinkage of each
--      route's stop list over time without storing the full list weekly.
--   2. garage_snapshots — per-garage weekly state. One row per
--      (garage_code, snapshot_date) carrying location + operator + total_pvr
--      + the lists of main / night / school routes operating from there.
--
-- Run after 0001_init.sql in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── 1. stop_count on route_snapshots ────────────────────────────────────────
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS stop_count INTEGER;

-- ── 2. garage_snapshots — weekly per-garage state ───────────────────────────
CREATE TABLE IF NOT EXISTS public.garage_snapshots (
  garage_code      TEXT NOT NULL,            -- preferred TfL code; falls back to LBR code
  snapshot_date    DATE NOT NULL,
  garage_name      TEXT,
  operator         TEXT,
  address          TEXT,
  postcode         TEXT,
  lat              NUMERIC(9, 6),
  lon              NUMERIC(9, 6),
  total_pvr        INTEGER,                  -- summed across routes operating from this garage that week
  route_count      INTEGER,                  -- distinct routes operating from this garage that week
  routes           TEXT[],                   -- main network route IDs operating from here
  night_routes     TEXT[],
  school_routes    TEXT[],
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (garage_code, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_date     ON public.garage_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_operator ON public.garage_snapshots(operator);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_code     ON public.garage_snapshots(garage_code);

-- ── RLS for the new table ───────────────────────────────────────────────────
-- Garage records carry no PII, so the public site can read them. Same policy
-- shape as route_snapshots.
ALTER TABLE public.garage_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_garages ON public.garage_snapshots;
CREATE POLICY anon_read_garages
  ON public.garage_snapshots
  FOR SELECT
  TO anon
  USING (TRUE);
