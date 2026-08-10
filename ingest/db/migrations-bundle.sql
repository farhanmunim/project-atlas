-- migrations-bundle.sql — all ingest/db/migrations/00*.sql concatenated in order.
-- For bootstrapping a fresh self-hosted warehouse Postgres (run once on an empty DB):
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f migrations-bundle.sql
-- Prerequisite: the anon/authenticated/service_role/authenticator roles must exist.
-- Regenerate after adding a migration: cat ingest/db/migrations/00*.sql (with these headers).

-- ============================================================
-- ingest/db/migrations/0001_init.sql
-- ============================================================
-- ============================================================================
-- 0001_init.sql — Phase 1 schema for the London Buses analytics store.
--
-- Three tables, all in the `public` schema:
--
--   vehicles                       — current state, one row per registration.
--                                    Upserted weekly from data/source/
--                                    vehicle-fleet.json (DVLA-derived).
--   route_snapshots                — per-route weekly state. PK
--                                    (route_id, snapshot_date), append-only by
--                                    week. Powers trend / history charts.
--   route_vehicle_observations     — per-snapshot route → registration
--                                    observations. Append-only log of which
--                                    buses ran which routes when.
--
-- RLS is on for all three. Anon role gets read on `route_snapshots` only.
-- `vehicles` and `route_vehicle_observations` contain registration plates
-- and remain service-role-only — the public site must never expose regs.
--
-- Service role bypasses RLS by default, so no write policies are needed.
--
-- Run once in the Supabase SQL Editor. Idempotent (uses IF NOT EXISTS / OR
-- REPLACE), safe to re-run.
-- ============================================================================

