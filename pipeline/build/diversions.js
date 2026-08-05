/**
 * build/diversions.js — live route-diversion episodes (detection + real geometry).
 *
 * TfL publishes NO structured diversion data: the live status feed carries only
 * free-text reasons (affectedRoutes/affectedStops are always empty). But for
 * planned diversions TfL *redraws* /Line/{id}/Route/Sequence — the stop list
 * drops the missed stops and the lineString follows the diversion roads (verified
 * empirically: W12/Selborne Road 2026-07). So the diverted truth is recoverable
 * by DIFFING the current sequence against our last-good canonical baseline:
 *
 *   1. Detect  — /Line/Mode/bus/Status: any non-Good status whose validity
 *                window is active now (lib/tfl-status.js — TfL's isNow flag is
 *                unreliable, date windows are checked directly).
 *   2. Diff    — per flagged route, fetch Route/Sequence both directions and
 *                compare against the store's route-stops + routes-overview
 *                baseline: missing/added stops by id, and geometry runs deviating
 *                >75 m from the baseline → the diversion path (dashed on the map)
 *                and the bypassed baseline segment.
 *   3. Freeze  — this builder runs BEFORE build/routes.js and exposes the flagged
 *                set on ctx.divertedRoutes; the routes builder retains last-good
 *                stops+geometry for those routes, so the canonical baseline is
 *                never silently overwritten by a temporary diversion. When the
 *                episode ends the route leaves the set and the next run writes
 *                the fresh TfL sequence again — fully self-healing.
 *
 * geometryStatus: "published"  — TfL has redrawn the line (segments present);
 *                 "unpublished" — flagged (usually short-notice/emergency) but
 *                 TfL still serves the original line; the app falls back to its
 *                 text-parsed corridor + live-GPS view.
 *
 * Per-route failures keep the previous episode entry (a flaky fetch must not
 * drop a live diversion); a status-feed failure throws → orchestrator keeps
 * last-good. Cadence: every run (live snapshot), ~2 calls per flagged route.
 */

import * as tfl from "../sources/tfl.js";
import { mapLimit } from "../lib/http.js";
import { round, lengthKm } from "../lib/geo.js";
import { check } from "../lib/validate.js";
import { windowActiveNow, windowBounds } from "../lib/tfl-status.js";
import { parseLineStrings, extractStops } from "./routes.js";

// Text signal that a status is a service alteration (vs plain delays).
const DIVERTY = /divert|diversion|miss(?:es|ing)?[^.]{0,60}stop|not\s+(?:be\s+)?serv|will\s+not\s+stop|closed|closure/i;

const DEVIATION_M = 75;    // > simplification noise (measured ≤53 m), < any real diversion (≥150 m)
const MIN_SPAN_M = 150;    // a genuine diversion leg; filters corner-cutting artefacts
const MAX_SEGMENTS = 12;   // cap per direction — beyond this something is wrong upstream

const R_EARTH = 6371000, RAD = Math.PI / 180;
/** Metres from [lng,lat] point p to the nearest point on polyline (equirectangular — fine at city scale). */
function distToLineM(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const A = line[i], B = line[i + 1];
    const cos = Math.cos(A[1] * RAD);
    const ax = (B[0] - A[0]) * cos * RAD * R_EARTH, ay = (B[1] - A[1]) * RAD * R_EARTH;
    const px = (p[0] - A[0]) * cos * RAD * R_EARTH, py = (p[1] - A[1]) * RAD * R_EARTH;
    const L2 = ax * ax + ay * ay;
    const t = L2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / L2)) : 0;
    const d = Math.hypot(px - t * ax, py - t * ay);
    if (d < best) best = d;
  }
  return best;
}

/** Contiguous runs of `line` further than DEVIATION_M from `ref`, as coordinate segments. */
function deviatingSegments(line, ref) {
  if (line.length < 2 || ref.length < 2) return [];
  const runs = [];
  let run = null;
  for (let i = 0; i < line.length; i++) {
    if (distToLineM(line[i], ref) > DEVIATION_M) { if (run) run[1] = i; else run = [i, i]; }
    else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  const segs = [];
  for (const [a, b] of runs) {
    // extend one point each side so the segment visually rejoins the served line
    const seg = line.slice(Math.max(0, a - 1), Math.min(line.length, b + 2))
      .map(([lng, lat]) => [round(lng, 5), round(lat, 5)]);
    if (seg.length >= 2 && lengthKm(seg) * 1000 >= MIN_SPAN_M) segs.push(seg);
  }
  return segs.slice(0, MAX_SEGMENTS);
}

const stopLite = (s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng });
const minIso = (list) => list.filter(Boolean).sort()[0] || null;
const maxIso = (list) => list.filter(Boolean).sort().slice(-1)[0] || null;

