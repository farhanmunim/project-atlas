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
import * as ibus from "../sources/ibus.js";
import { mapLimit } from "../lib/http.js";
import { round, lengthKm } from "../lib/geo.js";
import { check } from "../lib/validate.js";
import { windowActiveNow, windowBounds, windowStartsWithin, routesNamedIn } from "../lib/tfl-status.js";
import { parseLineStrings, extractStops } from "./routes.js";

// Text signal that a status is a service alteration (vs plain delays).
const DIVERTY = /divert|diversion|miss(?:es|ing)?[^.]{0,60}stop|not\s+(?:be\s+)?serv|will\s+not\s+stop|closed|closure/i;

const DEVIATION_M = 75;    // > simplification noise (measured ≤53 m), < any real diversion (≥150 m)
const MIN_SEP_M = 150;     // leave→rejoin separation: a real diversion bypasses ≥150 m of roadway
const MIN_LOOP_M = 400;    // …or is a loop that rejoins near where it left but covers real distance
const MAX_SEGMENTS = 12;   // cap per direction — beyond this something is wrong upstream

const R_EARTH = 6371000, RAD = Math.PI / 180;
/** Metres from [lng,lat] point p to the nearest point on polyline (equirectangular — fine at city scale). */
export function distToLineM(p, line) {
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
export function deviatingSegments(line, ref) {
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
    if (seg.length < 2) continue;
    // Noise filter on the segment's SHAPE, not just its path length: a single-vertex
    // spike's legs alone can exceed any length threshold (2 × offset), so require the
    // leave→rejoin endpoints to be genuinely apart (real roadway bypassed) — or, for a
    // loop diversion that rejoins near where it left, a substantial travelled distance.
    const A = seg[0], B = seg[seg.length - 1], cosA = Math.cos(A[1] * RAD);
    const sepM = Math.hypot((B[0] - A[0]) * cosA * RAD * R_EARTH, (B[1] - A[1]) * RAD * R_EARTH);
    if (sepM >= MIN_SEP_M || lengthKm(seg) * 1000 >= MIN_LOOP_M) segs.push(seg);
  }
  return segs.slice(0, MAX_SEGMENTS);
}

const stopLite = (s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng });
const minIso = (list) => list.filter(Boolean).sort()[0] || null;
const maxIso = (list) => list.filter(Boolean).sort().slice(-1)[0] || null;

// ── iBus recovery baselines ──────────────────────────────────────────────────
// When a flagged route shows missed stops but NO geometry diff, its stored baseline
// was already polluted (TfL redraws Route/Sequence ~10 days ahead of a planned
// closure). The iBus static drops are dated, immutable schedule releases with full
// route geometry — walk them newest→oldest and use the first version whose line
// passes ALL the missed stops (a served stop sits on the true pre-diversion line),
// then diff the current ring against THAT. Self-validating, independent of our
// store. Lazy + cached per run: zero downloads unless a recovery is needed.
const IBUS_MAX_VERSIONS = 6;    // ~3 months of fortnightly drops
const IBUS_STOP_TOL_M = 60;
let _ibusVersions = null;       // promise — single-flight per run
const _ibusGeo = new Map();     // version → promise of whole-network geometry
const ibusVersions = () => (_ibusVersions ||= ibus.listVersions().catch(() => []));
const ibusGeo = (v) => { if (!_ibusGeo.has(v)) _ibusGeo.set(v, ibus.fetchRouteGeometry(v).catch(() => ({}))); return _ibusGeo.get(v); };
async function ibusRecoverBaseline(routeName, dirCode, missedStops) {
  if (!missedStops.length) return null;
  for (const v of (await ibusVersions()).slice(0, IBUS_MAX_VERSIONS)) {
    const line = (await ibusGeo(v))[routeName]?.[dirCode];
    if (!line) continue;
    if (missedStops.every((s) => distToLineM([s.lng, s.lat], line) <= IBUS_STOP_TOL_M))
      return { line, version: v };
  }
  return null;
}

