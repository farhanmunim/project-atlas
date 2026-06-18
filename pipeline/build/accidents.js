/**
 * build/accidents.js — Sentinel: bus/coach-involved road collisions in Greater London.
 *
 * Source: DfT STATS19 open road-safety data (collision + vehicle tables joined on
 * collision_index, filtered to bus/coach vehicle types and the M25 bbox). See
 * sources/stats19.js. Cadence: annual (DfT publishes ~2 years in arrears).
 *
 * Produces data/accidents.json (see shape below). Live path streams the most recent
 * STATS19 years; if every year is unreachable / impractical in this environment we
 * fall back to a clearly-labelled synthetic sample (sample:true) so the Atlas map
 * never looks broken — the UI labels it honestly. Last-good is kept on a degraded
 * pull (the rowsWithin gate + the orchestrator's soft-fail).
 *
 * Output shape:
 *   { generatedAt, source, sample, period, count, bbox:[minLng,minLat,maxLng,maxLat],
 *     accidents:[ { id, lat, lng, severity, date, borough, vehicles } ] }
 */

import { fetchStats19, LONDON_BBOX } from "../sources/stats19.js";
import { rowsWithin } from "../lib/validate.js";

const SOURCE = "DfT STATS19 road safety data (bus/coach-involved, Greater London)";
const SAMPLE_SOURCE = "sample — synthetic (STATS19 ingest pending)";

// Newest STATS19 typically lands ~2 years after the year-end. Pull the recent window.
const YEARS = [2023, 2022, 2021];
const MAX_KEEP = 5000;       // cap to the most recent N for a sane map payload
const LIVE_FLOOR = 200;      // a live pull below this is treated as degraded → keep last-good

export async function build(ctx) {
  const { sink, log, args } = ctx;
  const prev = (await sink.readDataset("accidents")) || null;

  // ── 1. LIVE: stream STATS19, join bus/coach, filter to London ──────────────
  let live = null;
  if (!(args && args.sample)) { // --sample forces the synthetic path (dev/offline)
    try {
      const r = await fetchStats19({ years: YEARS, bbox: LONDON_BBOX, log });
      if (r.accidents.length >= LIVE_FLOOR) {
        live = r;
        log.info(`accidents: live STATS19 → ${r.accidents.length} rows across ${r.years.join(", ") || "no years"}`);
      } else {
        log.warn(`accidents: live pull thin (${r.accidents.length} < ${LIVE_FLOOR}) — falling back to sample`);
      }
    } catch (e) {
      log.warn(`accidents: live STATS19 failed (${e.message}) — falling back to sample`);
    }
  }

  let data;
  if (live) {
    // Newest first, cap, then derive period/bbox from what we actually kept.
    const sorted = live.accidents
      .filter((a) => a.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_KEEP);
    const accidents = sorted.length ? sorted : live.accidents.slice(0, MAX_KEEP);
    data = finalise(accidents, { source: live.source, sample: false });
  } else if (prev && Array.isArray(prev.accidents) && prev.accidents.length >= LIVE_FLOOR && !prev.sample) {
    // Degraded live pull but we have a good prior live file — keep it (don't downgrade to sample).
    log.info("accidents: keeping last-good live data");
    data = { ...prev, generatedAt: new Date().toISOString() };
  } else {
    // ── 2. FALLBACK: realistic synthetic sample ──────────────────────────────
    const accidents = synthSample();
    data = finalise(accidents, { source: SAMPLE_SOURCE, sample: true });
    log.info(`accidents: wrote synthetic sample (${accidents.length} rows)`);
  }

  // Gate: sample floors low (1), live floors high. A cratered pull throws → last-good kept.
  rowsWithin(data.accidents, data.sample ? 1 : LIVE_FLOOR, MAX_KEEP, "accidents");

  await sink.writeDataset("accidents", data, { pretty: false });

  const breakdown = countSeverity(data.accidents);
  const note = `${data.count} collisions · ${data.sample ? "SAMPLE" : "live"} · ${data.period} · fatal=${breakdown.fatal} serious=${breakdown.serious} slight=${breakdown.slight}`;
  log.info(`accidents: ${note}`);
  return { source: data.source, rows: data.count, files: ["data/accidents.json"], note };
}

