-- ============================================================================
-- 0003_timestamps_and_route_performance.sql
--
-- Two changes:
--
--   1. Standardise the dual-timestamp convention. Every weekly / append-only
--      table must explicitly carry:
--        - `extracted_at` — when our pipeline collected the row
--        - a period column — when the data is accurate as of (snapshot_date /
--          period_start–period_end / observed_at, depending on shape)
--      Column rename from `inserted_at` → `extracted_at` on the snapshot
--      tables, plus a new `data_as_of` column on `vehicles`.
--
--   2. New `route_performance` table — per-route Excess Wait Time (EWT) for
--      high-frequency routes and On-Time Performance (OTP) for low-frequency
--      routes, parsed from
--        http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf
--      Updates ~every 4 weeks (TfL operates a 13-period year). Idempotent
--      writes keyed on (route_id, period_label) — re-running the same
--      pipeline on the same PDF is a no-op.
--
-- Run after 0002 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── 1. Timestamp standardisation ────────────────────────────────────────────
-- Snapshot tables: rename inserted_at → extracted_at to make the semantic
-- explicit. The column already has DEFAULT NOW() so existing rows keep their
-- original value; new pipeline runs will set it explicitly to the snapshot's
-- run time.
ALTER TABLE public.route_snapshots
  RENAME COLUMN inserted_at TO extracted_at;
ALTER TABLE public.garage_snapshots
  RENAME COLUMN inserted_at TO extracted_at;

-- vehicles is current-state, but the dual-timestamp convention still applies:
-- last_checked_at is when DVLA was queried (≈ data_as_of), updated_at is when
-- the row was last touched in our DB. Add an explicit data_as_of for clarity;
-- backfill from last_checked_at for existing rows.
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS data_as_of TIMESTAMPTZ;
UPDATE public.vehicles
  SET data_as_of = last_checked_at
  WHERE data_as_of IS NULL;

-- ── 2. route_performance — per-route reliability metrics ────────────────────
CREATE TABLE IF NOT EXISTS public.route_performance (
  route_id            TEXT NOT NULL,
  period_label        TEXT NOT NULL,        -- 'Q4 2024/25' as printed in the PDF
  period_start        DATE,                 -- inferred from period_label
  period_end          DATE,                 -- inferred; also serves as the data_as_of date
  service_class       TEXT,                 -- 'high-frequency' | 'low-frequency'
  -- High-frequency metrics (EWT-based)
  ewt_minutes                        NUMERIC(5, 2),   -- excess wait time
  swt_minutes                        NUMERIC(5, 2),   -- scheduled waiting time
  awt_minutes                        NUMERIC(5, 2),   -- actual waiting time
  -- Low-frequency metrics (OTP-based)
  on_time_percent                    NUMERIC(5, 2),   -- % buses departing on time
  early_percent                      NUMERIC(5, 2),
  late_percent                       NUMERIC(5, 2),
  non_arrival_percent                NUMERIC(5, 2),
  -- Common
  scheduled_mileage_operated_percent NUMERIC(5, 2),
  -- Provenance
  source_url          TEXT,                 -- where the PDF came from
  pdf_modified_at     TIMESTAMPTZ,          -- TfL's S3 Last-Modified for the PDF
  extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when our pipeline parsed it
  PRIMARY KEY (route_id, period_label)
);
CREATE INDEX IF NOT EXISTS idx_route_perf_route        ON public.route_performance(route_id);
CREATE INDEX IF NOT EXISTS idx_route_perf_period_end   ON public.route_performance(period_end);
CREATE INDEX IF NOT EXISTS idx_route_perf_service      ON public.route_performance(service_class);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Anon-readable: this is published public data, no PII.
ALTER TABLE public.route_performance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_route_performance ON public.route_performance;
CREATE POLICY anon_read_route_performance
  ON public.route_performance
  FOR SELECT
  TO anon
  USING (TRUE);