export async function build(ctx) {
  const { sink, log } = ctx;
  const now = Date.now();

  const FREEZE_LOOKAHEAD_DAYS = 14;
  const buildCandidates = (raw) => {
    const lines = (raw || []).filter((l) => !/^ZZ\d*$/i.test(String(l.name || l.id || "")));
    check(lines.length >= 400, `diversions: status feed returned only ${lines.length} lines`);
    const candidates = [];
    const upcomingFreeze = new Set();   // not active yet, but the window opens soon — TfL redraws
                                        // Route/Sequence in ADVANCE, so freeze these baselines NOW
    let misattributed = 0;
    // TfL occasionally attaches a status to the WRONG line (verified: a route-379
    // diversion on line 376's status while 379 read Good Service). When the reason
    // text explicitly names routes and this line is not among them, that record is
    // not this route's diversion — drop it (precision over recall; genuinely
    // affected lines carry text naming them).
    const forThisLine = (l) => (st) => {
      const named = routesNamedIn(st.reason);
      const mine = !named.length || named.includes(String(l.name).toUpperCase());
      if (!mine) misattributed++;
      return mine;
    };
    for (const l of lines) {
      const sts = l.lineStatuses || [];
      const active = sts.filter((st) => st.statusSeverity !== 10 && windowActiveNow(st.validityPeriods, now)).filter(forThisLine(l));
      if (active.length) { candidates.push({ id: l.id, name: l.name, statuses: active }); continue; }
      if (sts.some((st) => st.statusSeverity !== 10 && windowStartsWithin(st.validityPeriods, FREEZE_LOOKAHEAD_DAYS, now)
          && DIVERTY.test(st.reason || "") && forThisLine(l)(st))) upcomingFreeze.add(l.id);
    }
    return { candidates, upcomingFreeze, misattributed };
  };

  const prev = (await sink.readDataset("route-diversions")) || { routes: {} };
  const prevCount = Object.keys(prev.routes || {}).length;

  let { candidates, upcomingFreeze, misattributed } = buildCandidates((await tfl.busStatus()).data);
  // DEGRADED-FEED GATE: the bulk /Line/Mode/bus/Status intermittently returns an
  // all-Good-Service snapshot while the per-line endpoints still report the real
  // disruptions (observed live 2026-08-05). Dozens of months-long planned diversions
  // are always active, so "zero disruptions" when the last run saw many is a broken
  // snapshot, not a quiet day — retry once, then keep last-good rather than emptying
  // the dataset (and with it the baseline-freeze set).
  if (!candidates.length && prevCount >= 20) {
    await new Promise((r) => setTimeout(r, 5000));
    ({ candidates, upcomingFreeze, misattributed } = buildCandidates((await tfl.busStatus()).data));
    check(candidates.length > 0,
      `diversions: status feed reports 0 active disruptions but last run had ${prevCount} — degraded snapshot, keeping last-good`);
  }
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
      const missedStops = {}, addedStops = {}, divSegs = {}, bypSegs = {}, rings = {};
      let anyDiff = false, baselineSource = "store";
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
        if (curRing.length >= 2) rings[dir] = { code, curRing };
        const baseline = baseGeo[c.id]?.[code] || [];
        if (curRing.length >= 2 && baseline.length >= 2) {
          const dv = deviatingSegments(curRing, baseline);
          if (dv.length) { divSegs[dir] = dv; anyDiff = true; }
          const by = deviatingSegments(baseline, curRing);
          if (by.length) bypSegs[dir] = by;
        }
      }
      // polluted-baseline recovery: missed stops fired but the geometry diff didn't —
      // the stored baseline already absorbed TfL's advance redraw. Recover the true
      // pre-diversion line from the dated iBus drops and diff against that instead.
      if (Object.keys(missedStops).length && !Object.keys(divSegs).length) {
        for (const [dir, { code, curRing }] of Object.entries(rings)) {
          const rec = await ibusRecoverBaseline(c.name, code, missedStops[dir] || []);
          if (!rec) continue;
          const dv = deviatingSegments(curRing, rec.line);
          if (dv.length) { divSegs[dir] = dv; anyDiff = true; baselineSource = `ibus:${rec.version}`; }
          const by = deviatingSegments(rec.line, curRing);
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
        baselineSource,
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
    upcomingFreeze: [...upcomingFreeze].sort(),   // ids frozen ahead of their window opening
    routes: entries,
  });

  // Hand the freeze set to build/routes.js (runs next): active episodes PLUS routes whose
  // diversion window opens within the lookahead — their advance redraw must not overwrite
  // the canonical baseline before the episode is ever flagged active.
  ctx.divertedRoutes = new Set([...Object.values(entries).map((e) => e.id), ...upcomingFreeze]);

  log.info(`diversions: ${names.length} active (${published} with published geometry, ${names.length - published} unpublished)` +
    ` · ${upcomingFreeze.size} upcoming frozen ahead` +
    (misattributed ? ` · ${misattributed} misattributed statuses dropped (named other routes)` : "") +
    (seqFail ? ` · ${seqFail} sequence fetches failed` : "") + (kept ? ` · ${kept} kept from last-good` : ""));
  return {
    source: "TfL Unified API · /Line/Mode/bus/Status + /Route/Sequence diff vs baseline",
    rows: names.length,
    files: ["data/route-diversions.json"],
    note: `${published} published geometry · ${names.length - published} unpublished`,
  };
}
