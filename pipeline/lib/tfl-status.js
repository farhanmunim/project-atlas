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

/** Does any validity window START within the next `days` days (but not yet be active)?
 *  TfL redraws Route/Sequence in ADVANCE of a planned closure (measured ~10 days on
 *  W12/Selborne Rd), so the baseline freeze must engage before the window opens. */
export function windowStartsWithin(validityPeriods, days, now = Date.now()) {
  const horizon = now + days * 86400000;
  return (validityPeriods || []).some((p) => {
    const from = Date.parse(p.fromDate || "");
    return !Number.isNaN(from) && from > now && from <= horizon;
  });
}

/** Route names explicitly cited in a disruption reason ("ROUTES 238 and 376",
 *  "Routes 304 & 376:", "Route 379 will…") — uppercased tokens after a
 *  "route(s)" keyword, scanning through connectors until the first non-route
 *  word. Empty when the text names roads only. Used to drop TfL's occasional
 *  MISATTRIBUTED statuses (verified live: a route-379 parked-vehicle diversion
 *  attached to line 376's status while 379 itself read Good Service). */
export function routesNamedIn(text) {
  const out = new Set();
  const token = /^[A-Z]{0,3}\d{1,3}[A-Z]?$/;   // 376 · W12 · N136 · SL10 · 108D · EL1
  const parts = String(text || "").split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (!/^routes?[:.,]?$/i.test(parts[i])) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const w = parts[j].replace(/^[("'‘“]+/, "").replace(/[.,:;)"'’”]+$/, "").toUpperCase();
      if (w === "" || w === "&" || w === "/" || w === "," || w === "AND") continue;
      if (token.test(w) && /\d/.test(w)) { out.add(w); continue; }
      break;
    }
  }
  return [...out];
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
