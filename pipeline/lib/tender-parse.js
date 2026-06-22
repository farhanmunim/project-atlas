/**
 * lib/tender-parse.js — derive STRUCTURED award detail from TfL's free-text fields.
 *
 * TfL's tender result pages carry two prose cells we already capture raw on every
 * award (`jointBid`, `notes`) plus an occasional tranche reference. This module is
 * the single, shared place that turns that prose into typed fields so the warehouse,
 * the API and the app all read the same normalised shape (capture once, expose
 * everywhere). It is pure + deterministic (no I/O) so the builder can run it over the
 * cache and the app never has to re-parse prose at render time.
 *
 * LOCKSTEP WITH SUPABASE: the three canonical fields (`isJoint`, `vehiclesBasis`,
 * `propulsion`) mirror, verbatim, the derivations in
 * `ingest/scripts/push-to-supabase.js` (deriveJointBid / deriveVehiclesBasis /
 * deriveTenderPropulsion) so the app, the `data/*.json` store and the warehouse all
 * agree. The two subtrees share no code path (by design), so the logic is duplicated
 * here intentionally — keep the two in sync if either changes. `deck`, `euro`,
 * `lowFloor`, `partners`, `total` and `tranche` are additive app-side enrichment
 * reproducible from the same raw fields the warehouse stores.
 *
 *   deriveAward(award) → { ...award, jb, vehicle, tranche }
 *     jb      : { isJoint, partners:[route…], total:£number|null, raw } | null
 *     vehicle : { basis, propulsion, deck, lowFloor, euro, summary, raw } | null
 *     tranche : number | null   (LBSL tendering tranche, when stated in the prose)
 *
 * Everything degrades to null when the prose says nothing — never a fabricated value.
 */

// A London bus route token: optional 1–2 letter prefix (SL/EL/N/B/P/W/X…) + 1–3
// digits + optional trailing letter (e.g. 24, N341, P12, B11, SL8, 601).
const ROUTE_TOKEN = /^[A-Z]{0,2}\d{1,3}[A-Z]?$/;

