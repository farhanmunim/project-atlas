-- ============================================================================
-- 0004_tenders.sql — Tender award results (Phase 2).
--
-- One row per historical bus-route tender award. Source:
--   https://tfl.gov.uk/forms/13796.aspx?btID=<numeric-id>
-- The numeric tfl_tender_id comes from the route dropdown on
-- https://tfl.gov.uk/forms/13923.aspx — each option value uniquely identifies
-- one award event. There are ~2500 of these going back to the early 2000s.
--
-- Rows are immutable once awarded (TfL doesn't retroactively edit them), so
-- the upsert is idempotent on tfl_tender_id and re-running the weekly scrape
-- only inserts new awards.
--
-- Run after 0003 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenders (
  -- Identity
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tfl_tender_id               INTEGER NOT NULL UNIQUE,        -- numeric ID from the TfL form
  route_id                    TEXT NOT NULL,                  -- route as printed (e.g. '1/N1', '482')

  -- Award details (parsed from the result page)
  award_announced_date        DATE,                           -- "award announced 07 April 2016"
  awarded_operator            TEXT,
  number_of_tenderers         INTEGER,                        -- 'One' / 'Two' / digit → integer
  accepted_bid                NUMERIC(14, 2),                 -- £ per annum
  lowest_bid                  NUMERIC(14, 2),
  highest_bid                 NUMERIC(14, 2),
  cost_per_mile               NUMERIC(8, 4),                  -- £/mile
  reason_not_lowest           TEXT,
  joint_bids                  TEXT,
  notes                       TEXT,

  -- Provenance — dual-timestamp convention
  source_url                  TEXT,
  data_as_of                  DATE,                           -- = award_announced_date when known
  extracted_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenders_route             ON public.tenders(route_id);
CREATE INDEX IF NOT EXISTS idx_tenders_award_date        ON public.tenders(award_announced_date);
CREATE INDEX IF NOT EXISTS idx_tenders_awarded_operator  ON public.tenders(awarded_operator);

-- RLS — anon can read (this is published public data; no PII).
ALTER TABLE public.tenders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_tenders ON public.tenders;
CREATE POLICY anon_read_tenders
  ON public.tenders
  FOR SELECT
  TO anon
  USING (TRUE);
