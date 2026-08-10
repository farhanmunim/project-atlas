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
