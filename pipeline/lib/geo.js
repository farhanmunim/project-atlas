/**
 * geo.js — geometry helpers for building the network overview.
 *
 * Route geometries from TfL are dense (hundreds of points each). For the
 * all-routes overview layer we simplify (Ramer–Douglas–Peucker) and round
 * coordinates, cutting the combined file to a fraction of its size with no
 * visible change at city zoom — the difference between an instant whole-network
 * map and a sluggish one. Per-route detail keeps full precision.
 */

/** Round to `dp` decimal places (~11m at 4dp — ample for a route line). */
export function round(n, dp = 4) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Perpendicular distance from point p to segment a→b, in coordinate space. */
function segDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + tc * dx), py - (ay + tc * dy));
}

/** Ramer–Douglas–Peucker on an array of [lng,lat]. tolerance in degrees. */
export function simplify(points, tolerance = 0.0005) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tolerance) {
    const left = simplify(points.slice(0, idx + 1), tolerance);
    const right = simplify(points.slice(idx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

export function roundRing(points, dp = 4) {
  return points.map(([lng, lat]) => [round(lng, dp), round(lat, dp)]);
}

/** Haversine length (km) of a [lng,lat] ring. */
export function lengthKm(points) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const [lng1, lat1] = points[i - 1], [lng2, lat2] = points[i];
    const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(s));
  }
  return d;
}
