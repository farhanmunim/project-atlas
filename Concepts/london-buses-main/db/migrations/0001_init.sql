-- ============================================================================
-- 0001_init.sql — Phase 1 schema for the London Buses analytics store.
--
-- Three tables, all in the `public` schema:
--
--   vehicles                       — current state, one row per registration.
--                                    Upserted weekly from data/source/
--                                    vehicle-fleet.json (DVLA-derived).
--   route_snapshots                — per-route weekly state. PK
--                                    (route_id, snapshot_date), append-only by
--                                    week. Powers trend / history charts.
--   route_vehicle_observations     — per-snapshot route → registration
--                                    observations. Append-only log of which
--                                    buses ran which routes when.
--
-- RLS is on for all three. Anon role gets read on `route_snapshots` only.
-- `vehicles` and `route_vehicle_observations` contain registration plates
-- and remain service-role-only — the public site must never expose regs.
--
-- Service role bypasses RLS by default, so no write policies are needed.
--
-- Run once in the Supabase SQL Editor. Idempotent (uses IF NOT EXISTS / OR
-- REPLACE), safe to re-run.
-- ============================================================================

-- ── vehicles — DVLA-derived master fleet table ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicles (
  registration                 TEXT PRIMARY KEY,
  make                         TEXT,
  fuel_type                    TEXT,            -- normalised: electric, hybrid, diesel, hydrogen, gas, petrol
  fuel_type_raw                TEXT,            -- raw DVLA value, in case the mapping needs adjustment
  year_of_manufacture          INTEGER,
  month_of_first_registration  TEXT,            -- 'YYYY-MM' from DVLA
  bonnet_no                    TEXT,            -- operator-specific fleet code
  operator                     TEXT,            -- from iBus Vehicle.xml
  dvla_status                  INTEGER,         -- 200 = found, 404 = not in DVLA, other = error
  last_checked_at              TIMESTAMPTZ,     -- when DVLA was last queried for this reg
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_operator  ON public.vehicles(operator);
CREATE INDEX IF NOT EXISTS idx_vehicles_fuel_type ON public.vehicles(fuel_type);

-- ── route_snapshots — weekly per-route state ────────────────────────────────
-- One row per (route_id, snapshot_date). Idempotent for the same week (re-running
-- the pipeline replaces the row), append-only across weeks.
CREATE TABLE IF NOT EXISTS public.route_snapshots (
  route_id            TEXT NOT NULL,
  snapshot_date       DATE NOT NULL,
  -- Route identity
  type                TEXT,            -- 'regular' | 'night' | 'twentyfour' | 'school'
  is_prefix           BOOLEAN,
  length_band         TEXT,            -- 'short' | 'medium' | 'long'
  -- Vehicle / fleet state (DVLA-derived for fields that come from the fleet)
  deck                TEXT,            -- 'double' | 'single'
  vehicle_type        TEXT,            -- LBR-string vehicle (chassis+body)
  propulsion          TEXT,            -- 'electric' | 'hybrid' | 'diesel' | 'hydrogen'
  make                TEXT,            -- DVLA make (mode of observed regs)
  vehicle_age_years   NUMERIC(4, 1),   -- mean age across observed regs
  fleet_size          INTEGER,         -- count of unique observed regs
  -- Operator + service
  operator            TEXT,
  garage_name         TEXT,
  garage_code         TEXT,
  pvr                 INTEGER,
  frequency           TEXT,            -- 'high' | 'low'
  -- Bookkeeping
  inserted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (route_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_date     ON public.route_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_operator ON public.route_snapshots(operator);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_route    ON public.route_snapshots(route_id);

-- ── route_vehicle_observations — per-snapshot route → reg log ───────────────
-- Append-only. Same (route, reg) can appear many times across observed_at
-- timestamps so we PK on the triple. Used to reconstruct fleet allocation
-- over time (e.g. "did the 25's fleet change in October 2026?").
CREATE TABLE IF NOT EXISTS public.route_vehicle_observations (
  route_id      TEXT NOT NULL,
  registration  TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (route_id, registration, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_rvo_observed_at ON public.route_vehicle_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_rvo_route       ON public.route_vehicle_observations(route_id);
CREATE INDEX IF NOT EXISTS idx_rvo_reg         ON public.route_vehicle_observations(registration);

-- ── Row-level security ──────────────────────────────────────────────────────
-- Anon role (the public site) gets read-only access to route_snapshots.
-- Vehicles + observations contain registration plates and stay locked down to
-- the service role; the analytics page must use aggregating views or RPC, not
-- raw SELECT, when those exposures are needed.

ALTER TABLE public.vehicles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_snapshots            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_vehicle_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_snapshots ON public.route_snapshots;
CREATE POLICY anon_read_snapshots
  ON public.route_snapshots
  FOR SELECT
  TO anon
  USING (TRUE);

-- No anon policies on vehicles or route_vehicle_observations — anon gets zero
-- access to either table. service_role bypasses RLS so the push script writes
-- freely. authenticated role can be opened up later if/when an admin UI lands.
