/**
 * audit-summary.js — categorise the disagreements in 00-comparison.csv into
 * actionable buckets. Outputs a human-readable summary and a tighter
 * disagreements CSV for review.
 *
 * **On-demand audit tool — NOT part of the weekly pipeline.** Run after
 * `npm run audit-vehicle-data` to spot routes where our classification
 * disagrees with bustimes.org's fleet listing. Useful when investigating
 * a suspected pipeline regression or fleet drift.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');

function readCsv(file) {
  const text = fs.readFileSync(path.join(AUDIT_DIR, file), 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    // Naive CSV — fine since we wrote these ourselves with consistent escaping.
    const cells = [];
    let buf = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { buf += '"'; i++; }
        else if (c === '"') { inQ = false; }
        else buf += c;
      } else {
        if (c === ',') { cells.push(buf); buf = ''; }
        else if (c === '"' && buf === '') { inQ = true; }
        else buf += c;
      }
    }
    cells.push(buf);
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i] ?? '');
    return row;
  });
}

const cmp = readCsv('00-comparison.csv');

// Helpers — does a vehicle string imply hybrid / electric / diesel?
const HYBRID_RE   = /B5LH|B5TH|E40H|ENVIRO400H|NEW BUS FOR LONDON|NB4L|HYBRID|ECLIPSE GEMINI/i;
const ELECTRIC_RE = /\bEV\b|EVOSETI EV|ELECTROLINER|ENVIRO400EV|ENVIRO200 MMC EV|METROCITY EV|METRODECKER EV|BYD\b|YUTONG E\d|FCEV|HYDROGEN|FUEL CELL|STREETAIR|\bBZL\b|ELECTRIC/i;
const DIESEL_RE   = /TRIDENT(?!\s*FCEV)|ENVIRO400(?!H|EV)|ENVIRO200(?!\s*MMC\s*EV)|E40D|E20D|GEMINI 2(?!\s*EV)|B7TL|B9TL/i;

function impliedPropulsion(s) {
  if (!s) return null;
  if (HYBRID_RE.test(s) && !ELECTRIC_RE.test(s)) return 'hybrid';
  if (ELECTRIC_RE.test(s)) return 'electric';
  if (DIESEL_RE.test(s))   return 'diesel';
  return null;
}

const buckets = {
  // Our propulsion=diesel but bustimes says hybrid
  ourDieselBustimesHybrid:   [],
  // Our propulsion=diesel but bustimes says electric
  ourDieselBustimesElectric: [],
  // Our propulsion=hybrid but bustimes says electric
  ourHybridBustimesElectric: [],
  // Our propulsion=electric but bustimes says diesel/hybrid
  ourElectricBustimesOther:  [],
  // bustimes mixed types (transition route)
  transitionRoutes:          [],
  // both agree
  agreed:                    0,
  // no bustimes data to compare (no observed regs in bustimes fleet)
  unverifiable:              0,
};

for (const r of cmp) {
  if (!r.bustimes_types || +r.bustimes_observed_regs < 2) {
    buckets.unverifiable++;
    continue;
  }
  const bustimesPropulsions = r.bustimes_types
    .split(' | ')
    .map(impliedPropulsion)
    .filter(Boolean);
  if (bustimesPropulsions.length === 0) { buckets.unverifiable++; continue; }
  const dominantBustimes = bustimesPropulsions.sort((a, b) => {
    return bustimesPropulsions.filter(x => x === b).length
         - bustimesPropulsions.filter(x => x === a).length;
  })[0];

  if (new Set(bustimesPropulsions).size > 1) {
    buckets.transitionRoutes.push({
      route_id: r.route_id,
      our_propulsion: r.our_propulsion,
      bustimes_types: r.bustimes_types,
      observed: r.bustimes_observed_regs,
    });
  }

  const our = r.our_propulsion;
  if (our === dominantBustimes) { buckets.agreed++; continue; }

  const entry = {
    route_id: r.route_id,
    our_vehicle_type: r.our_vehicle_type,
    our_propulsion: our,
    bustimes_dominant: dominantBustimes,
    bustimes_types: r.bustimes_types,
    observed: r.bustimes_observed_regs,
  };
  if (our === 'diesel'   && dominantBustimes === 'hybrid')    buckets.ourDieselBustimesHybrid.push(entry);
  else if (our === 'diesel'   && dominantBustimes === 'electric')  buckets.ourDieselBustimesElectric.push(entry);
  else if (our === 'hybrid'   && dominantBustimes === 'electric')  buckets.ourHybridBustimesElectric.push(entry);
  else if (our === 'electric' && (dominantBustimes === 'diesel' || dominantBustimes === 'hybrid'))
    buckets.ourElectricBustimesOther.push(entry);
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h] ?? '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  return lines.join('\n');
}

// Write per-bucket disagreements
fs.writeFileSync(path.join(AUDIT_DIR, '06-disagreements.csv'),
  '# Source: bustimes.org operator-fleet pages joined to TfL arrivals registrations.\n' +
  '# A row appears here only when ≥2 registrations from this route appeared in the\n' +
  '# bustimes operator fleet page AND the dominant propulsion implied by their vehicle\n' +
  '# type strings disagrees with our_propulsion.\n' +
  '\n' +
  rowsToCsv([
    ...buckets.ourDieselBustimesHybrid.map(r => ({ category: 'ours=diesel; bustimes=hybrid', ...r })),
    ...buckets.ourDieselBustimesElectric.map(r => ({ category: 'ours=diesel; bustimes=electric', ...r })),
    ...buckets.ourHybridBustimesElectric.map(r => ({ category: 'ours=hybrid; bustimes=electric', ...r })),
    ...buckets.ourElectricBustimesOther.map(r => ({ category: 'ours=electric; bustimes=other', ...r })),
  ]),
  'utf8'
);

// Print summary
console.log('=== AUDIT SUMMARY ===\n');
console.log(`Total routes:                            ${cmp.length}`);
console.log(`  agreed with bustimes (≥2 regs):        ${buckets.agreed}`);
console.log(`  unverifiable (no bustimes match):      ${buckets.unverifiable}`);
console.log(`  ours=diesel, bustimes=hybrid:          ${buckets.ourDieselBustimesHybrid.length}`);
console.log(`  ours=diesel, bustimes=electric:        ${buckets.ourDieselBustimesElectric.length}`);
console.log(`  ours=hybrid, bustimes=electric:        ${buckets.ourHybridBustimesElectric.length}`);
console.log(`  ours=electric, bustimes=other:         ${buckets.ourElectricBustimesOther.length}`);
console.log(`  transition routes (mixed types):       ${buckets.transitionRoutes.length}`);
console.log('');
console.log('=== Top 12 of each bucket (sample) ===');
for (const [name, list] of Object.entries(buckets).filter(([n, v]) => Array.isArray(v) && v.length)) {
  console.log(`\n--- ${name} (${list.length} routes) ---`);
  list.slice(0, 12).forEach(r => {
    const types = r.bustimes_types ? r.bustimes_types.slice(0, 80) : '';
    console.log(`  ${r.route_id.padEnd(5)}  ours=${(r.our_propulsion ?? '—').padEnd(8)}  bustimes-says=${(r.bustimes_dominant ?? '—').padEnd(8)}  types=${types}`);
  });
}

console.log('\nFull CSV: data/audit/06-disagreements.csv');
