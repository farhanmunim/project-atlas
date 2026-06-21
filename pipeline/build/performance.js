/**
 * build/performance.js — route reliability (QSI headline + per-route MPS).
 *
 * Source: TfL Bus Performance (QSI) quarter PDF + per-route MPS PDFs.
 *   http://bus.data.tfl.gov.uk/boroughreports/current-quarter.pdf
 *   http://bus.data.tfl.gov.uk/boroughreports/routes/performance-route-{ID}.pdf
 * Cadence: ~4-weekly (TfL's 13-period year). The only public per-route bus
 * reliability dataset — no JSON feed exists, so we parse the PDFs (see lib/pdf.js).
 *
 * Produces data/route-performance.json keyed by uppercased route id:
 *   { serviceClass, ewtMinutes, swtMinutes, awtMinutes, onTimePercent,
 *     mileagePercent, ewtMps, otpMps, mileageMps }
 *
 * The QSI PDF gives the headline EWT/SWT/AWT/OTP; the MPS PDFs give the contract
 * thresholds (ewtMps/otpMps/mileageMps) and the latest actual mileage-operated %.
 *
 * Degradation: both feeds soft-fail independently. If the QSI PDF is unchanged
 * (HEAD Last-Modified match) or unreachable, we keep last-good. The MPS pull is a
 * sticky per-run-capped cache (sidecar route-mps-cache.json) so a cold start can
 * span runs without re-pulling warm routes; a degraded pull keeps prior MPS values.
 * The merged result is gated by rowsWithin so a cratered pull never lands.
 */

import { fetchQsiPerformance, fetchRouteMps } from "../sources/tfl-performance.js";
import { rowsWithin } from "../lib/validate.js";

const SOURCE = "TfL Bus Performance (QSI) + per-route MPS PDFs";
const MPS_CACHE = "route-mps-cache"; // sidecar dataset (the MPS sticky cache)
const MPS_TTL_MS = 28 * 86_400_000;  // re-check each TfL period (~4 weeks)

/** AWT ≡ SWT + EWT. Use the parsed AWT when it agrees with the identity (rounding
 *  aside); otherwise the cell mis-aligned — recompute it so AWT is never < SWT. */
function reconcileAwt(awt, swt, ewt) {
  if (swt == null || ewt == null) return awt ?? null;
  const derived = Math.round((swt + ewt) * 10) / 10;
  if (awt == null || Math.abs(awt - derived) > 0.2) return derived;
  return awt;
}

