/**
 * build-garage-capacity.js
 *
 * Joins DVSA operating-centre capacities (capacity/licences.json) onto our
 * garages, writing data/garage-capacity.json (keyed by TfL garage code).
 *
 * Why a join step: the licence data is keyed by operating-centre postcode,
 * not by our TfL garage codes. Each OC's `vehicles` is its own authorised
 * maximum. We match an OC to a garage by postcode, preferring an OC whose
 * licence operator matches the garage's operator (postcodes occasionally
 * collide across operators / a main depot + satellite share one). On a tie
 * the larger figure wins (the main depot rather than a satellite OC).
 *
 * capacity/licences.json is refreshed by hand (the source web service is
 * Imperva bot-walled — fetch, headless AND headful Puppeteer all 403). Use
 * the bookmarklet in capacity/extract-bookmarklet.js to scrape each licence
 * page from a real browser and paste the JSON in — no screenshots. Capacity
 * is a licensing figure that moves only at licence variation (~yearly).
 *
 * Run: npm run build-garage-capacity   (then npm run build-garage-locations)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const LIC_PATH  = path.join(ROOT, 'capacity', 'licences.json');
const GAR_PATH  = path.join(ROOT, 'data', 'garages.geojson');
const OUT_PATH  = path.join(ROOT, 'data', 'garage-capacity.json');

const normPc = s => {
  const m = String(s || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return m ? `${m[1]} ${m[2]}` : null;
};

if (!fs.existsSync(LIC_PATH)) { console.error(`Missing ${LIC_PATH}`); process.exit(1); }
if (!fs.existsSync(GAR_PATH)) { console.error(`Missing ${GAR_PATH}`); process.exit(1); }

const lic = JSON.parse(fs.readFileSync(LIC_PATH, 'utf8'));
const gar = JSON.parse(fs.readFileSync(GAR_PATH, 'utf8'));

// Flat list of every OC + a postcode index.
const allOcs = [];
const ocByPc = new Map();
for (const l of lic.licences ?? []) {
  for (const oc of l.ocs ?? []) {
    if (!Number.isFinite(oc.vehicles)) continue;
    const rec = { operator: l.operator, vehicles: oc.vehicles, address: oc.address, pc: normPc(oc.address) };
    allOcs.push(rec);
    if (rec.pc) {
      if (!ocByPc.has(rec.pc)) ocByPc.set(rec.pc, []);
      ocByPc.get(rec.pc).push(rec);
    }
  }
}

// Tier 1 — exact postcode, preferring same operator, then the larger figure
// (main depot over a satellite OC sharing the postcode).
function byPostcode(pc, operator) {
  const list = pc ? ocByPc.get(pc) : null;
  if (!list?.length) return null;
  const sameOp = list.filter(o => o.operator === operator);
  const pool = sameOp.length ? sameOp : list;
  return pool.reduce((m, o) => Math.max(m, o.vehicles), 0) || null;
}

// Tier 1.5 — same operator + same postcode SECTOR (outward + first inward
// digit, e.g. "NW10 2"). Resolves a garage whose exact postcode differs from
// the registered OC but sits in the same sector, picking the right OC among
// same-operator siblings (e.g. Willesden Garage NW10 2JX over Willesden
// Junction NW10 4XB; Greenford Depot UB6 9AP over Vanguard Site UB6 8DW).
const sectorOf = s => { const m = String(s || '').toUpperCase().match(/^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)/); return m ? `${m[1]} ${m[2]}` : null; };
function bySector(pc, operator) {
  const s = sectorOf(pc);
  if (!s) return null;
  const hits = allOcs.filter(o => o.operator === operator && sectorOf(o.pc) === s);
  if (hits.length === 1) return hits[0].vehicles;
  return null;
}

// Tier 2 — same operator + garage name appearing in the OC address. Catches
// near-miss postcodes (our geocoded postcode vs DVSA's registered one differ,
// e.g. Greenford UB6 9AR vs 9AP). Only used when exactly one OC matches, to
// avoid false positives on common place-names.
const cleanName = s => String(s || '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ')                              // drop parentheticals: "Morden Wharf (Greenwich)"
  .replace(/['’]/g, '')                                    // drop apostrophes: "King's Cross"
  .replace(/\b(garage|depot|bus garage|bus depot)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();
function byName(name, operator) {
  const needle = cleanName(name);
  if (needle.length < 4) return null;
  const hits = allOcs.filter(o => o.operator === operator && cleanName(o.address).includes(needle));
  if (hits.length !== 1) return null;
  return hits[0].vehicles;
}

const garages = {};
const matched = [], unmatched = [];
const rows = (gar.features ?? [])
  .map(f => {
    const p = f.properties ?? {};
    return {
      code: String(p['TfL garage code'] || '').trim().toUpperCase(),
      name: p['Garage name'] || '',
      operator: p['Group name'] || '',
      postcode: p._geocode_postcode || normPc(p['Garage address']),
    };
  })
  .filter(r => r.code)
  .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

for (const r of rows) {
  const capacity = byPostcode(r.postcode, r.operator)
                ?? bySector(r.postcode, r.operator)
                ?? byName(r.name, r.operator);
  garages[r.code] = { name: r.name, operator: r.operator, postcode: r.postcode, capacity: capacity ?? null };
  (capacity ? matched : unmatched).push(r.code);
}

const out = {
  description: lic._description
    ? 'Per-garage operating-centre vehicle capacity (DVSA operator licence), generated by scripts/build-garage-capacity.js from capacity/licences.json (matched by postcode). Do not hand-edit capacities here — edit capacity/licences.json and re-run `npm run build-garage-capacity`. Then `npm run build-garage-locations` to surface on the frontend.'
    : '',
  generatedAt: new Date().toISOString(),
  source: 'DVSA operator-licensing service via capacity/licences.json',
  garages,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`Wrote ${Object.keys(garages).length} garages → data/garage-capacity.json`);
console.log(`  matched: ${matched.length}  unmatched: ${unmatched.length}`);
if (unmatched.length) {
  console.log('  unmatched (need a licence capture):');
  for (const code of unmatched) {
    const g = garages[code];
    console.log(`    ${code.padEnd(4)} ${(g.name || '').slice(0, 22).padEnd(23)} ${(g.postcode || '?').padEnd(9)} ${g.operator || '?'}`);
  }
}
