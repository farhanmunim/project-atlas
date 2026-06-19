/**
 * build/bridges.js — Atlas low-bridge / height-restriction layer.
 *
 * Source: TfL "Bridges, Tunnels, Road Barriers & Height Restrictions (EPOWR)" via the
 * London Datastore (see sources/london-bridges.js). ~877 structures across Greater
 * London / M25, each with a banded clearance normalised to metres. Powers double-decker
 * route validation + bridge-strike avoidance. Cadence: ANNUAL.
 *
 * Live path discovers the resource URL, parses the workbook and filters to the M25 bbox;
 * if the source is unreachable we keep last-good, else fall back to a clearly-labelled
 * synthetic sample (sample:true) of ~30 plausible low-bridge points so the Atlas map
 * never looks broken — the UI labels it honestly.
 *
 * Output shape (data/bridges.json):
 *   { generatedAt, source, sample, count, bbox:[minLng,minLat,maxLng,maxLat],
 *     bridges:[ { id, lat, lng, height_m, height_imperial, name, road, structure_type, borough } ] }
 */

import { fetchLondonBridges, LONDON_BBOX } from "../sources/london-bridges.js";
import { rowsWithin } from "../lib/validate.js";

const SAMPLE_SOURCE = "sample — synthetic (EPOWR ingest pending)";

const MAX_KEEP = 5000;     // upper sanity bound (dataset is ~877)
const LIVE_FLOOR = 50;     // a live pull below this is treated as degraded → keep last-good

export async function build(ctx) {
  const { sink, log, args } = ctx;
  const prev = (await sink.readDataset("bridges")) || null;

  // ── 1. LIVE: discover + parse the EPOWR workbook, filtered to the M25 ───────
  let live = null;
  if (!(args && args.sample)) { // --sample forces the synthetic path (dev/offline)
    try {
      const r = await fetchLondonBridges({ bbox: LONDON_BBOX, log });
      if (r.bridges.length >= LIVE_FLOOR) {
        live = r;
        log.info(`bridges: live EPOWR → ${r.bridges.length} structures (${r.resourceUrl})`);
      } else {
        log.warn(`bridges: live pull thin (${r.bridges.length} < ${LIVE_FLOOR}) — falling back to sample`);
      }
    } catch (e) {
      log.warn(`bridges: live EPOWR failed (${e.message}) — falling back to sample`);
    }
  }

  let data;
  if (live) {
    data = finalise(live.bridges.slice(0, MAX_KEEP), { source: live.source, sample: false });
  } else if (prev && Array.isArray(prev.bridges) && prev.bridges.length >= LIVE_FLOOR && !prev.sample) {
    // Degraded live pull but we have a good prior live file — keep it (don't downgrade to sample).
    log.info("bridges: keeping last-good live data");
    data = { ...prev, generatedAt: new Date().toISOString() };
  } else {
    // ── 2. FALLBACK: realistic synthetic sample ──────────────────────────────
    const bridges = synthSample();
    data = finalise(bridges, { source: SAMPLE_SOURCE, sample: true });
    log.info(`bridges: wrote synthetic sample (${bridges.length} rows)`);
  }

  // Gate: sample floors low (1), live floors high. A cratered pull throws → last-good kept.
  rowsWithin(data.bridges, data.sample ? 1 : LIVE_FLOOR, MAX_KEEP, "bridges");

  await sink.writeDataset("bridges", data, { pretty: false });

  const subDeck = data.bridges.filter((b) => typeof b.height_m === "number" && b.height_m < 4.4).length;
  const note = `${data.count} structures · ${data.sample ? "SAMPLE" : "live"} · sub-double-deck(<4.4m)=${subDeck}`;
  log.info(`bridges: ${note}`);
  return { source: data.source, rows: data.count, files: ["data/bridges.json"], note };
}

/* ── shape the final payload (bbox derived from the rows) ── */
function finalise(bridges, { source, sample }) {
  let bbox = [...LONDON_BBOX];
  if (bridges.length) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const b of bridges) {
      if (b.lng < minLng) minLng = b.lng; if (b.lng > maxLng) maxLng = b.lng;
      if (b.lat < minLat) minLat = b.lat; if (b.lat > maxLat) maxLat = b.lat;
    }
    bbox = [r6(minLng), r6(minLat), r6(maxLng), r6(maxLat)];
  }
  return {
    generatedAt: new Date().toISOString(),
    source,
    sample,
    count: bridges.length,
    bbox,
    bridges,
  };
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;

