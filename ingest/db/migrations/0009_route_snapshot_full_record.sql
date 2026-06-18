-- ============================================================================
-- 0009_route_snapshot_full_record.sql
--
-- Denormalise the full route-card record onto `route_snapshots` so a single
-- weekly row carries every field the public site renders. Today these
-- values are derived during build-classifications.js and surfaced on the
-- route card / XLSX export, but only a subset survives onto Supabase —
-- the rest are reachable only via multi-table JOINs at query time.
--
-- The point of the historical store is to enable clean per-week trend
-- queries without re-deriving logic. Adding these columns to
-- route_snapshots makes that possible.
--
-- Three groups of additions:
--
--   1. Reliability snapshot (denormalised from route_performance)
--        - service_class       Which classification the QSI report grades
--                              the route under (high-frequency / low-freq).
--        - ewt_minutes         Latest period actual EWT (high-freq routes).
--        - on_time_percent     Latest period actual OTP (low-freq routes).
--        - perf_period         The 4-week period label the actuals cover.
--      The route_performance table keeps the period-keyed history; this
--      column set just lets a snapshot row stand on its own for trend
--      queries spanning many weeks.
--
--   2. Last (current) tender derivations
--        - previous_operator      The most recent earlier operator that
--                                 differs from the current incumbent.
--        - last_award_date        Date the current contract was awarded.
--        - last_cost_per_mile     £/live mile of the accepted bid.
--        - tender_award_count     Times the route has been tendered (since
--                                 2003 in our data).
--        - number_of_tenderers    Bids received for the current contract.
--        - was_joint_bid          Whether the current contract was bundled.
--        - contract_term_years    Length in years (notes-derived or
--                                 inferred from inter-award gaps).
--        - awarded_propulsion     Propulsion the contract specified.
--        - awarded_deck           Deck the contract specified.
--        - prev_awarded_propulsion / prev_awarded_deck — the same fields
--          for the previous contract; useful for transition analysis.
--
--   3. Next (upcoming) tender derivations (from tender_programme)
--        - next_tender_start          When the next contract starts.
--        - next_tender_year           Programme financial year.
--        - extension_eligible         TfL's 2-year-extension flag.
--        - next_award_propulsion / next_award_deck — what TfL plans to
--          require.
--
-- All columns are NULLABLE; legacy snapshots written before this migration
-- carry NULL for the new columns. RLS unchanged.
--
-- Run after 0008 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── 1. Reliability snapshot ─────────────────────────────────────────────────
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS service_class    TEXT,
  ADD COLUMN IF NOT EXISTS ewt_minutes      NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS on_time_percent  NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS perf_period      TEXT;

-- ── 2. Last-contract tender derivations ─────────────────────────────────────
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS previous_operator        TEXT,
  ADD COLUMN IF NOT EXISTS last_award_date          DATE,
  ADD COLUMN IF NOT EXISTS last_cost_per_mile       NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS tender_award_count       SMALLINT,
  ADD COLUMN IF NOT EXISTS number_of_tenderers      SMALLINT,
  ADD COLUMN IF NOT EXISTS was_joint_bid            BOOLEAN,
  ADD COLUMN IF NOT EXISTS contract_term_years      SMALLINT,
  ADD COLUMN IF NOT EXISTS awarded_propulsion       TEXT,
  ADD COLUMN IF NOT EXISTS awarded_deck             TEXT,
  ADD COLUMN IF NOT EXISTS prev_awarded_propulsion  TEXT,
  ADD COLUMN IF NOT EXISTS prev_awarded_deck        TEXT;

-- ── 3. Next-contract programme derivations ──────────────────────────────────
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS next_tender_start        DATE,
  ADD COLUMN IF NOT EXISTS next_tender_year         TEXT,
  ADD COLUMN IF NOT EXISTS extension_eligible       BOOLEAN,
  ADD COLUMN IF NOT EXISTS next_award_propulsion    TEXT,
  ADD COLUMN IF NOT EXISTS next_award_deck          TEXT;

-- Useful indexes for the trend queries this enables.
CREATE INDEX IF NOT EXISTS idx_snapshots_service_class    ON public.route_snapshots(service_class);
CREATE INDEX IF NOT EXISTS idx_snapshots_previous_op      ON public.route_snapshots(previous_operator);
CREATE INDEX IF NOT EXISTS idx_snapshots_last_award_date  ON public.route_snapshots(last_award_date);
