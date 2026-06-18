-- ============================================================================
-- 0012_route_snapshot_tender_split.sql
--
-- v2.12 split the route-card tender block into three discrete sections:
--   • Current active contract — what the route is *running on today* (the
--     originating award; may be years old).
--   • Next contract — awarded — the re-tender that's landed but not yet
--     started (only present during the transition window).
--   • Previous operator — the last genuine change of hands.
--
-- The current and previous sections each carry a full detail row mirroring
-- the existing latest-tender block (cost/mile, accepted bid, contracted
-- miles, joint-bid flag, bid count, awarded vehicle, operator). The route
-- card renders them and the XLSX export includes them — but until this
-- migration the historical store carried only the *latest* award's
-- fields, conflating "current contract" with "latest tender".
--
-- Eighteen additive columns, all NULLABLE — legacy snapshots written
-- before this migration carry NULL for the new columns. No rewrites of
-- existing data; no RLS change. Idempotent.
--
-- Run after 0011 in the Supabase SQL Editor.
-- ============================================================================

-- ── 1. Current active contract derivations ──────────────────────────────────
-- The originating award fields. Derived in build-classifications.js by
-- walking tender history backwards from contract_start_date and picking
-- the most recent award whose announcement date precedes that start —
-- distinct from the *latest* award, which describes whatever's most
-- recently been awarded (often a re-tender for the not-yet-started
-- contract). For ~90% of routes the two coincide; for ~10% in the
-- transition window they don't.
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS current_contract_award_date           DATE,
  ADD COLUMN IF NOT EXISTS current_contract_cost_per_mile        NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS current_contract_accepted_bid         NUMERIC(16, 2),
  ADD COLUMN IF NOT EXISTS current_contracted_annual_miles       INTEGER,
  ADD COLUMN IF NOT EXISTS current_contract_number_of_tenderers  SMALLINT,
  ADD COLUMN IF NOT EXISTS current_contract_was_joint_bid        BOOLEAN,
  ADD COLUMN IF NOT EXISTS current_contract_awarded_propulsion   TEXT,
  ADD COLUMN IF NOT EXISTS current_contract_awarded_deck         TEXT,
  ADD COLUMN IF NOT EXISTS current_contract_awarded_operator     TEXT;

-- ── 2. Latest-tender operator (companion to existing last_award_date) ───────
-- Who won the most recent tender. Distinct from `previous_operator` —
-- which is the most recent earlier operator that DIFFERS from the
-- current incumbent (i.e., the predecessor). Before the v2.12 split the
-- two were conflated; storing both makes the change-of-hands query
-- ('show me routes where the next contract awardee differs from the
-- incumbent') tractable without re-deriving.
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS last_awarded_operator                 TEXT;

-- ── 3. Previous-operator contract detail (mirroring current block) ──────────
-- The 'Previous operator' card section gained a full like-for-like
-- detail row in v2.12. operator + award_date were already stored; the
-- rest of the row was not. Term-in-years uses NUMERIC(4,1) here rather
-- than the SMALLINT used for contract_term_years on the current contract —
-- previous-term is sometimes inferred from inter-award gaps and can land
-- on a half-year.
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS previous_award_date                   DATE,
  ADD COLUMN IF NOT EXISTS previous_cost_per_mile                NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS previous_accepted_bid                 NUMERIC(16, 2),
  ADD COLUMN IF NOT EXISTS previous_contracted_annual_miles      INTEGER,
  ADD COLUMN IF NOT EXISTS previous_contract_term_years          NUMERIC(4, 1),
  ADD COLUMN IF NOT EXISTS previous_number_of_tenderers          SMALLINT,
  ADD COLUMN IF NOT EXISTS previous_was_joint_bid                BOOLEAN;

-- ── 4. Tranche (denormalised from tender_programme) ─────────────────────────
-- The programme batch this route's upcoming tender sits in (e.g. '913').
-- Already present in the tender_programme table; carrying it on the
-- snapshot row too means a single-row read covers everything the card
-- renders, no JOIN required for per-week trend queries.
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS next_tender_tranche                   TEXT;

-- ── Indexes for likely access patterns ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_snapshots_current_contract_award_date
  ON public.route_snapshots(current_contract_award_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_last_awarded_operator
  ON public.route_snapshots(last_awarded_operator);
CREATE INDEX IF NOT EXISTS idx_snapshots_next_tender_tranche
  ON public.route_snapshots(next_tender_tranche);