export async function build(ctx) {
  const { sink, log } = ctx;
  const now = Date.now();

  const res = await tfl.busStatus();
  const lines = (res.data || []).filter((l) => !/^ZZ\d*$/i.test(String(l.name || l.id || "")));
  check(lines.length >= 400, `diversions: status feed returned only ${lines.length} lines`);

  const candidates = [];
  for (const l of lines) {
    const active = (l.lineStatuses || []).filter((st) => st.statusSeverity !== 10 && windowActiveNow(st.validityPeriods, now));
    if (active.length) candidates.push({ id: l.id, name: l.name, statuses: active });
  }

  const prev = (await sink.readDataset("route-diversions")) || { routes: {} };
  const baseStops = (await sink.readDataset("route-stops")) || { routes: {} };
  const baseGeoRaw = await sink.readDataset("routes-overview", { ext: "geojson" });
  const baseGeo = {};   // routeId → { "1": coords, "2": coords }
  for (const f of baseGeoRaw?.features || []) {
    if (f?.geometry?.coordinates && f.properties) (baseGeo[f.properties.routeId] ||= {})[f.properties.direction] = f.geometry.coordinates;
  }

  const entries = {};
  let seqFail = 0, kept = 0;
  await mapLimit(candidates, 6, async (c) => {
    try {
      const missedStops = {}, addedStops = {}, divSegs = {}, bypSegs = {};
      let anyDiff = false;
      for (const [dir, code] of [["outbound", "1"], ["inbound", "2"]]) {
        let seq;
        try { seq = (await tfl.routeSequence(c.id, dir)).data; } catch { seqFail++; continue; }
        if (!seq) continue;
        const curStops = extractStops(seq);
        const bStops = baseStops.routes?.[c.id]?.[dir] || [];
        if (curStops.length && bStops.length) {
          const curIds = new Set(curStops.map((s) => s.id)), bIds = new Set(bStops.map((s) => s.id));
          const missed = bStops.filter((s) => !curIds.has(s.id)).map(stopLite);
          const added = curStops.filter((s) => !bIds.has(s.id)).map(stopLite);
          if (missed.length) { missedStops[dir] = missed; anyDiff = true; }
          if (added.length) { addedStops[dir] = added; anyDiff = true; }
        }
        const curRing = parseLineStrings(seq);
        const baseline = baseGeo[c.id]?.[code] || [];
        if (curRing.length >= 2 && baseline.length >= 2) {
          const dv = deviatingSegments(curRing, baseline);
          if (dv.length) { divSegs[dir] = dv; anyDiff = true; }
          const by = deviatingSegments(baseline, curRing);
          if (by.length) bypSegs[dir] = by;
        }
      }
      const textMatch = c.statuses.some((st) => DIVERTY.test(st.reason || ""));
      if (!textMatch && !anyDiff) return;   // active status, but nothing diversion-shaped (e.g. plain delays)

      const disruptions = c.statuses.map((st) => {
        const b = windowBounds(st.validityPeriods);
        return { reason: st.reason || "", category: st.statusSeverityDescription || "", since: b.from, until: b.to };
      });
      const worst = c.statuses.reduce((a, b) => (b.statusSeverity < a.statusSeverity ? b : a));
      entries[c.name] = {
        id: c.id,
        status: worst.statusSeverityDescription || "Special Service",
        severity: typeof worst.statusSeverity === "number" ? worst.statusSeverity : 0,
        disruptions,
        since: minIso(disruptions.map((d) => d.since)),
        until: maxIso(disruptions.map((d) => d.until)),
        detectedAt: prev.routes?.[c.name]?.detectedAt || new Date().toISOString(),
        geometryStatus: Object.keys(divSegs).length ? "published" : "unpublished",
        missedStops, addedStops,
        diversionSegments: divSegs, bypassedSegments: bypSegs,
      };
    } catch {
      // per-route soft-fail — keep the previous episode rather than dropping a live diversion
      if (prev.routes?.[c.name]) { entries[c.name] = prev.routes[c.name]; kept++; }
    }
  });

  // ── validate before it lands ──────────────────────────────────────────────
  const names = Object.keys(entries);
  check(names.length <= 400, `diversions: ${names.length} flagged routes — implausible, refusing to overwrite`);
  for (const n of names) {
    const e = entries[n];
    check(e.id && e.status && Array.isArray(e.disruptions), `diversions[${n}]: malformed entry`);
    for (const dirSegs of Object.values(e.diversionSegments || {})) for (const seg of dirSegs) for (const [lng, lat] of seg)
      check(lng > -1.2 && lng < 1.2 && lat > 50.8 && lat < 52.2, `diversions[${n}]: segment coord outside London (${lng},${lat})`);
  }

  const published = names.filter((n) => entries[n].geometryStatus === "published").length;
  await sink.writeDataset("route-diversions", {
    generatedAt: new Date().toISOString(),
    count: names.length,
    routes: entries,
  });

  // Hand the flagged set to build/routes.js (runs next) so it freezes the baseline.
  ctx.divertedRoutes = new Set(Object.values(entries).map((e) => e.id));

  log.info(`diversions: ${names.length} active (${published} with published geometry, ${names.length - published} unpublished)` +
    (seqFail ? ` · ${seqFail} sequence fetches failed` : "") + (kept ? ` · ${kept} kept from last-good` : ""));
  return {
    source: "TfL Unified API · /Line/Mode/bus/Status + /Route/Sequence diff vs baseline",
    rows: names.length,
    files: ["data/route-diversions.json"],
    note: `${published} published geometry · ${names.length - published} unpublished`,
  };
}
