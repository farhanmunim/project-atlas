/**
 * sources/dvsa-vol.js — DVSA Vehicle Operator Licensing bulk records (OGL).
 *
 * The traffic commissioners' licensing register, exported weekly-ish to
 * data.gov.uk as regional CSVs (observed: refreshed ~Friday nights; 0–14 days
 * behind the live register). This is the MACHINE route to what the VOL search
 * front-end shows — that site sits behind Imperva bot protection and session
 * tokens, so it is human-only; never scrape it.
 *
 * We read the London & South East report and index PSV licences by the
 * postcodes of their OPERATING CENTRES, so build/garages.js can attach the
 * licensed-operator facts to each garage: licence number/type/status, holder,
 * and NumberOfVehiclesAuthorised. NOTE the semantics: the authorised figure is
 * the LICENCE-level ceiling shared across every operating centre on that
 * licence — it is NOT a per-garage capacity (East London Bus & Coach's 930
 * covers all its depots). Keep it separate from the physical capacity field.
 *
 * Cadence: fetched once per daily run (~9.6 MB from DVSA's own file host);
 * upstream regenerates weekly, so most fetches are a same-bytes re-read —
 * acceptable for one call/day against a government bulk host.
 */

import { getText } from "../lib/http.js";

const VOL_URL = "https://content.mgmt.dvsacloud.uk/olcs.app.prod.dvsa.aws/data-gov-uk-export/OLBSLicenceReport_London%20and%20the%20South%20East%20of%20England.csv";

/* Quote-aware CSV → array of row-arrays (same shape as londonbusroutes.js's). */
function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; } if (c === "\r" && text[i + 1] === "\n") i++; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** UK postcodes present in a ;-joined operating-centre address blob, normalised
 *  to "OUTWARD INWARD" upper-case single-space form. Exported for unit tests. */
export function extractPostcodes(ocAddress) {
  const out = new Set();
  for (const m of String(ocAddress || "").toUpperCase().matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/g)) out.add(`${m[1]} ${m[2]}`);
  return [...out];
}

/** Best licence for a garage from the candidates at its postcode: prefer valid
 *  status, then the largest authorised fleet (the depot's PSV licence dwarfs any
 *  co-located coach firm). Exported for unit tests. */
export function pickLicence(cands) {
  if (!cands || !cands.length) return null;
  const rank = (l) => [(l.status || "").toLowerCase() === "valid" ? 1 : 0, l.authorisedVehicles || 0];
  return [...cands].sort((a, b) => { const ra = rank(a), rb = rank(b); return rb[0] - ra[0] || rb[1] - ra[1]; })[0];
}

/** → { byPostcode: { "E8 4RH": [{ number, holder, type, status, authorisedVehicles }] }, licences } */
export async function fetchVolLicences(opts = {}) {
  const csv = await getText(VOL_URL, { timeoutMs: 60_000, ...opts });
  const rows = parseCsv(csv);
  const head = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  const col = (name) => head.indexOf(name);
  const iLic = col("LicenceNumber"), iType = col("LicenceType"), iOp = col("OperatorName"),
    iOC = col("OCAddress"), iAuth = col("NumberOfVehiclesAuthorised"), iStatus = col("LicenceStatus");
  if (iLic < 0 || iOC < 0 || iAuth < 0) throw new Error("VOL CSV header changed — expected LicenceNumber/OCAddress/NumberOfVehiclesAuthorised");

  const byLicence = new Map();   // rows repeat per director/transport-manager — dedupe
  for (const r of rows.slice(1)) {
    const num = (r[iLic] || "").trim();
    if (!num.startsWith("P")) continue;   // PSV licences only (goods start with O)
    if (byLicence.has(num)) continue;
    byLicence.set(num, {
      number: num,
      holder: (r[iOp] || "").trim() || null,
      type: (r[iType] || "").trim() || null,
      status: (r[iStatus] || "").trim().replace(/^lsts_/, "").replace(/^\w/, (c) => c.toUpperCase()) || null,
      authorisedVehicles: Number.isFinite(+r[iAuth]) && +r[iAuth] > 0 ? +r[iAuth] : null,
      _postcodes: extractPostcodes(r[iOC]),
    });
  }
  const byPostcode = {};
  for (const lic of byLicence.values()) {
    const { _postcodes, ...pub } = lic;
    for (const pc of _postcodes) (byPostcode[pc] ||= []).push(pub);
  }
  return { byPostcode, licences: byLicence.size };
}
