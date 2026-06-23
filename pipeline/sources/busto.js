/**
 * sources/busto.js — TfL BUSTO bus crowding (load / capacity / V-over-C).
 *
 * Source: TfL "BUSTO" open data (crowding.data.tfl.gov.uk, an S3 bucket).
 *   bucket  https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk/
 *   file    BUSTO/<YYYY-YYYY>/<YR> MAX DEMAND HOUR BY ROUTE BY TIMEBAND All Routes.csv
 *
 * The file is the per-route / per-stop / per-timeband demand at each route's MAX DEMAND
 * HOUR — ~800k rows, ~98 MB. Columns:
 *   YEAR, DAY_TYPE, TIMEBAND, QHr, ROUTE, DIRECTION, STOPCODE, STOPNAME, STOPSEQUENCE,
 *   HourBoardings, HourAlightings, HourLoad, HourCapacity, HourSeats, V/C
 * where V/C = HourLoad / HourCapacity is the crowding ratio (≈1.0 = full).
 *
 * We STREAM the CSV (never buffer 98 MB) and aggregate to ONE record per route: the
 * single busiest point (max V/C across every stop / timeband / direction), plus the
 * per-day-type peak. Cadence: ANNUAL (per year folder). The parser is comma-tolerant in
 * STOPNAME by reading the fixed numeric tail from the right.
 */

import https from "node:https";
import readline from "node:readline";

const BUCKET = "https://s3-eu-west-1.amazonaws.com/crowding.data.tfl.gov.uk";
const STREAM_TIMEOUT_MS = 180_000;     // generous: ~98 MB over the wire
const EXPECTED_HEADER = "YEAR,DAY_TYPE,TIMEBAND,QHr,ROUTE,DIRECTION,STOPCODE,STOPNAME,STOPSEQUENCE,HourBoardings,HourAlightings,HourLoad,HourCapacity,HourSeats,V/C";

// crowding bands on peak V/C — thresholds shared with the apps (kept in data/crowding.json too).
export const CROWDING_BANDS = [
  { key: "comfortable", label: "Comfortable", max: 0.5 },
  { key: "moderate",    label: "Moderate",    max: 0.65 },
  { key: "busy",        label: "Busy",        max: 0.8 },
  { key: "crowded",     label: "Crowded",     max: Infinity },
];
export function bandOf(vc) {
  for (const b of CROWDING_BANDS) if (vc < b.max) return b.key;
  return "crowded";
}

function s3List(prefix) {
  const url = `${BUCKET}/?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`S3 list HTTP ${res.statusCode}`)); return; }
      let xml = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (xml += c));
      res.on("end", () => resolve(xml));
      res.on("error", reject);
    }).on("error", reject);
  });
}
const matchAll = (re, s) => { const out = []; let m; while ((m = re.exec(s))) out.push(m[1]); return out; };

// Discover the latest BUSTO/<YYYY-YYYY>/ year folder and the MAX DEMAND file within it.
async function discoverLatest(log) {
  const yearsXml = await s3List("BUSTO/");
  const years = matchAll(/<Prefix>BUSTO\/([0-9]{4}-[0-9]{4})\/<\/Prefix>/g, yearsXml).sort();
  if (!years.length) throw new Error("BUSTO: no year folders found");
  const year = years[years.length - 1];
  const filesXml = await s3List(`BUSTO/${year}/`);
  const keys = matchAll(/<Key>([^<]+)<\/Key>/g, filesXml).map((k) => k.replace(/&amp;/g, "&"));
  const key = keys.find((k) => /MAX DEMAND HOUR BY ROUTE BY TIMEBAND All Routes\.csv$/i.test(k));
  if (!key) throw new Error(`BUSTO: MAX DEMAND file not found in ${year}`);
  log && log.info(`busto: latest year ${year} → ${key}`);
  return { year, key };
}

// number that tolerates blanks / NaN
const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const r = (n, d = 1) => { const p = 10 ** d; return Math.round(n * p) / p; };

/**
 * Stream the MAX DEMAND CSV and reduce to one aggregate per route.
 * Returns { year, sourceFile, source, generatedAt, rows, routes:[ {route, peak, byDay, maxLoad, maxCapacity, stopRows} ] }.
 */
export async function fetchBusto({ log } = {}) {
  const { year, key } = await discoverLatest(log);
  const url = `${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const routes = new Map();
  let header = null, parsed = 0, bad = 0;

  await new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`BUSTO CSV HTTP ${res.statusCode}`)); return; }
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line) return;
        if (header === null) {
          header = line.trim();
          if (header.replace(/\s+/g, "") !== EXPECTED_HEADER.replace(/\s+/g, ""))
            log && log.warn(`busto: header drift — got "${header.slice(0, 80)}…"`);
          return;
        }
        const c = line.split(",");
        if (c.length < 15) { bad++; return; }
        const len = c.length;
        // fixed numeric tail (right-anchored) → robust to a comma inside STOPNAME
        const vc = num(c[len - 1]), seats = num(c[len - 2]), cap = num(c[len - 3]),
              load = num(c[len - 4]), boardings = num(c[len - 6]), stopSeq = num(c[len - 7]);
        const route = c[4], dayType = c[1], timeband = num(c[2]), time = c[3], direction = c[5], stopcode = c[6];
        const stopname = c.slice(7, len - 7).join(",").trim();
        if (!route || !Number.isFinite(vc)) { bad++; return; }
        parsed++;
        let agg = routes.get(route);
        if (!agg) { agg = { route, peak: null, byDay: {}, maxLoad: 0, maxCapacity: 0, stopRows: 0 }; routes.set(route, agg); }
        agg.stopRows++;
        if (load > agg.maxLoad) agg.maxLoad = load;
        if (cap > agg.maxCapacity) agg.maxCapacity = cap;
        const rec = { vc: r(vc, 4), load: r(load), capacity: r(cap), seats: r(seats), boardings: r(boardings),
                      dayType, timeband, time, direction, stopcode, stopname, stopSeq };
        if (!agg.peak || vc > agg.peak.vc) agg.peak = rec;
        const d = agg.byDay[dayType];
        if (!d || vc > d.vc) agg.byDay[dayType] = rec;
      });
      rl.on("close", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(STREAM_TIMEOUT_MS, () => req.destroy(new Error("BUSTO stream timeout")));
  });

  log && log.info(`busto: parsed ${parsed} stop-rows (${bad} skipped) → ${routes.size} routes`);
  return {
    year, sourceFile: key, source: `TfL BUSTO ${year} (crowding.data.tfl.gov.uk)`,
    generatedAt: new Date().toISOString(), rows: parsed,
    routes: [...routes.values()],
  };
}
