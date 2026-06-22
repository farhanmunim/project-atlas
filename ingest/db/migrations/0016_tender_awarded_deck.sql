-- ============================================================================
-- 0016_tender_awarded_deck.sql
--
-- Add the awarded DECK to the per-award tenders table. 0007 added
-- propulsion_type / is_joint_bid / vehicles_basis derived from TfL's free-text
-- notes; deck was carried only on tender_programme + route_snapshots
-- (current_contract_awarded_deck), never on the per-award row itself. The Atlas
-- route card now surfaces the awarded vehicle (deck + propulsion + basis) on
-- every historical award, so the warehouse holds it on every award too — keeping
-- Supabase, the data/*.json store, the API, the app and the export in lockstep.
--
--   awarded_deck   'double' | 'single' | null
--                  From notes: "upgrade to double deck operation" -> 'double';
--                  "single deck buses" -> 'single'. Computed in push-to-supabase.js
--                  (deriveAwardedDeck), applied retroactively to all rows on the
--                  next push, and overridable via data/tender-overrides.json.
--
-- Additive + NULLABLE — legacy rows carry NULL until the next push. No RLS change.
-- Run after 0015 in the Supabase SQL Editor. Idempotent.
-- ============================================================================

ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS awarded_deck TEXT;

CREATE INDEX IF NOT EXISTS idx_tenders_awarded_deck ON public.tenders(awarded_deck);
