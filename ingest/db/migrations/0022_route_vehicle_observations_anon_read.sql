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