-- ── vehicles — DVLA-derived master fleet table ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicles (
  registration                 TEXT PRIMARY KEY,
  make                         TEXT,
  fuel_type                    TEXT,            -- normalised: electric, hybrid, diesel, hydrogen, gas, petrol
  fuel_type_raw                TEXT,            -- raw DVLA value, in case the mapping needs adjustment
  year_of_manufacture          INTEGER,
  month_of_first_registration  TEXT,            -- 'YYYY-MM' from DVLA
  bonnet_no                    TEXT,            -- operator-specific fleet code
  operator                     TEXT,            -- from iBus Vehicle.xml
  dvla_status                  INTEGER,         -- 200 = found, 404 = not in DVLA, other = error
  last_checked_at              TIMESTAMPTZ,     -- when DVLA was last queried for this reg
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_operator  ON public.vehicles(operator);
CREATE INDEX IF NOT EXISTS idx_vehicles_fuel_type ON public.vehicles(fuel_type);

-- ── route_snapshots — weekly per-route state ────────────────────────────────
-- One row per (route_id, snapshot_date). Idempotent for the same week (re-running
-- the pipeline replaces the row), append-only across weeks.
CREATE TABLE IF NOT EXISTS public.route_snapshots (
  route_id            TEXT NOT NULL,
  snapshot_date       DATE NOT NULL,
  -- Route identity
  type                TEXT,            -- 'regular' | 'night' | 'twentyfour' | 'school'
  is_prefix           BOOLEAN,
  length_band         TEXT,            -- 'short' | 'medium' | 'long'
  -- Vehicle / fleet state (DVLA-derived for fields that come from the fleet)
  deck                TEXT,            -- 'double' | 'single'
  vehicle_type        TEXT,            -- LBR-string vehicle (chassis+body)
  propulsion          TEXT,            -- 'electric' | 'hybrid' | 'diesel' | 'hydrogen'
  make                TEXT,            -- DVLA make (mode of observed regs)
  vehicle_age_years   NUMERIC(4, 1),   -- mean age across observed regs
  fleet_size          INTEGER,         -- count of unique observed regs
  -- Operator + service
  operator            TEXT,
  garage_name         TEXT,
  garage_code         TEXT,
  pvr                 INTEGER,
  frequency           TEXT,            -- 'high' | 'low'
  -- Bookkeeping
  inserted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (route_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_date     ON public.route_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_operator ON public.route_snapshots(operator);
CREATE INDEX IF NOT EXISTS idx_route_snapshots_route    ON public.route_snapshots(route_id);

-- ── route_vehicle_observations — per-snapshot route → reg log ───────────────
-- Append-only. Same (route, reg) can appear many times across observed_at
-- timestamps so we PK on the triple. Used to reconstruct fleet allocation
-- over time (e.g. "did the 25's fleet change in October 2026?").
CREATE TABLE IF NOT EXISTS public.route_vehicle_observations (
  route_id      TEXT NOT NULL,
  registration  TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (route_id, registration, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_rvo_observed_at ON public.route_vehicle_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_rvo_route       ON public.route_vehicle_observations(route_id);
CREATE INDEX IF NOT EXISTS idx_rvo_reg         ON public.route_vehicle_observations(registration);

-- ── Row-level security ──────────────────────────────────────────────────────
-- Anon role (the public site) gets read-only access to route_snapshots.
-- Vehicles + observations contain registration plates and stay locked down to
-- the service role; the analytics page must use aggregating views or RPC, not
-- raw SELECT, when those exposures are needed.

ALTER TABLE public.vehicles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_snapshots            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_vehicle_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_snapshots ON public.route_snapshots;
CREATE POLICY anon_read_snapshots
  ON public.route_snapshots
  FOR SELECT
  TO anon
  USING (TRUE);

-- No anon policies on vehicles or route_vehicle_observations — anon gets zero
-- access to either table. service_role bypasses RLS so the push script writes
-- freely. authenticated role can be opened up later if/when an admin UI lands.

-- ============================================================
-- ingest/db/migrations/0002_stops_and_garages.sql
-- ============================================================
-- ============================================================================
-- 0002_stops_and_garages.sql
--
-- Adds two missing dimensions to the weekly snapshot model:
--   1. stop_count on route_snapshots — captures growth/shrinkage of each
--      route's stop list over time without storing the full list weekly.
--   2. garage_snapshots — per-garage weekly state. One row per
--      (garage_code, snapshot_date) carrying location + operator + total_pvr
--      + the lists of main / night / school routes operating from there.
--
-- Run after 0001_init.sql in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── 1. stop_count on route_snapshots ────────────────────────────────────────
ALTER TABLE public.route_snapshots
  ADD COLUMN IF NOT EXISTS stop_count INTEGER;

-- ── 2. garage_snapshots — weekly per-garage state ───────────────────────────
CREATE TABLE IF NOT EXISTS public.garage_snapshots (
  garage_code      TEXT NOT NULL,            -- preferred TfL code; falls back to LBR code
  snapshot_date    DATE NOT NULL,
  garage_name      TEXT,
  operator         TEXT,
  address          TEXT,
  postcode         TEXT,
  lat              NUMERIC(9, 6),
  lon              NUMERIC(9, 6),
  total_pvr        INTEGER,                  -- summed across routes operating from this garage that week
  route_count      INTEGER,                  -- distinct routes operating from this garage that week
  routes           TEXT[],                   -- main network route IDs operating from here
  night_routes     TEXT[],
  school_routes    TEXT[],
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (garage_code, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_date     ON public.garage_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_operator ON public.garage_snapshots(operator);
CREATE INDEX IF NOT EXISTS idx_garage_snapshots_code     ON public.garage_snapshots(garage_code);

-- ── RLS for the new table ───────────────────────────────────────────────────
-- Garage records carry no PII, so the public site can read them. Same policy
-- shape as route_snapshots.
ALTER TABLE public.garage_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read_garages ON public.garage_snapshots;
CREATE POLICY anon_read_garages
  ON public.garage_snapshots
  FOR SELECT
  TO anon
  USING (TRUE);

-- ============================================================
-- ingest/db/migrations/0003_timestamps_and_route_performance.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0004_tenders.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0005_widen_tender_money_columns.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0006_tender_programme.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0007_tender_derived_fields.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0008_route_mps.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0009_route_snapshot_full_record.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0010_route_snapshot_contract_start.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0011_keep_alive.sql
-- ============================================================
-- ============================================================================
-- 0011_keep_alive.sql — internal heartbeat table.
--
-- The Supabase Heartbeat workflow (.github/workflows/supabase-heartbeat.yml)
-- POSTs one row into this table every day. The INSERT is the point — a
-- PostgREST SELECT against an existing table was tried first (commit
-- 8b32598 + the original 1efa9c1 design) but Supabase's inactivity tracker
-- did not count it: the project was paused on 2026-05-18 despite every
-- heartbeat run reporting HTTP 200. Community-converged-on pattern (see
-- travisvn/supabase-inactive-fix, et al) is an explicit write into a
-- dedicated keep-alive table, which is what this is.
--
-- The table is internal — never read by the public site or the analytics
-- page. Only the pipeline's service_role writes to it. Storage is trivial
-- (one row per day, ~365 rows/year).
-- ============================================================================

create table if not exists public.keep_alive (
  id           bigserial primary key,
  inserted_at  timestamptz not null default now()
);

create index if not exists keep_alive_inserted_at_idx
  on public.keep_alive (inserted_at desc);

-- ── Data API grants ──────────────────────────────────────────────────────
-- Service-role-only. No anon / authenticated grants because nothing on the
-- public site or analytics page reads this table. Following the explicit-
-- grant pattern from _template.sql so it survives the 30 Oct 2026 Data API
-- grant change unchanged.
grant all on public.keep_alive to service_role;
grant all on sequence public.keep_alive_id_seq to service_role;

-- RLS enabled defensively. service_role bypasses RLS so the heartbeat
-- insert still works; the policy-less state means no other role can read
-- the table even if its grants were widened by mistake later.
alter table public.keep_alive enable row level security;

-- ============================================================
-- ingest/db/migrations/0012_route_snapshot_tender_split.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0013_route_vehicle_sightings.sql
-- ============================================================
-- ============================================================================
-- 0013_route_vehicle_sightings.sql
--
-- Adds a high-frequency, ROLLING store of route → registration observations,
-- plus an aggregation RPC the weekly build uses to recover each route's core
-- fleet.
--
-- Why a second table instead of reusing route_vehicle_observations?
--   • route_vehicle_observations is the PERMANENT analytics log — one weekly
--     snapshot per (route, reg, week), kept forever so we can answer "which
--     buses ran the 25 in March 2026?".
--   • route_vehicle_sightings is written DAILY by sample-vehicles.js. Daily
--     granularity is only needed to tell a route's recurring fleet from one-off
--     cover buses (build-classifications.js core-fleet filter), and only over a
--     trailing window. Keeping daily rows forever would blow the free tier
--     (~10k rows/day), so this table is pruned to a rolling RETENTION window by
--     the sampler. Separating the two keeps the analytics log clean + small and
--     the recurrence signal bounded.
--
-- Both tables carry registration plates, so — like route_vehicle_observations
-- and vehicles — this table is service-role-only (NO anon grant).
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.route_vehicle_sightings (
  route_id      text        not null,
  registration  text        not null,
  observed_at   timestamptz not null,
  primary key (route_id, registration, observed_at)
);

create index if not exists idx_rvs_observed_at on public.route_vehicle_sightings (observed_at);
create index if not exists idx_rvs_route       on public.route_vehicle_sightings (route_id);

-- ── Grants — service-role-only (carries registration plates) ────────────────
-- Created before the 30 Oct 2026 auto-grant change so anon/authenticated would
-- inherit nothing by default anyway; we make the lock-down explicit and grant
-- only the service role the pipeline writes with.
grant all on public.route_vehicle_sightings to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- service_role bypasses RLS; enabling it with no anon policy means the public
-- anon role can never read a registration plate from this table.
alter table public.route_vehicle_sightings enable row level security;

-- ── route_vehicle_recurrence(p_since) ───────────────────────────────────────
-- Returns, per (route, reg) observed since p_since, how many distinct runs and
-- distinct calendar days the reg ran the route, plus first/last seen. Unions
-- the rolling daily sightings with the permanent weekly observations so the
-- backfill benefits from BOTH the dense recent daily samples AND the months of
-- weekly history already in route_vehicle_observations (so the fix lands on the
-- next build, not only after daily data accrues).
--
-- Aggregating server-side keeps the payload to ~one row per (route, reg)
-- (~13k rows) instead of streaming back hundreds of thousands of raw rows.
create or replace function public.route_vehicle_recurrence(p_since timestamptz)
returns table (
  route_id      text,
  registration  text,
  sightings     bigint,
  days          bigint,
  first_seen    timestamptz,
  last_seen     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with obs as (
    select route_id, registration, observed_at
      from public.route_vehicle_observations
     where observed_at >= p_since
    union
    select route_id, registration, observed_at
      from public.route_vehicle_sightings
     where observed_at >= p_since
  )
  select
    route_id,
    registration,
    count(distinct observed_at)                                  as sightings,
    count(distinct ((observed_at at time zone 'UTC')::date))     as days,
    min(observed_at)                                             as first_seen,
    max(observed_at)                                             as last_seen
  from obs
  group by route_id, registration;
$$;

-- Only the pipeline's service role may run it (the function reads plate-bearing
-- tables; SECURITY DEFINER means it would otherwise run with the owner's rights
-- regardless, so we also restrict who can call it).
revoke all on function public.route_vehicle_recurrence(timestamptz) from public;
grant execute on function public.route_vehicle_recurrence(timestamptz) to service_role;

-- ============================================================
-- ingest/db/migrations/0014_accidents.sql
-- ============================================================
-- ============================================================================
-- 0014_accidents.sql
--
-- Bus/coach-involved road collisions in Greater London, from the DfT STATS19
-- open road-safety dataset (collision + vehicle tables joined on
-- collision_index, filtered to vehicles of type 10/11 and the M25-ish bbox).
-- Feeds Atlas's accidents layer (the old "Sentinel" KSI view).
--
-- One row per STATS19 collision_index. Idempotent on collision_id — a re-run
-- with a freshly-published DfT year upserts affected rows in place; published
-- collisions are immutable so steady-state runs only add new ids.
--
-- STATS19 is OPEN public road-safety data (no personal/sensitive content —
-- no plates, no casualties at row level), so unlike the vehicle/sightings
-- tables this one carries an anon SELECT grant for the public analytics page.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.accidents (
  collision_id    text        primary key,
  lat             numeric,
  lng             numeric,
  severity        text,                              -- fatal | serious | slight
  collision_date  date,
  borough         text,                              -- ONS local-authority district code
  vehicles        smallint,
  extracted_at    timestamptz not null default now()
);

-- Indexes for the analytics access patterns: filter/aggregate by severity and
-- by date (KSI-over-time, severity breakdowns).
create index if not exists accidents_severity_idx       on public.accidents (severity);
create index if not exists accidents_collision_date_idx on public.accidents (collision_date);

-- ── Data API grants ──────────────────────────────────────────────────────
-- Open public dataset → anon may read (analytics page). Pipeline writes via
-- service_role. Created before the 30 Oct 2026 auto-grant change but stated
-- explicitly per _template.sql so it survives that change unchanged.
grant select on public.accidents to anon;
grant select, insert, update, delete on public.accidents to authenticated;
grant all on public.accidents to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS so the grants above don't expose more than intended; the read
-- policy makes all rows visible to anon (open data). service_role bypasses
-- RLS so the pipeline upsert still works.
alter table public.accidents enable row level security;

create policy "anon can read all rows"
  on public.accidents
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0015_live_reliability.sql
-- ============================================================
-- ============================================================================
-- 0015_live_reliability.sql
--
-- Atlas's OWN live-reliability estimates — a higher-frequency supplement to
-- TfL's quarterly published QSI figures (route_performance, populated from the
-- QSI PDF in 0003). TfL publishes EWT / OTP / mileage once per ~4-week period;
-- this pipeline reconstructs the SAME metrics continuously from the live TfL
-- prediction feed so Atlas can show a fresher (if necessarily less precise)
-- reliability signal between official releases.
--
-- Three tables, one per stage of the derivation:
--
--   route_schedule          — the SCHEDULED baseline per route (one row per
--                             route per snapshot_date). Carries the Scheduled
--                             Waiting Time (SWT), the categorical service class
--                             (high- vs low-frequency), scheduled trips/day and
--                             scheduled km. Refreshed weekly from the TfL
--                             Timetable + Route/Sequence endpoints by
--                             fetch-schedule.js. This is the denominator for
--                             EWT and for lost-mileage.
--
--   arrival_samples         — RAW observations appended frequently (~every
--                             30 min) by sample-headways.js: one row per
--                             (route, timing-point stop, vehicle) carrying the
--                             soonest predicted arrival. Accumulating these lets
--                             build-reliability.js reconstruct OBSERVED headways
--                             (sort a stop's distinct vehicle passings by time,
--                             diff consecutive). High-volume + append-only, so
--                             it is pruned to a rolling window by the sampler.
--
--   route_reliability_daily — the DERIVED daily rollup (one row per route per
--                             day) build-reliability.js writes: AWT, EWT (=AWT−
--                             SWT) for high-frequency routes, OTD% for low-
--                             frequency, plus operated/lost km. This is what
--                             Atlas reads alongside route_performance.
--
-- ── ACCURACY CAVEAT (read before trusting these numbers) ────────────────────
-- These are ESTIMATES, not TfL's measured figures. They differ because:
--   • We sample TfL's PREDICTED arrivals (expectedArrival), not the measured
--     actual departure at a calibrated timing point — predictions drift.
--   • Sampling is periodic (~30 min), so short headways between samples are
--     under-observed and gaps can be missed → AWT/EWT are approximate.
--   • Observed headways are reconstructed from distinct vehicle passings, which
--     can double-count or miss a vehicle whose id the feed dropped.
--   • Operated km is inferred from distinct observed vehicle-trips × route
--     length, a coarse proxy for TfL's odometer-based mileage.
-- Treat route_performance (the QSI PDF) as authoritative; treat this table as a
-- fresher directional supplement. Every consumer should surface it as such.
--
-- arrival_samples carries a vehicle_id (a UK reg plate, like the vehicles /
-- sightings tables) so — consistent with that precedent — it is service-role-
-- only (NO anon grant). route_schedule and route_reliability_daily are
-- non-sensitive aggregates, so they carry the usual anon SELECT grant for the
-- analytics page.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ── route_schedule — scheduled baseline (SWT, class, scheduled km) ──────────
create table if not exists public.route_schedule (
  route_id        text    not null,
  snapshot_date   date    not null,
  service_class   text,                 -- 'high-frequency' | 'low-frequency'
  swt_minutes     numeric,              -- Scheduled Waiting Time at the timing point
  scheduled_trips integer,              -- scheduled departures/day at the timing point
  scheduled_km    numeric,              -- scheduled_trips × route length (km)
  headway_min     numeric,              -- representative scheduled headway (mins)
  source          text,                 -- e.g. 'tfl-timetable'
  primary key (route_id, snapshot_date)
);

create index if not exists route_schedule_route_idx on public.route_schedule (route_id);

-- ── arrival_samples — raw observed predictions (append-only, pruned) ────────
create table if not exists public.arrival_samples (
  id           bigserial   primary key,
  route_id     text        not null,
  stop_id      text,
  direction    text,
  vehicle_id   text,                                   -- reg plate (sensitive)
  expected_at  timestamptz,                            -- soonest predicted arrival
  recorded_at  timestamptz not null default now()      -- when we sampled it
);

create index if not exists arrival_samples_route_recorded_idx
  on public.arrival_samples (route_id, recorded_at);

-- ── route_reliability_daily — derived daily rollup ──────────────────────────
create table if not exists public.route_reliability_daily (
  route_id                  text    not null,
  day                       date    not null,
  service_class             text,                       -- determines which metric is meaningful
  awt_minutes               numeric,                    -- Actual Waiting Time  (high-freq)
  swt_minutes               numeric,                    -- Scheduled Waiting Time (copied from route_schedule)
  ewt_minutes               numeric,                    -- AWT − SWT            (high-freq)
  otd_percent               numeric,                    -- % on-time departures (low-freq)
  scheduled_km              numeric,
  operated_km               numeric,
  lost_km                   numeric,                    -- scheduled_km − operated_km
  mileage_operated_percent  numeric,                    -- operated/scheduled × 100
  sample_count              integer,                    -- raw arrival_samples behind this row
  primary key (route_id, day)
);

create index if not exists route_reliability_daily_day_idx on public.route_reliability_daily (day);

-- ── Data API grants ─────────────────────────────────────────────────────────
-- route_schedule + route_reliability_daily are non-sensitive aggregates → anon
-- may read (analytics page); pipeline writes via service_role.
grant select on public.route_schedule to anon;
grant select, insert, update, delete on public.route_schedule to authenticated;
grant all on public.route_schedule to service_role;

grant select on public.route_reliability_daily to anon;
grant select, insert, update, delete on public.route_reliability_daily to authenticated;
grant all on public.route_reliability_daily to service_role;

-- arrival_samples carries a registration plate → service-role-only (NO anon),
-- matching the vehicles / route_vehicle_sightings precedents.
grant all on public.arrival_samples to service_role;
-- bigserial → grant the sequence to service_role too (anon never inserts).
grant all on sequence public.arrival_samples_id_seq to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Enable RLS on all three so grants don't over-expose; service_role bypasses
-- RLS, so the pipeline writes work regardless. anon-readable tables get an
-- explicit all-rows read policy; arrival_samples gets none (locked to service).
alter table public.route_schedule          enable row level security;
alter table public.route_reliability_daily enable row level security;
alter table public.arrival_samples         enable row level security;

create policy "anon can read all rows"
  on public.route_schedule
  for select
  to anon
  using (true);

create policy "anon can read all rows"
  on public.route_reliability_daily
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0016_tender_awarded_deck.sql
-- ============================================================
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

-- ============================================================
-- ingest/db/migrations/0017_accidents_context.sql
-- ============================================================
-- ============================================================================
-- 0017_accidents_context.sql
--
-- Enrich public.accidents with decoded STATS19 collision-context attributes:
-- road type, speed limit, junction detail, light/weather/road-surface conditions.
-- These come straight from the DfT collision table (decoded to clean labels in
-- ingest/scripts/fetch-accidents.js) and power the app's "aggregate by" lens
-- dimensions + richer risk breakdowns. All nullable (STATS19 leaves some blank).
--
-- Additive only — existing rows keep their values; the next ingest backfills the
-- new columns on upsert (collision_id is the stable key). Run once in the
-- Supabase SQL Editor. Idempotent.
-- ============================================================================

alter table public.accidents add column if not exists road_type     text;  -- Single/Dual carriageway, Roundabout, One-way street, Slip road
alter table public.accidents add column if not exists speed_limit   text;  -- "20 mph" … "70 mph"
alter table public.accidents add column if not exists junction      text;  -- T/staggered, Crossroads, Roundabout, Not at junction …
alter table public.accidents add column if not exists light         text;  -- Daylight, Dark — lit/unlit/no lighting
alter table public.accidents add column if not exists weather       text;  -- Fine, Raining, Snowing, Fog/mist …
alter table public.accidents add column if not exists road_surface  text;  -- Dry, Wet/damp, Frost/ice, Snow, Flood …

-- Index the two most-used analytical filters (alongside the existing severity/date).
create index if not exists accidents_road_type_idx   on public.accidents (road_type);
create index if not exists accidents_speed_limit_idx on public.accidents (speed_limit);

-- ============================================================
-- ingest/db/migrations/0018_accidents_temporal.sql
-- ============================================================
-- ============================================================================
-- 0018_accidents_temporal.sql
--
-- Add the STATS19 temporal context to public.accidents: day-of-week and the
-- time-of-day band (AM peak / Inter-peak / PM peak / Evening / Night), decoded
-- from the collision table's day_of_week + time fields in the fetcher. Powers
-- "when is this route riskiest?" — day/time lens dimensions + risk breakdowns.
--
-- Additive only; the next ingest backfills on upsert (collision_id is the key).
-- The push tolerates these columns being absent (self-healing upsert), so this
-- migration can be applied any time. Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

alter table public.accidents add column if not exists day        text;  -- Mon … Sun (STATS19 day_of_week)
alter table public.accidents add column if not exists time_band  text;  -- AM peak | Inter-peak | PM peak | Evening | Night

create index if not exists accidents_time_band_idx on public.accidents (time_band);

-- ============================================================
-- ingest/db/migrations/0019_accidents_casualties.sql
-- ============================================================
-- ============================================================================
-- 0019_accidents_casualties.sql
--
-- Add casualty count (number of people injured) to public.accidents, from the
-- STATS19 collision table's number_of_casualties field. Distinct from severity
-- (worst injury) and vehicles (count of vehicles) — it's the magnitude of harm,
-- surfaced as a "Casualties" metric in the apps' risk readouts.
--
-- Additive; the next ingest backfills on upsert. The push tolerates the column
-- being absent (self-healing upsert), so apply any time. Run once in the
-- Supabase SQL Editor. Idempotent.
-- ============================================================================

alter table public.accidents add column if not exists casualties smallint;

-- ============================================================
-- ingest/db/migrations/0020_bus_crowding.sql
-- ============================================================
-- ============================================================================
-- 0020_bus_crowding.sql
--
-- Bus crowding per route, from TfL's BUSTO open dataset
-- (crowding.data.tfl.gov.uk → "MAX DEMAND HOUR BY ROUTE BY TIMEBAND"). One row
-- per (route, year): the route's busiest point — peak V/C (= load ÷ capacity at
-- the max-demand hour), banded comfortable→crowded, plus the per-day-type peak.
-- Feeds Atlas's Crowding layer + the route dossier's Crowding readout.
--
-- BUSTO is published annually, so the (route_id, busto_year) key lets the table
-- accrue year-over-year (a multi-year crowding history) without overwriting past
-- years. A re-run of the same year upserts in place.
--
-- BUSTO is OPEN aggregate demand data (no personal content), so it carries an
-- anon SELECT grant like accidents/route_performance.
--
-- Run once in the Supabase SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.bus_crowding (
  route_id        text        not null,             -- route name, e.g. "25", "N15", "SL9"
  busto_year      text        not null,             -- BUSTO year folder, e.g. "2025-2026"
  peak_vc         numeric,                           -- peak volume-to-capacity (load ÷ capacity)
  band            text,                              -- comfortable | moderate | busy | crowded
  load            numeric,                           -- passengers on board at the peak point
  capacity        numeric,                           -- vehicle capacity at the peak point
  seats           numeric,
  boardings       numeric,
  day_type        text,                              -- Weekday | Saturday | Sunday
  peak_time       text,                              -- quarter-hour of the peak, e.g. "15:45:00"
  timeband        smallint,
  direction       text,
  stopcode        text,
  stopname        text,
  stop_sequence   numeric,
  max_load        numeric,                           -- max load seen anywhere on the route
  max_capacity    numeric,
  weekday_vc      numeric,                           -- per-day-type peak V/C
  saturday_vc     numeric,
  sunday_vc       numeric,
  extracted_at    timestamptz not null default now(),
  primary key (route_id, busto_year)
);

-- Analytics access patterns: filter/aggregate by band and by year.
create index if not exists bus_crowding_band_idx on public.bus_crowding (band);
create index if not exists bus_crowding_year_idx on public.bus_crowding (busto_year);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.bus_crowding to anon;
grant select, insert, update, delete on public.bus_crowding to authenticated;
grant all on public.bus_crowding to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.bus_crowding enable row level security;

create policy "anon can read all rows"
  on public.bus_crowding
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0021_route_schedule_qsi.sql
-- ============================================================
-- ============================================================================
-- 0021_route_schedule_qsi.sql
--
-- Two additions to route_schedule for higher-fidelity live reliability, per the
-- TfL methodology in ingest/RELIABILITY-METHODOLOGY.md:
--
--   • scheduled_departures (jsonb) — per-trip scheduled departure minutes at the
--     timing point, by day-type: {"weekday":[...],"saturday":[...],"sunday":[...]}.
--     Lets build-reliability score low-frequency OTD against the ACTUAL scheduled
--     departures (TfL's 2.5-min-early..5-min-late window) instead of a synthetic
--     headway grid. (Item 3.)
--
--   • qsi_point_stop_ids (jsonb) — the set of representative QSI/timing-point
--     stop ids to observe for this route (a small mid-route set, excluding the
--     terminus and any stop within ~1 km of it — TfL's QSI-point exclusion).
--     The sampler observes all of them; AWT aggregates across them. (Item 2.)
--
-- Both are nullable and additive: until populated, build-reliability falls back to
-- the single timing_point_stop_id + synthetic-grid OTD (graceful, no breakage).
-- Run once in the Supabase SQL editor (idempotent).
-- ============================================================================

alter table route_schedule
  add column if not exists scheduled_departures jsonb,
  add column if not exists qsi_point_stop_ids    jsonb;

comment on column route_schedule.scheduled_departures is
  'Per-trip scheduled departure minutes-after-midnight at the timing point, by day-type {weekday,saturday,sunday}. Source: TfL Timetable. Drives low-frequency OTD.';
comment on column route_schedule.qsi_point_stop_ids is
  'Representative QSI/timing-point stop ids to observe (mid-route set, terminus + within-1km excluded). The sampler observes all; AWT aggregates across them.';

-- ============================================================
-- ingest/db/migrations/0022_route_vehicle_observations_anon_read.sql
-- ============================================================
-- 0022 — anon read on route_vehicle_observations
--
-- The /api/v1/history/vehicle-sightings endpoint serves this table (reg ↔ route ↔
-- timestamp). Migration 0001 enabled RLS but left it locked to the service role; the
-- old Supabase-cloud deployment opened it up with a "public read" policy added by hand
-- in the SQL Editor (documented only in the README's historical-API setup) — that step
-- never made it into a migration. Porting it here so a freshly-bootstrapped warehouse
-- (the self-hosted Postgres that replaces Supabase) matches prod: without this the
-- vehicle-sightings endpoint silently returns empty because RLS blocks anon.
--
-- Registration plates on London buses are public (shown on the vehicle, published by
-- bustimes.org), so reg ↔ route ↔ time exposes no private data.

drop policy if exists "anon can read all rows" on public.route_vehicle_observations;
create policy "anon can read all rows"
  on public.route_vehicle_observations
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0023_route_stops.sql
-- ============================================================
-- ============================================================================
-- 0023_route_stops.sql
--
-- Mirror the route-stops reference dataset into the warehouse so the DB is a
-- single source of truth. Ordered stop sequences per route and direction —
-- the same data the app reads from /api/v1/route-stops (static store). Reference
-- data (changes only on network revisions), refreshed by mirror-reference-data.js
-- on the weekly ingest. One row per (route_id, direction); the stop sequence is
-- kept as a JSONB array (id, name, lat, lng, lines) — lossless vs the API shape.
-- ============================================================================

create table if not exists public.route_stops (
  route_id      text        not null,               -- route name, e.g. "25", "N15", "SL9"
  direction     text        not null,               -- "outbound" | "inbound"
  stops         jsonb       not null default '[]',   -- ordered [{id,name,lat,lng,lines}]
  n_stops       integer,
  fetched_at    timestamptz not null default now(),
  primary key (route_id, direction)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_stops to anon;
grant select, insert, update, delete on public.route_stops to authenticated;
grant all on public.route_stops to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_stops enable row level security;

drop policy if exists "anon can read all rows" on public.route_stops;
create policy "anon can read all rows"
  on public.route_stops
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0024_route_geometry.sql
-- ============================================================
-- ============================================================================
-- 0024_route_geometry.sql
--
-- Mirror the route line geometry into the warehouse (single source of truth) —
-- the same data the app reads from /api/v1/routes-overview (routes-overview.geojson,
-- static store). One row per (route_id, direction); the line coordinates are kept
-- as a JSONB array (GeoJSON [lng,lat] pairs) with the geometry type, so both
-- LineString and MultiLineString round-trip losslessly. Reference data, refreshed
-- by mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.route_geometry (
  route_id      text        not null,               -- route name, e.g. "25"
  direction     text        not null,               -- "1" outbound | "2" inbound (as in the geojson)
  geom_type     text,                                -- "LineString" | "MultiLineString"
  coordinates   jsonb       not null default '[]',   -- GeoJSON coordinates ([lng,lat] pairs)
  length_km     numeric,
  n_stops       integer,
  route_type    text,
  fetched_at    timestamptz not null default now(),
  primary key (route_id, direction)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_geometry to anon;
grant select, insert, update, delete on public.route_geometry to authenticated;
grant all on public.route_geometry to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_geometry enable row level security;

drop policy if exists "anon can read all rows" on public.route_geometry;
create policy "anon can read all rows"
  on public.route_geometry
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0025_bridges.sql
-- ============================================================
-- ============================================================================
-- 0025_bridges.sql
--
-- Mirror the low-bridge / height-restriction reference dataset into the warehouse
-- (single source of truth) — the same data the app reads from /api/v1/bridges
-- (London Datastore EPOWR, static store). Flat one-row-per-structure so it's
-- directly queryable (e.g. "bridges under 4.4 m in Newham"). Reference data,
-- refreshed by mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.bridges (
  bridge_id        text        primary key,          -- EPOWR structure id, e.g. "TQ4906283214"
  lat              numeric,
  lng              numeric,
  height_m         numeric,                           -- conservative clearance (lower band bound), metres
  height_imperial  text,                              -- e.g. "Between 15'0\" and 16'6\""
  name             text,
  road             text,
  structure_type   text,                              -- bridge | tunnel | barrier
  borough          text,
  fetched_at       timestamptz not null default now()
);

-- Analytics access patterns: clearance thresholds + by borough.
create index if not exists bridges_height_idx  on public.bridges (height_m);
create index if not exists bridges_borough_idx on public.bridges (borough);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.bridges to anon;
grant select, insert, update, delete on public.bridges to authenticated;
grant all on public.bridges to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.bridges enable row level security;

drop policy if exists "anon can read all rows" on public.bridges;
create policy "anon can read all rows"
  on public.bridges
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0026_crowding_profile.sql
-- ============================================================
-- ============================================================================
-- 0026_crowding_profile.sql
--
-- Mirror the per-route crowding DETAIL into the warehouse (single source of
-- truth) — the same data the app reads from /api/v1/crowding-profile (TfL BUSTO,
-- static store). Complements bus_crowding (the per-route summary): this holds the
-- load-along-route profile (V/C by stop in sequence) and the time-of-day curve
-- (V/C per timeband, per day type). Kept as JSONB (nested arrays). Keyed
-- (route_id, busto_year) — snapshotted per BUSTO year like bus_crowding — so the
-- crowding profile accrues year-over-year for trend analysis. Refreshed by
-- mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.crowding_profile (
  route_id      text        not null,                -- route name, e.g. "25"
  busto_year    text        not null,                -- BUSTO year, e.g. "2025-2026"
  profile_dir   text,                                 -- busiest direction ("1"|"2")
  load_profile  jsonb,                                -- [{seq,name,vc}] V/C by stop in sequence
  time_of_day   jsonb,                                -- { Weekday:[{t,vc}], Saturday:[…], Sunday:[…] }
  fetched_at    timestamptz not null default now(),
  primary key (route_id, busto_year)
);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.crowding_profile to anon;
grant select, insert, update, delete on public.crowding_profile to authenticated;
grant all on public.crowding_profile to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.crowding_profile enable row level security;

drop policy if exists "anon can read all rows" on public.crowding_profile;
create policy "anon can read all rows"
  on public.crowding_profile
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0027_localities.sql
-- ============================================================
-- ============================================================================
-- 0027_localities.sql
--
-- Mirror the locality-label reference dataset into the warehouse (single source
-- of truth) — the same data the app reads from /api/v1/localities (OpenStreetMap
-- place=town|suburb for Greater London, ODbL, static store). Powers the map's
-- "Place names" layer. Flat one-row-per-place. Refreshed by
-- mirror-reference-data.js on the weekly ingest.
-- ============================================================================

create table if not exists public.localities (
  name          text        not null,
  lat           numeric     not null,
  lng           numeric     not null,
  kind          text,                                 -- "town" | "suburb"
  fetched_at    timestamptz not null default now(),
  primary key (name, lat, lng)
);

create index if not exists localities_kind_idx on public.localities (kind);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.localities to anon;
grant select, insert, update, delete on public.localities to authenticated;
grant all on public.localities to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.localities enable row level security;

drop policy if exists "anon can read all rows" on public.localities;
create policy "anon can read all rows"
  on public.localities
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0028_route_schedule_timing_point.sql
-- ============================================================
-- ============================================================================
-- 0028_route_schedule_timing_point.sql
--
-- Add route_schedule.timing_point_stop_id — the representative QSI/timing-point
-- stop the SWT + single-point OTD are measured at. push-to-supabase.js writes it
-- (pushSchedule), but it was only ever added by hand on the old Supabase DB and
-- never committed as a migration, so a freshly-bootstrapped warehouse lacks it
-- and the route_schedule upsert hard-fails. Porting it here (and it's now in the
-- push's optional-columns self-heal list too, so a missing column degrades
-- gracefully rather than failing the whole table). Nullable + additive.
-- ============================================================================

alter table public.route_schedule
  add column if not exists timing_point_stop_id text;

comment on column public.route_schedule.timing_point_stop_id is
  'Representative QSI/timing-point stop id the SWT and single-point OTD are measured at.';

-- ============================================================
-- ingest/db/migrations/0029_route_diversions.sql
-- ============================================================
-- ============================================================================
-- 0029_route_diversions.sql
--
-- Live route-diversion episodes mirrored from the static store (single source
-- of truth) — the same data the app reads from /api/v1/route-diversions. Built
-- daily by the Atlas pipeline (build/diversions.js): a route flagged by TfL's
-- live bus status with an active service alteration, diffed against the
-- last-good canonical route (stops + geometry) to yield the missed stops and
-- the diverted geometry segments.
--
-- One row per (route, episode): detected_at marks when the pipeline first saw
-- the episode, and rows are never deleted — an episode whose fetched_at stops
-- advancing has ended, so the table accrues a permanent diversion history.
-- Refreshed by mirror-reference-data.js on the existing ingest cadence.
-- ============================================================================

create table if not exists public.route_diversions (
  route_id            text        not null,   -- lowercase TfL line id, e.g. "w12"
  route_name          text        not null,   -- display name, e.g. "W12"
  detected_at         timestamptz not null,   -- first pipeline run that saw this episode
  status              text        not null,   -- TfL severity description, e.g. "Special Service"
  severity            int,                    -- TfL statusSeverity (10 = Good Service)
  reasons             jsonb,                  -- [{ reason, category, since, until }]
  since               timestamptz,            -- earliest validity start across reasons
  until_ts            timestamptz,            -- latest validity end across reasons
  geometry_status     text,                   -- "published" (TfL redrew the line) | "unpublished"
  missed_stops        jsonb,                  -- { outbound:[{id,name,lat,lng}], inbound:[...] }
  added_stops         jsonb,                  -- temporary stops added by the diversion, same shape
  diversion_segments  jsonb,                  -- { outbound:[[[lng,lat],...]], inbound:[...] }
  bypassed_segments   jsonb,                  -- baseline segments not currently served, same shape
  fetched_at          timestamptz not null default now(),
  primary key (route_id, detected_at)
);

create index if not exists route_diversions_fetched_idx on public.route_diversions (fetched_at desc);
create index if not exists route_diversions_route_idx   on public.route_diversions (route_id);

-- ── Data API grants ──────────────────────────────────────────────────────
grant select on public.route_diversions to anon;
grant select, insert, update, delete on public.route_diversions to authenticated;
grant all on public.route_diversions to service_role;

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.route_diversions enable row level security;

drop policy if exists "anon can read all rows" on public.route_diversions;
create policy "anon can read all rows"
  on public.route_diversions
  for select
  to anon
  using (true);

-- ============================================================
-- ingest/db/migrations/0030_vehicle_body.sql
-- ============================================================
-- ============================================================================
-- 0030_vehicle_body.sql
--
-- Per-vehicle body/type enrichment columns on public.vehicles — the fields the
-- DVLA cannot provide, filled by the community tier (bustimes.org open API)
-- under the source-priority contract: DVLA first and never overwritten;
-- bustimes fills body/deck/fleet_code plus the one documented exception
-- (upgrading DVLA's known hybrid/FCEV fuel misreports, flagged via
-- propulsion_source). Mirrored from /api/v1/vehicles by
-- mirror-reference-data.js on the existing ingest cadence.
-- ============================================================================

alter table public.vehicles
  add column if not exists body text,               -- full type: chassis + bodywork, e.g. "Volvo B5LH Wright Eclipse Gemini 3"
  add column if not exists deck text,               -- "double" | "single"
  add column if not exists fleet_code text,         -- operator fleet code, e.g. "VWH2399"
  add column if not exists propulsion_source text;  -- "bustimes" when the propulsion value was community-corrected

comment on column public.vehicles.body is
  'Chassis + bodywork type from the community tier (bustimes.org); DVLA has no body field.';