/** Parse "£13,806,151" / "£9,253,877 per annum" → 13806151 (annual £). */
function parseMoney(text) {
  const m = String(text || "").match(/£\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** All "Tranche 188" numbers found in a blob, in order. */
function tranchesIn(text) {
  return [...String(text || "").matchAll(/\btranche\s+(\d{1,4})\b/gi)].map((m) => Number(m[1]));
}

// ── Canonical derivations — MUST match push-to-supabase.js ────────────────────

/** True when the award was part of a joint bid. (== warehouse deriveJointBid) */
export function deriveJointBidFlag(notes, jointBids) {
  if (jointBids && jointBids.trim().length > 5 && !/^N\/?A$/i.test(jointBids.trim())) return true;
  if (notes && /\b(?:joint\s*bid|jb)\b/i.test(notes)) return true;
  return false;
}

/** 'new' | 'existing' | null — what vehicles the contract was awarded on.
 *  (== warehouse deriveVehiclesBasis; 'existing' wins when both are mentioned.) */
export function deriveVehiclesBasis(notes) {
  if (!notes) return null;
  const t = notes.toLowerCase();
  if (/\bexisting\b/.test(t)) return "existing";
  if (/\bnew\s+(?:bus|vehicle|fleet|electric|hybrid|euro|hydrogen|streetdeck|euro vi|battery)/i.test(t)) return "new";
  if (/\b(?:awarded|award)\s+on\s+new\b/.test(t)) return "new";
  return null;
}

/** 'electric'|'hybrid'|'hydrogen'|'diesel'|null — awarded propulsion.
 *  (== warehouse deriveTenderPropulsion; pool = notes + jointBids, precedence
 *  hydrogen → hybrid → electric → diesel.) */
export function deriveTenderPropulsion(notes, jointBids) {
  const pool = `${notes ?? ""} ${jointBids ?? ""}`.toLowerCase();
  if (!pool.trim()) return null;
  if (/\b(?:fuel\s*cells?|fcev|hydrogen)\b/.test(pool)) return "hydrogen";
  if (/\b(?:battery\s*hybrids?|hybrid\s*electrics?|hybrids?)\b/.test(pool)) return "hybrid";
  if (/\b(?:zero\s*emission|battery\s*electrics?|electrics?|evs?|zedd|zesd)\b/.test(pool)) return "electric";
  if (/\b(?:diesels?|euro\s*\d)\b/.test(pool) && !/electric|hybrid/.test(pool)) return "diesel";
  return null;
}

// ── App-side enrichment (reproducible from the same raw fields) ───────────────

/** Awarded deck from notes: 'double' | 'single' | null. */
function deriveDeck(notes) {
  const t = String(notes || "").toLowerCase();
  if (/double[\s-]*deck/.test(t)) return "double";
  if (/single[\s-]*deck/.test(t)) return "single";
  return null;
}

/**
 * Joint-bid prose → structured partner routes + total (task 4). Handles the two
 * TfL phrasings ("Routes 96, 99 … awarded on the basis of a joint bid totalling £…"
 * and "Part of a joint bid with routes 42 & P12 totalling £…"). Tranche refs live in
 * parentheses ("(Tranche 188)") and are stripped before route extraction so they
 * can't be mistaken for routes; the £total is stripped too.
 */
export function parseJointBid(jointBidText, notes, selfRoute) {
  if (!deriveJointBidFlag(notes, jointBidText)) return null;
  const raw = String(jointBidText || "").trim();
  // self-route variants ("1/N1" → ["1","N1"]) so we list only the OTHER routes.
  const selfKeys = new Set(String(selfRoute || "").split(/[\/,]/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const scrubbed = raw.replace(/\((?:[^)]*tranche[^)]*)\)/gi, " ").replace(/£\s*[\d,]+(?:\.\d+)?/g, " ");
  const partners = [];
  for (const seg of scrubbed.matchAll(/\broutes?\s+([0-9A-Za-z,&\s]+?)(?=\b(?:awarded|totalling|together|per\s+annum|on\s+the\s+basis)\b|$)/gi)) {
    for (const tok of seg[1].split(/[,&]|\band\b/i)) {
      const t = tok.trim().toUpperCase();
      if (ROUTE_TOKEN.test(t) && !selfKeys.has(t) && !partners.includes(t)) partners.push(t);
    }
  }
  return { isJoint: true, partners, total: parseMoney(raw), raw: raw || null };
}

/** Free-text award notes → the vehicle spec the contract was awarded on (task 5). */
export function parseVehicleType(notes, jointBids) {
  const basis = deriveVehiclesBasis(notes);
  const propulsion = deriveTenderPropulsion(notes, jointBids);
  const deck = deriveDeck(notes);
  const t = String(notes || "").toLowerCase();
  const lowFloor = /low[\s-]*floor/.test(t);
  const euroM = t.match(/euro\s*(vi|v|iv|iii|ii|i|\d)\b/);
  const euro = euroM ? euroM[1].toUpperCase() : null;
  if (!basis && !propulsion && !deck && !lowFloor && !euro) return null;
  const bits = [];
  if (basis) bits.push(basis);
  if (propulsion) bits.push(propulsion);
  if (euro) bits.push("Euro " + euro);
  if (lowFloor) bits.push("low-floor");
  if (deck) bits.push(deck + "-deck");
  return { basis, propulsion, deck, lowFloor, euro, summary: bits.join(" · "), raw: String(notes || "").trim() || null };
}

/**
 * Attach derived fields to one award. Pure: returns a new object, leaving the raw
 * append-only cache record untouched. Used by build/tenders.js when it denormalises
 * into byRoute, and by the one-off regen over the committed store.
 */
export function deriveAward(award) {
  const jb = parseJointBid(award.jointBid, award.notes, award.route);
  const vehicle = parseVehicleType(award.notes, award.jointBid);
  const fromText = [...tranchesIn(award.jointBid), ...tranchesIn(award.notes)];
  const tranche = (award.tranche != null && Number.isFinite(Number(award.tranche)))
    ? Number(award.tranche)
    : (fromText.length ? fromText[0] : null);
  return { ...award, jb, vehicle, tranche };
}
