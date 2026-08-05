/**
 * build/status.js — live network status snapshot (feeds the hub + Atlas fallback).
 *
 * Normalises TfL's all-bus Line Status into the same shape the tools already
 * render: [{ route, status, reason, severity }], worst-first. Tools call live
 * TfL for the freshest status; this stored snapshot is their cached/offline
 * fallback tier, and the source for any future history/analytics.
 */

import * as tfl from "../sources/tfl.js";
import { rowsWithin, everyHas, check } from "../lib/validate.js";
import { windowActiveNow } from "../lib/tfl-status.js";

export async function build(ctx) {
  const { sink, log, cmpRoute } = ctx;
  const res = await tfl.busStatus();
  const raw = res.data || [];
  const rows = raw
    // TfL's bus Line Status feed includes non-public placeholder lines (e.g. "ZZ1"
    // test/rail-replacement designations) that aren't passenger bus routes — drop
    // them so the network status count reconciles with the 676-route catalogue.
    .filter((l) => !/^ZZ\d*$/i.test(String(l.name || l.id || "")))
    .map((l) => {
      const all = (l.lineStatuses) || [];
      // Show the status active NOW. TfL flags planned works (e.g. a future diversion) as
      // severity-0 "Special Service" with future validityPeriods — those aren't a current
      // problem. But isNow alone can't be trusted: in-progress diversions are routinely
      // published with isNow=false (verified: W12/Selborne Rd), so lib/tfl-status.js also
      // checks the window's own dates against now.
      let cur = null;
      for (const st of all) {
        if (st.statusSeverity === 10) continue;
        if (windowActiveNow(st.validityPeriods)) { cur = st; break; }
      }
      const s = cur || { statusSeverityDescription: "Good Service", statusSeverity: 10, reason: "" };
      return {
        route: l.name || l.id,
        status: s.statusSeverityDescription || "Good Service",
        reason: s.reason || "",
        severity: typeof s.statusSeverity === "number" ? s.statusSeverity : 10,
      };
    })
    .sort((a, b) => a.severity - b.severity || cmpRoute(a.route, b.route));

  rowsWithin(rows, 400, 2000, "status");
  everyHas(rows, ["route", "status", "severity"], "status");

  const good = rows.filter((r) => r.severity >= 10).length;
  // DEGRADED-FEED GATE (same failure mode build/diversions.js guards): the bulk status
  // feed intermittently returns all-Good-Service while per-line endpoints still report
  // disruptions. Months-long planned diversions are always active, so a zero-disrupted
  // snapshot after a run that saw many is a broken feed — keep the last-good snapshot.
  const prevSnap = await sink.readDataset("line-status");
  const prevDisrupted = prevSnap?.summary?.disrupted ?? 0;
  check(!(rows.length - good === 0 && prevDisrupted >= 10),
    `line-status: feed reports 0 disrupted but last snapshot had ${prevDisrupted} — degraded snapshot, keeping last-good`);
  await sink.writeDataset("line-status", {
    capturedAt: new Date().toISOString(),
    summary: { total: rows.length, good, disrupted: rows.length - good },
    rows,
  });

  log.info(`line-status: ${rows.length} routes · ${good} good service`);
  return { source: "TfL Unified API · /Line/Mode/bus/Status", rows: rows.length, files: ["data/line-status.json"] };
}
