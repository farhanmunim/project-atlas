/**
 * overrides.js — the manual override layer (pipeline/overrides.json).
 *
 * The last word in the pipeline: after every source has run and been normalised,
 * builders merge these hand-curated per-route values on top, so a known-wrong or
 * missing datapoint can always be corrected without touching code. Mirrors the
 * reference app's route-overrides.json. Used today for the 24-hour classification
 * (no free feed exposes it) and any operator/garage/fleet corrections.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../overrides.json");
let cache = null;

export function loadOverrides() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, "utf8")).routes || {}; }
  catch { cache = {}; }
  return cache;
}
/** Override object for a route name, or {}. */
export function overrideFor(name) { return loadOverrides()[name] || {}; }