/* ── shape the final payload (period + bbox derived from the rows) ── */
function finalise(accidents, { source, sample }) {
  const dates = accidents.map((a) => a.date).filter(Boolean).sort();
  const minY = dates.length ? dates[0].slice(0, 4) : null;
  const maxY = dates.length ? dates[dates.length - 1].slice(0, 4) : null;
  const period = minY && maxY ? (minY === maxY ? minY : `${minY}–${maxY}`) : "n/a";

  // bbox over the kept points (fall back to the London bbox if empty).
  let bbox = [...LONDON_BBOX];
  if (accidents.length) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const a of accidents) {
      if (a.lng < minLng) minLng = a.lng; if (a.lng > maxLng) maxLng = a.lng;
      if (a.lat < minLat) minLat = a.lat; if (a.lat > maxLat) maxLat = a.lat;
    }
    bbox = [r6(minLng), r6(minLat), r6(maxLng), r6(maxLat)];
  }

  return {
    generatedAt: new Date().toISOString(),
    source,
    sample,
    period,
    count: accidents.length,
    bbox,
    accidents,
  };
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;

function countSeverity(arr) {
  const c = { fatal: 0, serious: 0, slight: 0 };
  for (const a of arr) if (c[a.severity] != null) c[a.severity]++;
  return c;
}

/* ── synthetic sample ──────────────────────────────────────────────────────
 * ~400 points across Greater London, weighted toward central/arterial corridors,
 * a plausible severity mix (~3% fatal / ~22% serious / ~75% slight) and dates
 * spread across the last ~3 years. Deterministic (seeded) so re-runs are stable. */
function synthSample() {
  const N = 400;
  // London Boroughs (ONS codes) for plausible borough labels, weighted central.
  const BOROUGHS = [
    "E09000001", "E09000007", "E09000019", "E09000022", "E09000030", "E09000013",
    "E09000020", "E09000028", "E09000032", "E09000033", "E09000005", "E09000025",
    "E09000023", "E09000003", "E09000009", "E09000027",
  ];
  // Arterial corridor anchors (lng, lat) — central + radial roads.
  const ANCHORS = [
    [-0.1276, 51.5074], [-0.1419, 51.5014], [-0.0877, 51.5128], // central/City
    [-0.1870, 51.5160], [-0.1057, 51.5440], [-0.0204, 51.5390], // W / N / E
    [-0.1230, 51.4650], [-0.0780, 51.4490], [-0.1880, 51.4880], // S / SE / SW
    [-0.2750, 51.5100], [0.0830, 51.5400], [-0.1090, 51.5800],  // outer radials
  ];

  let seed = 19_1979; // STATS19, nod to the archive start year
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2; // ~N(0, ~0.29)

  const [minLng, minLat, maxLng, maxLat] = LONDON_BBOX;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const out = [];
  const now = new Date("2026-06-18T00:00:00Z").getTime();
  const threeYears = 3 * 365 * 86_400_000;

  for (let i = 0; i < N; i++) {
    const [aLng, aLat] = ANCHORS[Math.floor(rnd() * ANCHORS.length)];
    const lng = clamp(aLng + gauss() * 0.09, minLng, maxLng);
    const lat = clamp(aLat + gauss() * 0.06, minLat, maxLat);

    const s = rnd();
    const severity = s < 0.03 ? "fatal" : s < 0.25 ? "serious" : "slight";

    const d = new Date(now - rnd() * threeYears);
    const date = d.toISOString().slice(0, 10);

    const vr = rnd();
    const vehicles = vr < 0.7 ? 2 : vr < 0.92 ? 1 : vr < 0.98 ? 3 : 4;

    out.push({
      id: `SAMPLE-${String(i + 1).padStart(4, "0")}`,
      lat: r6(lat),
      lng: r6(lng),
      severity,
      date,
      borough: BOROUGHS[Math.floor(rnd() * BOROUGHS.length)],
      vehicles,
    });
  }
  return out;
}
