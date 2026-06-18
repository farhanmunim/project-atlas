-- ============================================================================
-- 0006_tender_programme.sql -- Upcoming-tender programme (Phase 2b).
--
-- One row per (programme_year, tranche, route) entry from TfL's annual
-- "LBSL Tendering Programme" PDFs:
--   tfl.gov.uk/cdn/static/cms/documents/uploads/forms/{YYYY-YYYY}-lbsl-tendering-programme.pdf
--
-- Distinct from the `tenders` table:
--   `tenders`           = backwards-looking. One row per AWARDED tender,
--                         with bid amounts, the operator that won, etc.
--   `tender_programme`  = forwards-looking. One row per SCHEDULED tender,
--                         with the planned issue/return/award/start dates and
--                         the required vehicle spec. Most rows here will
--                         eventually have a matching `tenders` row once the
--                         award is announced; some won't (cancelled tranches).
--
-- Data refreshes when TfL publishes a new programme PDF (~monthly during the
-- planning year). Re-running the scraper is idempotent on
-- (programme_year, tranche, route_id).
--
-- Run after 0005 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tender_programme (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Composite identity
  programme_year           TEXT NOT NULL,         -- '2026-2027' (TfL financial year)
  tranche                  TEXT,                  -- '956', '1029', etc.
  route_id                 TEXT NOT NULL,         -- '54', '69/N69', 'SL8' (as printed)

  -- Schedule (TfL labels Tender Issue / Return as exact dates;
  -- Contract Award is month-only because it's an estimate)
  tender_issue_date        DATE,
  tender_return_date       DATE,
  award_estimated          TEXT,                  -- 'Jun-25' kept as text — month-only by design
  contract_start_date      DATE,

  -- Per-route context
  route_description        TEXT,                  -- "Hammersmith - Hounslow West"
  vehicle_type             TEXT,                  -- 'DD' / 'SD (45)' / 'ZEDD' / 'ZESD' / etc.
  two_year_extension       BOOLEAN DEFAULT FALSE, -- TfL uses 'x' to flag extension-eligible

  -- Provenance — dual-timestamp convention
  source_url               TEXT,
  pdf_modified_at          TIMESTAMPTZ,           -- TfL CDN's Last-Modified for the PDF
  data_as_of               DATE,                  -- the date we believe this entry is current as of (= pdf_modified_at::date)
  extracted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (programme_year, tranche, route_id)
);

CREATE INDEX IF NOT EXISTS idx_programme_route        ON public.tender_programme(route_id);
CREATE INDEX IF NOT EXISTS idx_programme_year         ON public.tender_programme(programme_year);
CREATE INDEX IF NOT EXISTS idx_programme_tranche      ON public.tender_programme(tranche);
CREATE INDEX IF NOT EXISTS idx_programme_award_date   ON public.tender_programme(contract_start_date);

-- RLS -- anon can read (this is published public data; no PII).
ALTER TABLE public.tender_programme ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_tender_programme ON public.tender_programme;
CREATE POLICY anon_read_tender_programme
  ON public.tender_programme
  FOR SELECT
  TO anon
  USING (TRUE);
