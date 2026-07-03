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