/* ── synthetic sample ──────────────────────────────────────────────────────
 * ~30 plausible low-bridge points spread across London, with banded clearances
 * 3.0–5.0 m (and matching imperial). Deterministic (seeded) so re-runs are stable.
 * Heights skew low so the sub-double-deck (<4.4 m) count is realistic for a
 * design-phase map. Clearly labelled sample:true by the caller. */
function synthSample() {
  const ANCHORS = [
    ["Battersea High Street", "A3205", "Wandsworth", -0.1700, 51.4720],
    ["Lewisham High Street", "A21", "Lewisham", -0.0130, 51.4570],
    ["Prince Of Wales Road", null, "Camden", -0.1450, 51.5460],
    ["Westminster Bridge Road", "A23", "Lambeth", -0.1140, 51.4990],
    ["Coventry Road", "B120", "Tower Hamlets", -0.0560, 51.5240],
    ["Golders Green Road", "A502", "Barnet", -0.1980, 51.5720],
    ["Green Street", null, "Enfield", -0.0640, 51.6500],
    ["West End Road", "A4180", "Hillingdon", -0.4080, 51.5500],
    ["Churchfield Road", null, "Ealing", -0.3050, 51.5130],
    ["Thames Road", "A206", "Bexley", 0.1300, 51.4900],
    ["Marsh Road", null, "Harrow", -0.3360, 51.5800],
    ["Falcon Road", null, "Wandsworth", -0.1690, 51.4660],
    ["Great Suffolk Street", null, "Southwark", -0.0980, 51.4990],
    ["Ferry Lane", null, "Havering", 0.1820, 51.5570],
    ["Andrews Road", null, "Hackney", -0.0570, 51.5360],
    ["Chequers Lane", null, "Barking & Dagenham", 0.1470, 51.5280],
    ["Station Road", "A4090", "Harrow", -0.3370, 51.5870],
    ["Lewisham Road", "A2211", "Lewisham", -0.0150, 51.4700],
    ["Globe Road", null, "Tower Hamlets", -0.0560, 51.5240],
    ["Upper Wickham Lane", "A209", "Bexley", 0.1090, 51.4670],
    ["Vera Avenue", null, "Enfield", -0.0780, 51.6360],
    ["Townmead Road", null, "Hammersmith & Fulham", -0.1830, 51.4720],
    ["Shand Street", null, "Southwark", -0.0820, 51.5030],
    ["Church Road", null, "Bexley", 0.1500, 51.4830],
    ["Battersea Park Road", "A3205", "Wandsworth", -0.1480, 51.4760],
    ["The Broadway", "A5100", "Barnet", -0.2250, 51.6010],
    ["Green Park Way", null, "Ealing", -0.3320, 51.5530],
    ["Whites Grounds", null, "Southwark", -0.0790, 51.4980],
    ["Lynx Way", null, "Newham", 0.0220, 51.5070],
    ["Ordnance Road", null, "Enfield", -0.0290, 51.6580],
  ];
  // Metric band lower bounds and their imperial equivalents (mirrors the real bands).
  const BANDS = [
    [3.0, `Up to 9'10"`],
    [3.1, `Between 9'10" and 11'6"`],
    [3.6, `Between 11'9" and 13'0"`],
    [4.1, `Between 13'3" and 14'9"`],
    [4.6, `Between 15'0" and 16'6"`],
  ];

  let seed = 877_2019; // EPOWR feature count, year of the dataset
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const out = [];
  for (let i = 0; i < ANCHORS.length; i++) {
    const [road, roadNo, borough, lng, lat] = ANCHORS[i];
    // Weight toward the lower bands so the map has realistic sub-double-deck density.
    const bi = Math.min(BANDS.length - 1, Math.floor(rnd() * rnd() * BANDS.length * 1.3));
    const [height_m, height_imperial] = BANDS[bi];
    out.push({
      id: `SAMPLE-${String(i + 1).padStart(3, "0")}`,
      lat: r6(lat),
      lng: r6(lng),
      height_m,
      height_imperial,
      name: roadNo ? `${road} (${roadNo})` : road,
      road,
      structure_type: "bridge",
      borough,
    });
  }
  return out;
}
