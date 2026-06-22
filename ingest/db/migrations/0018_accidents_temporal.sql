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
