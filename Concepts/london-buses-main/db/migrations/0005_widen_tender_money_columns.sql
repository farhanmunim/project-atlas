-- ============================================================================
-- 0005_widen_tender_money_columns.sql
--
-- The original tenders schema (0004) declared cost_per_mile as NUMERIC(8, 4),
-- max 9999.9999. The first full historical scrape uncovered TfL-side data
-- quality issues where a few rows have a 7-digit value in that cell — the
-- typical cause is TfL's own form has the row layout shifted by one (e.g.
-- btID 2010, Route 265: the highest-bid cell value duplicated into
-- cost-per-mile). Widening to NUMERIC(12, 4) preserves the raw value as
-- TfL published it; a tender-overrides.json entry can correct it later
-- without losing the original signal.
--
-- Bid columns also widened defensively (annual bids are well under £100M,
-- but bumping to NUMERIC(16, 2) gives headroom for joint bids or weirdness
-- without ever overflowing again).
--
-- Run after 0004 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

ALTER TABLE public.tenders
  ALTER COLUMN cost_per_mile TYPE NUMERIC(12, 4);

ALTER TABLE public.tenders
  ALTER COLUMN accepted_bid TYPE NUMERIC(16, 2),
  ALTER COLUMN lowest_bid   TYPE NUMERIC(16, 2),
  ALTER COLUMN highest_bid  TYPE NUMERIC(16, 2);
