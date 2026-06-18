-- ============================================================================
-- 0007_tender_derived_fields.sql
--
-- Add four derived columns to the tender tables. All four are computed by
-- the push-to-supabase.js script from existing fields -- no extra scraping
-- needed -- and applied retroactively to all historical rows on the next
-- push. They live on the table (rather than as views) so analytics queries
-- and tender-overrides.json corrections both work uniformly.
--
--   propulsion_type     'electric' | 'hybrid' | 'hydrogen' | 'diesel' | null
--                       From the notes (tenders) or vehicle_type
--                       (tender_programme): ZEDD / ZESD / "battery hybrid" /
--                       "fuel cell" / etc.
--
--   is_joint_bid        true when the joint_bids field is populated, or the
--                       notes mention "joint bid" / "JB". Tenders only.
--
--   vehicles_basis      'new' | 'existing' | null
--                       From notes: "Awarded on new electrics" -> 'new';
--                       "Award based on existing buses" -> 'existing'.
--                       Tenders only.
--
--   previous_operator   Tenders: the awarded_operator of the prior tender
--                       for the same route (sorted by award_announced_date).
--                       Programme: the current operator running the route
--                       (from route_classifications at push time).
--
-- All four fields are overridable via data/tender-overrides.json.
--
-- Run after 0006 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS propulsion_type   TEXT,
  ADD COLUMN IF NOT EXISTS is_joint_bid      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vehicles_basis    TEXT,
  ADD COLUMN IF NOT EXISTS previous_operator TEXT;

CREATE INDEX IF NOT EXISTS idx_tenders_propulsion       ON public.tenders(propulsion_type);
CREATE INDEX IF NOT EXISTS idx_tenders_previous_op      ON public.tenders(previous_operator);

ALTER TABLE public.tender_programme
  ADD COLUMN IF NOT EXISTS propulsion_type   TEXT,
  ADD COLUMN IF NOT EXISTS previous_operator TEXT;

CREATE INDEX IF NOT EXISTS idx_programme_propulsion     ON public.tender_programme(propulsion_type);
CREATE INDEX IF NOT EXISTS idx_programme_previous_op    ON public.tender_programme(previous_operator);
