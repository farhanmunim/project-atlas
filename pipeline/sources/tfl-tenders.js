/**
 * sources/tfl-tenders.js — TfL bus tender award results (the full history).
 *
 *   13923.aspx                  discovery: a <select> whose every <option> is
 *                               one award event — value=btID, text="Route 1/N1".
 *                               ~2,500 options going back ~25 years.
 *   13796.aspx?btID=<id>        one award: route, # tenderers, winning operator,
 *                               accepted/lowest/highest bid, cost per live mile,
 *                               joint-bid note, free-text notes.
 *
 * Both are server-rendered (the values are in the static HTML even though the
 * page chrome is .aspx), so we parse the table cells directly. Heavy crawl →
 * the builder caches per-btID results and only fetches new ones (incremental).
 */

import { getText } from "../lib/http.js";

const DISCOVERY = "https://tfl.gov.uk/forms/13923.aspx";
const RESULT = (id) => `https://tfl.gov.uk/forms/13796.aspx?btID=${id}`;

const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&pound;/g, "£").trim();
const num = (s) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };

/**
 * Money parser that handles TfL's two comma conventions in the same column:
 *   '4,205,196' → thousands separators → 4205196
 *   '6,25'      → European decimal mark → 6.25
 * The decimal-comma form is a single comma with 1–2 trailing digits and no other
 * separators; anything else is a thousands strip. (Mirrors london-buses' parseMoney;
 * the old all-comma strip turned '6,25' into 625 — cost-per-mile outliers.)
 */
const money = (s) => {
  if (s == null) return null;
  let cleaned = String(s).replace(/[£\s]|&pound;/g, "");
  if (/^-?\d+,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(",", ".");
  else cleaned = cleaned.replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
};
const WORD_NUM = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };

/** Every award event as { btID, route } (route text e.g. "1/N1"). */
export async function fetchTenderIndex(opts = {}) {
  const html = await getText(DISCOVERY, { timeoutMs: 30_000, headers: { "User-Agent": "Mozilla/5.0" }, ...opts });
  const out = [];
  for (const m of html.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*Route[^<]*)<\/option>/gi)) {
    const route = stripTags(m[2]).replace(/^Route\s+/i, "").trim();
    if (route) out.push({ btID: m[1], route });
  }
  if (out.length < 200) throw new Error(`tender index: only ${out.length} options parsed`);
  return out;
}

/** Parse one award result page → normalised record (or null if unrecognised). */
export async function fetchTenderResult(btID, opts = {}) {
  const html = await getText(RESULT(btID), { timeoutMs: 25_000, headers: { "User-Agent": "Mozilla/5.0" }, ...opts });
  const cells = [...html.replace(/<script[\s\S]*?<\/script>/gi, "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((m) => stripTags(m[1])).filter(Boolean);
  if (!cells.length) return null;
  // value = the cell after a known label
  const after = (label) => { const i = cells.findIndex((c) => c.toLowerCase() === label.toLowerCase()); return i >= 0 ? cells[i + 1] : null; };
  const route = after("Route");
  if (!route) return null;
  const tenderersRaw = after("Number of Tenderers");
  const dateMatch = stripTags(html).match(/\b(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/);
  return {
    btID, route,
    operator: after("Successful Tenderer"),
    numberOfTenderers: tenderersRaw ? (WORD_NUM[tenderersRaw.toLowerCase()] ?? num(tenderersRaw)) : null,
    acceptedBid: num(after("Accepted Bid")),
    lowestBid: num(after("Lowest Individual Compliant Bid")),
    highestBid: num(after("Highest Individual Compliant Bid")),
    // Sanity-clamp cost per mile: TfL's form sometimes pastes the full annual bid
    // into this cell instead of the per-mile rate. Real rates span ~£3-15 (and up
    // to ~£100 for school routes); anything outside 0-200 is a column mix-up → null
    // rather than surface a £4.2M/mile headline. money() handles '6,25' → 6.25.
    costPerMile: ((v) => (v != null && v >= 0 && v <= 200 ? v : null))(
      money(after("Cost per live mile of awarded contract £/mile"))),
    jointBid: /joint/i.test(after("Joint Bids") || "") ? (after("Joint Bids") || null) : null,
    notes: after("Notes") || null,
    awardDate: dateMatch ? dateMatch[1] : null,
  };
}