export async function build(ctx) {
  const { sink, log, args } = ctx;

  // Last-good outputs — used to keep values on a degraded pull.
  const prevPerf = (await sink.readDataset("route-performance")) || { routes: {} };
  const prevMpsCache = (await sink.readDataset(MPS_CACHE)) || { routes: {} };

  // ── 1. QSI quarter PDF (headline reliability) ──────────────────────────────
  let qsi = null;
  try {
    qsi = await fetchQsiPerformance({ prevModifiedAt: prevPerf.pdfModifiedAt });
    if (qsi.notModified) { log.info("performance: QSI PDF unchanged (Last-Modified) — keeping last-good headline"); qsi = null; }
    else log.info(`performance: QSI parsed ${Object.keys(qsi.routes || {}).length} routes (${qsi.periodLabel ?? "period?"})`);
  } catch (e) {
    log.warn(`performance: QSI PDF failed (${e.message}) — keeping last-good headline`);
  }

  // MPS iteration universe = the Atlas route list ∪ every route the QSI PDF lists
  // ∪ last-good route ids. routes.json doesn't carry every night/school route, but
  // the QSI table does, and those routes also publish MPS PDFs — so seed from all
  // three so MPS coverage matches the headline coverage.
  const routesList = (await sink.readDataset("routes")) || [];
  const routeIds = [...new Set([
    ...(Array.isArray(routesList) ? routesList : routesList.routes || [])
        .map((r) => String(r.id ?? r.name ?? r).toUpperCase()),
    ...Object.keys(qsi?.routes || prevPerf.routes || {}).map((s) => s.toUpperCase()),
  ].filter(Boolean))];

  // ── 2. Per-route MPS PDFs (contract thresholds + actual mileage) ───────────
  let mpsRoutes = prevMpsCache.routes || {};
  let mpsStats = { fetched: 0, errored: 0, skipped: 0 };
  // Dev convenience: --limit caps the MPS per-run fetch cap.
  const cap = args && args.limit ? parseInt(args.limit, 10) : 1000;
  try {
    const r = await fetchRouteMps(routeIds, {
      prevCache: prevMpsCache.routes || {},
      ttlMs: MPS_TTL_MS,
      maxPerRun: Number.isFinite(cap) ? cap : 1000,
      log,
    });
    mpsRoutes = r.routes;
    mpsStats = { fetched: r.fetched, errored: r.errored, skipped: r.skipped };
    log.info(`performance: MPS ok=${r.fetched} skip=${r.skipped} err=${r.errored} · cached=${Object.keys(mpsRoutes).length}`);
  } catch (e) {
    log.warn(`performance: MPS pull failed (${e.message}) — keeping last-good MPS cache`);
  }

  // Persist the MPS sticky cache sidecar so the warm-up survives across runs.
  await sink.writeDataset(MPS_CACHE, {
    generatedAt: new Date().toISOString(),
    mpsTtlDays: MPS_TTL_MS / 86_400_000,
    totalRoutes: Object.keys(mpsRoutes).length,
    routes: mpsRoutes,
  });

  // ── 3. Merge into the frontend shape ───────────────────────────────────────
  // Normalise the QSI headline into the camelCase output shape. When QSI
  // short-circuited (notModified) or failed, qsi is null and we reuse last-good —
  // which is ALREADY camelCase, so it passes through untouched (don't re-map it
  // through snake_case keys or every headline field would silently null out).
  let headline; // id → { serviceClass, ewtMinutes, swtMinutes, awtMinutes, onTimePercent }
  if (qsi?.routes) {
    headline = {};
    for (const [id, q] of Object.entries(qsi.routes)) {
      headline[id] = {
        serviceClass: q.service_class ?? null,
        ewtMinutes: q.ewt_minutes ?? null,
        swtMinutes: q.swt_minutes ?? null,
        awtMinutes: q.awt_minutes ?? null,
        onTimePercent: q.on_time_percent ?? null,
      };
    }
  } else {
    headline = prevPerf.routes || {};
  }

  const allIds = new Set([...Object.keys(headline), ...Object.keys(mpsRoutes)]);
  const routes = {};
  for (const id of allIds) {
    const h = headline[id] || {};
    const m = mpsRoutes[id] || {};
    const mpsOk = m.status === 200;
    routes[id] = {
      serviceClass: h.serviceClass ?? (mpsOk ? m.service_class : null) ?? null,
      ewtMinutes: h.ewtMinutes ?? null,
      swtMinutes: h.swtMinutes ?? null,
      // AWT ≡ SWT + EWT by definition. The QSI PDF's AWT column occasionally mis-aligns
      // (a handful of rows land an impossible AWT < SWT). Trust the identity over the
      // raw cell when they disagree beyond rounding — keep the published value otherwise.
      awtMinutes: reconcileAwt(h.awtMinutes, h.swtMinutes, h.ewtMinutes),
      onTimePercent: h.onTimePercent ?? null,
      mileagePercent: mpsOk ? (m.mileage_operated_latest_percent ?? null) : null,
      ewtMps: mpsOk ? (m.ewt_mps_minutes ?? null) : null,
      otpMps: mpsOk ? (m.otp_mps_percent ?? null) : null,
      mileageMps: mpsOk ? (m.mileage_mps_percent ?? null) : null,
    };
  }

  // Gate: a degraded pull must not land. rowsWithin throws → orchestrator keeps last-good.
  rowsWithin(Object.keys(routes), 400, 2000, "route-performance routes");

  const data = {
    generatedAt: new Date().toISOString(),
    periodLabel: qsi?.periodLabel ?? prevPerf.periodLabel ?? null,
    source: SOURCE,
    routes,
  };
  // Carry the QSI Last-Modified forward so the next run's HEAD short-circuit works.
  if (qsi?.pdfModifiedAt) data.pdfModifiedAt = qsi.pdfModifiedAt;
  else if (prevPerf.pdfModifiedAt) data.pdfModifiedAt = prevPerf.pdfModifiedAt;

  await sink.writeDataset("route-performance", data, { pretty: false });

  const note = `${Object.keys(routes).length} routes · QSI ${qsi ? "refreshed" : "cached"} · MPS ok=${mpsStats.fetched} skip=${mpsStats.skipped} err=${mpsStats.errored}`;
  log.info(`performance: wrote ${Object.keys(routes).length} routes`);
  return { source: SOURCE, rows: Object.keys(routes).length, files: ["data/route-performance.json"], note };
}
