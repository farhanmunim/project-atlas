/**
 * pdf.js — Shared pdfjs-dist setup + position-aware text extraction.
 *
 * Three fetchers (`fetch-route-performance`, `fetch-route-mps`,
 * `fetch-tender-programme`) all need:
 *   1. The same one-time pdfjs worker URL setup, with the `pathToFileURL`
 *      conversion that's required on Windows so the ESM loader accepts the
 *      `C:\…\pdf.worker.mjs` path as `file://…`.
 *   2. Text extraction that preserves table structure — pdfjs-dist returns
 *      a flat list of text fragments with (x, y) transforms. To recover
 *      rows we cluster fragments by y-coord and sort each row by x.
 *
 * This module exports both, so each fetcher just imports and calls instead
 * of reimplementing the same ~25 lines.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
// Legacy CJS build is friendlier for Node-side `require` than the default
// ESM build. pdfjs-dist 4.x ships both.
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');

let _workerInitialised = false;

/**
 * One-time worker URL setup. Calling more than once is a no-op. Resolves
 * `pdf.worker.mjs` from node_modules and converts the resulting absolute
 * path to a `file://` URL so the ESM loader accepts it on every platform.
 */
export function initPdfWorker() {
  if (_workerInitialised) return;
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  _workerInitialised = true;
}

/**
 * Open a PDF buffer and return one row[][] per page — text fragments
 * grouped by their visual y-coordinate (rounded to integer pixels), each
 * row sorted left-to-right by x. Excel-exported PDFs (TfL's QSI / MPS /
 * programme reports) place every cell on a consistent baseline per row,
 * so y-clustering gives clean table rows.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string[][][]>}   pages → rows → cells
 */
export async function extractPdfRowsByPage(buffer) {
  initPdfWorker();
  // pdfjs-dist 4.x explicitly rejects Node `Buffer` (a Uint8Array subclass)
  // and demands a plain Uint8Array. `buffer instanceof Uint8Array` is true
  // for Buffer, so we have to test for Buffer first and rebuild the view as
  // a plain Uint8Array over the same memory (zero-copy).
  const data = (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer))
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts:  true,
    disableFontFace: true,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map();
    for (const item of content.items) {
      const s = (item.str ?? '').trim();
      if (!s) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x, s });
    }
    // Sort y descending (PDF coord origin is bottom-left) so rows come back
    // in visual top-to-bottom reading order.
    const rows = [...byY.keys()]
      .sort((a, b) => b - a)
      .map(y => byY.get(y).sort((a, b) => a.x - b.x).map(c => c.s));
    pages.push(rows);
  }
  return pages;
}

/**
 * Convenience: same as `extractPdfRowsByPage` but flattened to a single
 * row[] (page boundaries discarded). Suitable for PDFs whose tables are
 * naturally one continuous list (per-route MPS, programme tables).
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string[][]>}
 */
export async function extractPdfRows(buffer) {
  const pages = await extractPdfRowsByPage(buffer);
  return pages.flat();
}
