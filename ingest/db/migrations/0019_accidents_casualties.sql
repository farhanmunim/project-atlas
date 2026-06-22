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
