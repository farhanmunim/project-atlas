/**
 * sources/tfl.js — TfL Unified API client (the authoritative London bus feed).
 *
 * One module per upstream source. This wraps the raw TfL endpoints behind the
 * shared http client (timeout/retry/conditional) and returns RAW responses —
 * normalisation into our tool shapes happens in the build/* step, so the
 * source stays a thin, testable boundary.
 *
 * Endpoints used (see data_sources.xlsx):
 *   GET /Line/Mode/bus                          route list           (reference)
 *   GET /Line/Mode/bus/Status                   live status, all bus (~30s)
 *   GET /Line/{id}/Route/Sequence/{dir}         geometry + stops     (reference)
 *
 * Auth: works key-less; if TFL_APP_KEY is set we append it (higher rate limit).
 */

import { getJson } from "../lib/http.js";

const BASE = "https://api.tfl.gov.uk";

function withKey(path) {
  const key = process.env.TFL_APP_KEY;
  if (!key) return BASE + path;
  return BASE + path + (path.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(key);
}

/** Raw bus line list. conditional → may return { notModified:true }. */
export function busLines(opts = {}) {
  return getJson(withKey("/Line/Mode/bus"), opts);
}

/** Raw live status for every bus line. */
export function busStatus(opts = {}) {
  // status is live; don't 304-skip it — we want the current snapshot each run
  return getJson(withKey("/Line/Mode/bus/Status"), { conditional: false, ...opts });
}

/** Raw route sequence (geometry + ordered stops) for one line + direction. */
export function routeSequence(id, dir, opts = {}) {
  return getJson(withKey(`/Line/${encodeURIComponent(id)}/Route/Sequence/${dir}`), opts);
}

/** Raw live arrival predictions for a line — each carries the vehicle reg
 *  (`vehicleId`), the basis for the live fleet running a route. */
export function lineArrivals(id, opts = {}) {
  return getJson(withKey(`/Line/${encodeURIComponent(id)}/Arrivals`), { conditional: false, ...opts });
}
