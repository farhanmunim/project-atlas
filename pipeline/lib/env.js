/**
 * env.js — load .env (repo root) into process.env, with zero dependencies.
 *
 * Import this once, first, at every entry point (run.js, serve.js). It uses
 * Node's native process.loadEnvFile() (Node ≥20.12). Missing .env is fine —
 * every key is OPTIONAL and the app degrades gracefully without it:
 *
 *   TFL_APP_KEY    — TfL Unified API subscription key (api-portal.tfl.gov.uk).
 *                    Optional: the API works key-less but is rate-limited; the
 *                    key raises the limit. Server-side only (pipeline) — never
 *                    shipped to the browser.
 *   DVLA_API_KEY   — DVLA Vehicle Enquiry Service key (developer-portal.driver-
 *                    vehicle-licensing.api.gov.uk). Optional: enables fleet
 *                    age / make / CO₂ enrichment from vehicle regs. Without it,
 *                    live regs still work (TfL arrivals); only the enrichment skips.
 *
 * No other source needs a key: postcodes.io, CARTO/OSM tiles, londonbusroutes.net
 * and the TfL tender pages are all keyless/open.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(root, ".env");
try {
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);
} catch { /* malformed .env — ignore, run with whatever process.env already holds */ }

export const keys = {
  tfl: !!process.env.TFL_APP_KEY,
  dvla: !!process.env.DVLA_API_KEY,
  bods: !!process.env.BODS_API_KEY,
};
export function keySummary() {
  return `keys: TfL ${keys.tfl ? "✓" : "—"} · DVLA ${keys.dvla ? "✓" : "—"} · BODS ${keys.bods ? "✓" : "—"}`;
}
