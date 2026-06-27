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
