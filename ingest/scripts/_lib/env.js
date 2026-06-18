/**
 * env.js — `.env` loader shared by every pipeline script.
 *
 * Reads KEY=VALUE pairs from <repo-root>/.env into `process.env`. Existing env
 * vars (e.g. those set by GitHub Actions secrets) always win — local `.env`
 * never overrides CI. Quoted values have their wrapping quotes stripped.
 * Silently skips if `.env` is missing (the GH Actions case).
 *
 * Usage:
 *   import { loadEnv } from './_lib/env.js';
 *   loadEnv();
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

// Single source of truth for the package version. Read at module load so
// every script that calls `userAgent()` gets the current shipped version
// without manual rebumps in 8 places. Falls back to a stable string if the
// package.json read fails for any reason.
let _pkgVersion = null;
function getPkgVersion() {
  if (_pkgVersion) return _pkgVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    _pkgVersion = pkg.version || 'dev';
  } catch {
    _pkgVersion = 'dev';
  }
  return _pkgVersion;
}

/**
 * Canonical User-Agent string for outbound HTTP requests. All fetchers go
 * through this so the version stamp can never drift across scripts.
 *   userAgent('route-mps') → 'london-buses-map/2.8 (route-mps)'
 *
 * @param {string} scriptName  Short label for the calling script (no slash).
 * @returns {string}
 */
export function userAgent(scriptName) {
  return `london-buses-map/${getPkgVersion()} (${scriptName})`;
}
