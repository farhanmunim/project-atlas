/**
 * lib/pdf.js — pdfjs-dist setup + position-aware text extraction.
 *
 * Ported from ingest/scripts/_lib/pdf.js. TfL's QSI / MPS PDFs are Excel exports
 * with tightly-packed columns, so we need each text fragment's (x, y) to recover
 * real table rows: cluster fragments by y-coordinate, sort each row left-to-right
 * by x. pdf-parse can't do this (it emits column-then-row order and scrambles rows).
 *
 * Uses the pdfjs-dist legacy CJS build (friendlier for Node `require`) with no
 * worker thread, and the `pathToFileURL` worker-path conversion required on
 * Windows so the ESM loader accepts the `C:\…` worker path as `file://…`.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pdfjs = require("pdfjs-dist/legacy/build/pdf.mjs");

let _workerInitialised = false;

function initPdfWorker() {
  if (_workerInitialised) return;
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  _workerInitialised = true;
}

/**
 * Open a PDF buffer and return one row[][] per page — text fragments grouped by
 * their visual y-coordinate (rounded to integer pixels), each row sorted L→R by x.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string[][][]>}  pages → rows → cells
 */
export async function extractPdfRowsByPage(buffer) {
  initPdfWorker();
  // pdfjs-dist 4.x rejects Node Buffer and demands a plain Uint8Array; Buffer is
  // a Uint8Array subclass so we rebuild a plain view over the same memory (zero-copy).
  const data = (typeof Buffer !== "undefined" && Buffer.isBuffer(buffer))
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map();
    for (const item of content.items) {
      const s = (item.str ?? "").trim();
      if (!s) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x, s });
    }
    // y descending (PDF origin is bottom-left) → visual top-to-bottom reading order.
    const rows = [...byY.keys()]
      .sort((a, b) => b - a)
      .map((y) => byY.get(y).sort((a, b) => a.x - b.x).map((c) => c.s));
    pages.push(rows);
  }
  return pages;
}

/** Same as above but flattened to one row[] (page boundaries discarded). */
export async function extractPdfRows(buffer) {
  const pages = await extractPdfRowsByPage(buffer);
  return pages.flat();
}
