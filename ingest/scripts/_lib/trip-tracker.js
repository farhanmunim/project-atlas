/**
 * _lib/trip-tracker.js — per-vehicle trip state machine (pure logic, no I/O).
 *
 * Feed the whole-London SIRI-VM snapshot in every poll; completed trips fall
 * out. A "trip" is one vehicle's continuous progress along one route+direction
 * geometry. Closing conditions: line/direction change, sustained off-route
 * (dead running), vanishing from the feed for GAP_MIN, or an explicit sweep.
 *
 * Positions are projected onto the route geometry (along-km + off-route
 * metres); pings with an unchanged recordedAt are ignored (stale). Quality
 * gates keep noise out of the trip log: minimum duration, minimum distance,
 * and an off-route share cap. Everything is injectable/deterministic so the
 * whole machine unit-tests without a network.
 */

const R = 6371000, RAD = Math.PI / 180;

export const DEFAULTS = {
  OFF_ROUTE_M: 150,        // beyond this the ping is not on the route
  OFF_STREAK_CLOSE: 4,     // consecutive off-route pings → dead run, close trip
  GAP_MS: 10 * 60_000,     // absent this long → trip over
  MIN_TRIP_MS: 5 * 60_000, // shorter = noise (layover shuffle, GPS bounce)
  MIN_TRIP_KM: 1,          // must actually go somewhere
  JITTER_KM: 0.35,         // tolerated backwards wobble in along-km
};

/** Project [lng,lat] onto a polyline → { alongKm, offM }. */
export function projectOnto(line, lng, lat) {
  let best = Infinity, bestAlong = 0, cum = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const cos = Math.cos(ay * RAD);
    const vx = (bx - ax) * cos * RAD * R, vy = (by - ay) * RAD * R;
    const px = (lng - ax) * cos * RAD * R, py = (lat - ay) * RAD * R;
    const L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, (px * vx + py * vy) / L2)) : 0;
    const d = Math.hypot(px - t * vx, py - t * vy);
    const segLen = Math.sqrt(L2);
    if (d < best) { best = d; bestAlong = cum + segLen * t; }
    cum += segLen;
  }
  return { alongKm: bestAlong / 1000, offM: best };
}

export class TripTracker {
  /** geometry: { [ROUTE_NAME_UPPER]: { "1": [[lng,lat]…], "2": […] } } */
  constructor(geometry, opts = {}) {
    this.geo = geometry;
    this.o = { ...DEFAULTS, ...opts };
    this.state = new Map();     // reg → open trip state
    this.lineLenKm = new Map(); // cache of geometry lengths
  }

  routeLine(route, dir) { return this.geo[route]?.[dir] || null; }
  lenKm(route, dir) {
    const k = route + "|" + dir;
    if (!this.lineLenKm.has(k)) {
      const line = this.routeLine(route, dir);
      let m = 0;
      if (line) for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i];
        m += Math.hypot((bx - ax) * Math.cos(ay * RAD) * RAD * R, (by - ay) * RAD * R);
      }
      this.lineLenKm.set(k, m / 1000);
    }
    return this.lineLenKm.get(k);
  }

  /** One poll of vehicles → array of completed trip records. */
  update(vehicles, nowMs) {
    const done = [];
    const seen = new Set();
    for (const v of vehicles || []) {
      const route = String(v.publishedLine || v.line || "").toUpperCase();
      const dir = String(v.direction || "");
      if (!v.reg || !route || !(dir === "1" || dir === "2")) continue;
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
      const line = this.routeLine(route, dir);
      if (!line) continue;                                  // route we hold no geometry for
      seen.add(v.reg);
      const rec = Date.parse(v.recordedAt || "") || nowMs;
      let s = this.state.get(v.reg);
      if (s && (s.route !== route || s.dir !== dir)) { const t = this.#close(s, "changed"); if (t) done.push(t); s = null; }
      const { alongKm, offM } = projectOnto(line, v.lng, v.lat);
      if (!s) {
        if (offM > this.o.OFF_ROUTE_M) continue;            // don't open trips off-route
        s = { reg: v.reg, route, dir, operatorRef: v.operatorRef || null,
          startAt: rec, lastAt: rec, lastRecordedAt: rec, lastSeen: nowMs,
          minAlong: alongKm, maxAlong: alongKm, pings: 1, offPings: 0, offStreak: 0 };
        this.state.set(v.reg, s);
        continue;
      }
      s.lastSeen = nowMs;
      if (rec <= s.lastRecordedAt) continue;                // stale ping — position not refreshed
      s.lastRecordedAt = rec;
      s.pings++;
      if (offM > this.o.OFF_ROUTE_M) {
        s.offPings++; s.offStreak++;
        if (s.offStreak >= this.o.OFF_STREAK_CLOSE) { const t = this.#close(s, "off-route"); if (t) done.push(t); this.state.delete(v.reg); }
        continue;
      }
      s.offStreak = 0;
      s.lastAt = rec;
      if (alongKm > s.maxAlong) s.maxAlong = alongKm;
      else if (s.maxAlong - alongKm > this.o.JITTER_KM && alongKm < s.minAlong) s.minAlong = alongKm;
    }
    // vehicles that vanished from the feed long enough → close their trips
    for (const [reg, s] of this.state) {
      if (!seen.has(reg) && nowMs - s.lastSeen > this.o.GAP_MS) {
        const t = this.#close(s, "gap"); if (t) done.push(t);
        this.state.delete(reg);
      }
    }
    return done;
  }

  /** Close everything still open (shutdown / end-of-day flush). */
  flush() {
    const done = [];
    for (const [reg, s] of this.state) { const t = this.#close(s, "flush"); if (t) done.push(t); this.state.delete(reg); }
    return done;
  }

  #close(s, why) {
    const kmObserved = Math.max(0, s.maxAlong - s.minAlong);
    const durMs = s.lastAt - s.startAt;
    if (durMs < this.o.MIN_TRIP_MS || kmObserved < this.o.MIN_TRIP_KM) return null;
    if (s.pings >= 4 && s.offPings / s.pings > 0.5) return null;   // mostly off-route = not this route's trip
    const lenKm = this.lenKm(s.route, s.dir) || null;
    return {
      reg: s.reg, route: s.route, dir: s.dir, operatorRef: s.operatorRef,
      startAt: new Date(s.startAt).toISOString(), endAt: new Date(s.lastAt).toISOString(),
      startKm: +s.minAlong.toFixed(2), endKm: +s.maxAlong.toFixed(2),
      kmObserved: +kmObserved.toFixed(2), routeLenKm: lenKm ? +lenKm.toFixed(2) : null,
      coverage: lenKm ? +(kmObserved / lenKm).toFixed(3) : null,
      closed: why,
    };
  }
}
