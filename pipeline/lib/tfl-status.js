/**
 * tfl-status.js — shared interpretation of TfL line-status validity windows.
 *
 * TfL's `validityPeriods[].isNow` cannot be trusted on its own: an in-progress
 * diversion (e.g. a road closed for months, window covering today) is routinely
 * published with isNow=false. Treating isNow as authoritative makes active
 * diversions read as Good Service. So a status counts as active NOW if any of
 * its windows says isNow, OR any window's from/to dates bracket the current
 * time, OR it has no window at all (immediate/unbounded disruptions).
 */

/** Is a lineStatus's validity window active at `now` (ms epoch)? */
export function windowActiveNow(validityPeriods, now = Date.now()) {
  const vp = validityPeriods || [];
  if (!vp.length) return true;
  return vp.some((p) => {
    if (p.isNow) return true;
    const from = Date.parse(p.fromDate || ""), to = Date.parse(p.toDate || "");
    return (Number.isNaN(from) || from <= now) && (Number.isNaN(to) || to >= now);
  });
}

/** Earliest fromDate / latest toDate across a status's windows (ISO or null). */
export function windowBounds(validityPeriods) {
  let from = null, to = null;
  for (const p of validityPeriods || []) {
    const f = Date.parse(p.fromDate || ""), t = Date.parse(p.toDate || "");
    if (!Number.isNaN(f) && (from === null || f < from)) from = f;
    if (!Number.isNaN(t) && (to === null || t > to)) to = t;
  }
  return {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
  };
}
