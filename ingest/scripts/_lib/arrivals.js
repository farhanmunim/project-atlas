/**
 * _lib/arrivals.js — shared helpers for reading the active fleet from TfL
 * `/Line/<id>/Arrivals`.
 *
 * Both fetch-route-vehicles.js (weekly snapshot → route-vehicles.json) and
 * sample-vehicles.js (daily snapshot → Supabase) need to turn an Arrivals
 * payload into a set of valid UK registration plates. The validation regex is
 * the one piece that MUST stay identical between them — a divergence would let
 * one collector accept bonnet numbers / train ids the other rejects, which
 * would silently corrupt the sighting counts. It lives here so there is exactly
 * one definition.
 */

// TfL exposes the bus registration as `vehicleId` on each prediction. London
// buses use UK reg plates; this matches both the current style (LK20FNZ) and
// older dateless/prefix styles, while rejecting blanks, numeric train ids, and
// the bonnet-number placeholders some operators leak into the field.
export const BUS_REG_RE = /^[A-Z]{1,3}\d{1,3}[A-Z]{0,3}$|^[A-Z]{2}\d{2}[A-Z]{3}$/;

/**
 * Extract the unique, plate-shaped registrations from a TfL Arrivals array.
 * @param {Array<{vehicleId?: string}>} arrivals
 * @returns {string[]} unique uppercase regs (insertion order)
 */
export function extractRegs(arrivals) {
  const out = new Set();
  if (!Array.isArray(arrivals)) return [];
  for (const p of arrivals) {
    const v = String(p?.vehicleId ?? '').toUpperCase().replace(/\s+/g, '');
    if (BUS_REG_RE.test(v)) out.add(v);
  }
  return [...out];
}
