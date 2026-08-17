/**
 * _lib/schedule-pick.js — pick departures out of a TfL Timetable response
 * (pure logic, no I/O; used by fetch-schedule.js and unit-tested directly).
 *
 * TfL often publishes several schedules that map to the SAME day-type bucket —
 * most commonly "Monday to Thursday" AND "Friday". Concatenating them doubles
 * every departure (audited 2026-08-17: route 25 weekday carried 306 departures,
 * 153 exact duplicates — which wrecked tracked OTD/non-arrival counts and
 * doubled scheduled_trips, inflating lost-mileage). So departures for a
 * day-type come from the SINGLE most representative schedule: widest day
 * coverage first, then most journeys.
 */

// Map a TfL schedule day-type name to a bucket (mirrors fetch-frequencies).
export function classifyScheduleName(name) {
  const n = (name ?? '').toLowerCase();
  if (/mon/.test(n) && /fri/.test(n)) return 'weekday';
  if (/mon/.test(n) && /thu/.test(n)) return 'weekday';
  if (/weekday/.test(n))              return 'weekday';
  if (/sat/.test(n))                  return 'saturday';
  if (/sun/.test(n))                  return 'sunday';
  if (/fri/.test(n))                  return 'weekday';
  return null;
}

// How many days of the week a schedule name covers.
export function scheduleCoverage(name) {
  const n = (name ?? '').toLowerCase();
  if (/mon/.test(n) && /fri/.test(n)) return 5;
  if (/weekday/.test(n))              return 5;
  if (/mon/.test(n) && /thu/.test(n)) return 4;
  return 1;                            // single-day schedules (Friday, Saturday, Sunday)
}

// Sorted minutes-after-midnight departures for a day-type — from the single
// best schedule, never a concatenation. After-midnight journeys are encoded
// hour ≥ 24 by TfL, so wrap via modulo 24.
export function journeysFor(timetable, dayType) {
  let best = null, bestScore = -1;
  for (const rt of (timetable?.timetable?.routes ?? [])) {
    for (const sch of (rt.schedules ?? [])) {
      if (dayType !== 'any' && classifyScheduleName(sch.name) !== dayType) continue;
      const journeys = sch.knownJourneys ?? [];
      const score = scheduleCoverage(sch.name) * 10_000 + journeys.length;
      if (score > bestScore) { bestScore = score; best = journeys; }
    }
  }
  const out = [];
  for (const j of (best ?? [])) {
    const h = Number(j.hour), m = Number(j.minute);
    if (Number.isFinite(h) && Number.isFinite(m)) out.push((h % 24) * 60 + m);
  }
  return out.sort((a, b) => a - b);
}
