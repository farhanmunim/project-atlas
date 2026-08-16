/**
 * _lib/tracking-day.js — shared day-input loaders for the tracked-day builders
 * (build-lost-mileage.js, build-reliability-tracked.js).
 *
 * Both builders consume the same inputs for one day: the collector's trip log
 * + feed-health counts (data/tracking/), the latest route_schedule per route,
 * each route's timing-point along-km (stop position projected onto our own
 * routes-overview geometry), and per-operator feed-outage windows. Extracted
 * here so the two stay in lockstep — a fix to the loading logic lands in both.
 */

import fs from 'node:fs';
import path from 'node:path';
import { userAgentHeaders, fetchWithTimeout } from './http.js';
import { projectOnto } from './trip-tracker.js';
import { unhealthyWindows, median } from './lost-mileage.js';

const PAGE = 1000;

export const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } };
export const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export async function getJson(url, script) {
  const r = await fetchWithTimeout(url, { headers: userAgentHeaders(script) });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.json();
}

export async function selectAll(supabase, table, build, orderCols = []) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = build(supabase.from(table).select('*'));
    for (const c of orderCols) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Latest route_schedule row per route (ordered scan — later snapshot wins). */
export async function loadScheduleLatest(supabase) {
  const schedRows = await selectAll(supabase, 'route_schedule', (q) => q, ['route_id', 'snapshot_date']);
  const sched = new Map();
  for (const r of schedRows) sched.set(String(r.route_id).toUpperCase(), r);
  return sched;
}

/** Timing-point along-km resolver: stop position projected onto outbound geometry.
 *  Returns timingKmOf(name, schedRow, lenKm) with a mid-route fallback. */
export async function loadTimingContext(atlasApi, script) {
  const [stopsD, geoD] = await Promise.all([getJson(`${atlasApi}/route-stops`, script), getJson(`${atlasApi}/routes-overview`, script)]);
  const geoByName = {};
  for (const f of geoD.features || []) {
    if (String(f.properties?.direction) !== '1') continue;
    geoByName[String(f.properties.name).toUpperCase()] = f.geometry.coordinates;
  }
  const stopsById = {};   // routeNAME → { stopId → [lng,lat] }
  for (const [rid, dirs] of Object.entries(stopsD.routes || {})) {
    const m = {};
    for (const s of dirs.outbound || []) m[s.id] = [s.lng, s.lat];
    stopsById[rid.toUpperCase()] = m;
  }
  return {
    timingKmOf(name, schedRow, lenKm) {
      const line = geoByName[name];
      const pos = stopsById[name]?.[schedRow?.timing_point_stop_id];
      if (line && pos) return projectOnto(line, pos[0], pos[1]).alongKm;
      return (lenKm || 0) / 2;   // fallback: mid-route
    },
  };
}

/** Per-operator feed-outage windows for `day`: today's hourly counts vs the
 *  trailing-median baseline. Returns { [operatorRef]: [{fromMin,toMin}] }. */
export function loadFeedWindows(dir, day, day0, lookbackDays = 14) {
  const todayHealth = readJson(path.join(dir, `feedhealth-${day}.json`)) || {};
  const histByOp = {};   // op → hour → [counts…]
  for (let i = 1; i <= lookbackDays; i++) {
    const h = readJson(path.join(dir, `feedhealth-${new Date(day0 - i * 86_400_000).toISOString().slice(0, 10)}.json`));
    if (!h) continue;
    for (const [op, hours] of Object.entries(h)) for (const [hr, n] of Object.entries(hours)) ((histByOp[op] ||= {})[hr] ||= []).push(n);
  }
  const windowsByOp = {};
  for (const op of Object.keys(todayHealth)) {
    const medBy = Object.fromEntries(Object.entries(histByOp[op] || {}).map(([h, xs]) => [h, median(xs)]));
    windowsByOp[op] = unhealthyWindows(todayHealth[op], medBy);
  }
  return windowsByOp;
}

/** Group a day's trips into per-vehicle route assignments: one record per
 *  (registration, route) with the first/last-seen window, trip count and
 *  observed km — both directions. A bus reallocated mid-day yields one
 *  record per route it worked. Pure; unit-tested. */
export function groupAssignments(trips, day) {
  const by = new Map();   // reg|ROUTE → agg
  for (const t of trips || []) {
    if (!t.reg || !t.route) continue;
    const k = `${t.reg}|${t.route}`;
    let a = by.get(k);
    if (!a) { a = { registration: t.reg, route_id: t.route, day, trips: 0, first_seen: t.startAt, last_seen: t.endAt, km_observed: 0 }; by.set(k, a); }
    a.trips++;
    if (t.startAt < a.first_seen) a.first_seen = t.startAt;
    if (t.endAt > a.last_seen) a.last_seen = t.endAt;
    a.km_observed = +(a.km_observed + (t.kmObserved || 0)).toFixed(1);
  }
  return [...by.values()];
}

/** route → operatorRef by majority vote from the day's own trips. */
export function routeOperators(trips) {
  const opOf = {};
  for (const t of trips) { if (!t.operatorRef) continue; ((opOf[t.route] ||= {})[t.operatorRef] ??= 0); opOf[t.route][t.operatorRef]++; }
  return Object.fromEntries(Object.entries(opOf).map(([r, ops]) => [r, Object.entries(ops).sort((a, b) => b[1] - a[1])[0][0]]));
}
