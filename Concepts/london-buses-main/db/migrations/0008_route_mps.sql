-- ============================================================================
-- 0008_route_mps.sql
--
-- Add per-route Minimum Performance Standards (MPS) to route_snapshots.
-- These are the contractual benchmarks each route is graded against in its
-- TfL tender. Sourced from per-route QSI PDFs:
--   https://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf
--
-- The values vary route-by-route within the same service class — e.g.
-- routes EL2 (high-freq, EWT MPS 0.70 min) and 122 (high-freq, EWT MPS
-- 1.20 min) — because each tender contract sets its own threshold.
--
--   ewt_mps_minutes      Excess Wait Time MPS (high-frequency routes only).
--                        Smaller is stricter; observed range 0.7-1.4 min.
--   otp_mps_percent      On-Time Performance MPS (low-frequency routes
--                        only). Higher is stricter; observed range 74-90%.
--   mileage_mps_percent  Mileage Operated MPS (both classes; 98-99%).
--
-- All three are stored on route_snapshots so trend queries can see the
-- benchmark drift over time as contracts renew. NULL for routes without a
-- published MPS (school routes have no PDF on TfL's per-route endpoint).
--
-- Run after 0007 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS ewt_mps_minutes      NUMERIC(4, 2),
  ADD COLUMN IF NOT EXISTS otp_mps_percent      NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS mileage_mps_percent  NUMERIC(5, 2);
