-- ============================================================================
-- 0010_route_snapshot_contract_start.sql
--
-- Add `contract_start_date` to route_snapshots. The TfL tender form
-- (13796.aspx) does not publish a contract start column — only the award
-- announcement date — but the LBSL tendering programme PDFs do. We join
-- the two sources in build-classifications.js: for each route, the current
-- contract's start is the earliest programme contract_start_date that's
-- strictly after the most recent award_announced_date (capped at 2 years).
--
-- Coverage: ~277 routes (those whose current contract started 2017+ and
-- whose programme entry survived parsing). NULL for older contracts.
--
-- Run after 0009 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS contract_start_date DATE;

CREATE INDEX IF NOT EXISTS idx_snapshots_contract_start_date
  ON public.route_snapshots(contract_start_date);
