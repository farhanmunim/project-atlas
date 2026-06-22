/**
 * build/status.js — live network status snapshot (feeds the hub + Atlas fallback).
 *
 * Normalises TfL's all-bus Line Status into the same shape the tools already
 * render: [{ route, status, reason, severity }], worst-first. Tools call live
 * TfL for the freshest status; this stored snapshot is their cached/offline
 * fallback tier, and the source for any future history/analytics.
 */

import * as tfl from "../sources/tfl.js";
import { rowsWithin, everyHas } from "../lib/validate.js";

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
      // severity-0 "Special Service" with validityPeriods where isNow=false — those aren't a
      // current problem (it's why ~1/3 of routes wrongly read "Special Service"). Count a
      // disruption only if it has no validity window or one active now; else it's Good Service.
      let cur = null;
      for (const st of all) {
        if (st.statusSeverity === 10) continue;
        const vp = st.validityPeriods || [];
        if (!vp.length || vp.some((p) => p.isNow)) { cur = st; break; }
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
  await sink.writeDataset("line-status", {
    capturedAt: new Date().toISOString(),
    summary: { total: rows.length, good, disrupted: rows.length - good },
    rows,
  });

  log.info(`line-status: ${rows.length} routes · ${good} good service`);
  return { source: "TfL Unified API · /Line/Mode/bus/Status", rows: rows.length, files: ["data/line-status.json"] };
}
