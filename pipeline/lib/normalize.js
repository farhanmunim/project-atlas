/**
 * lib/normalize.js — canonical cleanup for the messy bits of bus data.
 *
 *   cleanMake(raw)          DVLA make string → clean display name (chassis maker)
 *   propulsionOf(fuel)      DVLA fuelType    → electric|hybrid|hydrogen|diesel|gas|null
 *   canonicalOperator(raw)  operator/company → canonical London brand (operator-aliases.json)
 *
 * Used by the build/* steps so the warehouse lands already-clean (the app + API never
 * see ALL-CAPS makes, body-string noise, or "Arriva London North Ltd." variants).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── vehicle make ─────────────────────────────────────────────────────────────
// DVLA registers the CHASSIS manufacturer (ALL-CAPS, sometimes with body noise like
// "BYD ENVIRO 200EV"). Map the prefix to a clean brand; title-case anything unknown.
const MAKE_RULES = [
  [/^ALEXANDER\s*DENNIS|^ADL\b|^DENNIS\b/, "Alexander Dennis"],
  [/^WRIGHT/, "Wrightbus"],
  [/^VOLVO/, "Volvo"],
  [/^BYD/, "BYD"],
  [/^OPTARE/, "Optare"],
  [/^SWITCH/, "Switch Mobility"],
  [/^IRIZAR/, "Irizar"],
  [/^CAETANO/, "Caetano"],
  [/^MERCEDES/, "Mercedes-Benz"],
  [/^YUTONG/, "Yutong"],
  [/^SCANIA/, "Scania"],
  [/^\s*DAF/, "DAF"],
  [/^MAN\b/, "MAN"],
  [/^WRIGHTBUS|^VDL/, "VDL"],
];
export function cleanMake(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  for (const [re, name] of MAKE_RULES) if (re.test(s)) return name;
  // unknown → Title Case (keep short all-caps tokens like "MAN"/"DAF" upper)
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── propulsion bucket ────────────────────────────────────────────────────────
// The DVLA-fuelType edge cases matter: HEAVY OIL = diesel, FUEL CELL = hydrogen,
// ELECTRICITY = electric, and any *HYBRID* (incl. "DIESEL ELECTRIC") = hybrid. NOTE:
// DVLA frequently reports series/parallel hybrids as plain DIESEL — so callers that
// have a more authoritative source (LBR fleet codes) should prefer it over this.
export function propulsionOf(fuel) {
  const f = String(fuel || "").toUpperCase();
  if (!f) return null;
  if (f.includes("HYBRID")) return "hybrid";
  if (f.includes("ELECTRIC") && f.includes("DIESEL")) return "hybrid";   // diesel-electric
  if (f === "ELECTRICITY" || f === "ELECTRIC") return "electric";
  if (f.includes("HYDROGEN") || f.includes("FUEL CELL")) return "hydrogen";
  if (f.includes("DIESEL") || f.includes("HEAVY OIL") || f.includes("GAS OIL")) return "diesel";
  if (f.startsWith("GAS") || f.includes("CNG") || f.includes("LPG")) return "gas";
  return null;
}

// ── operator brand ───────────────────────────────────────────────────────────
let ALIASES = null;
function loadAliases() {
  if (ALIASES) return ALIASES;
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "operator-aliases.json");
    const brands = JSON.parse(readFileSync(p, "utf8")).brands || [];
    // longest aliases first so "arriva london north" wins over "arriva"
    ALIASES = brands.flatMap((b) => (b.aliases || []).map((a) => [a.toLowerCase(), b.brand]))
      .sort((a, b) => b[0].length - a[0].length);
  } catch { ALIASES = []; }
  return ALIASES;
}
const stripLegal = (s) => String(s || "").replace(/\b(ltd|limited|plc|llp|\(.*?\)|co\.?|company)\b/gi, " ").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
export function canonicalOperator(raw) {
  if (!raw) return null;
  const cleaned = stripLegal(raw);
  const lc = cleaned.toLowerCase();
  for (const [alias, brand] of loadAliases()) if (lc.includes(alias)) return brand;
  return cleaned || null;   // unknown → just the legal-suffix-stripped form (never lose data)
}
