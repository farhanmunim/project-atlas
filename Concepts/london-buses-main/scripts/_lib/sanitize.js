/**
 * sanitize.js — Defence-in-depth string cleaning for scraped data.
 *
 * Every freeform string from an upstream source (TfL forms, londonbusroutes,
 * bustimes.org, postcodes.io, DVLA) flows through this helper before
 * landing in `data/source/*.json`. The frontend already defends with
 * `escapeHtml()` at every `innerHTML` site, but cleaning at ingress means:
 *
 *   1. Static JSON committed to the repo never carries hostile markup.
 *   2. The XLSX / CSV exports — which don't HTML-escape — stay safe.
 *   3. Any future consumer of the cached JSON inherits the same guarantee.
 *
 * What it does:
 *   - Strips every HTML tag (no `<script>`, `<img onerror>`, `<svg onload>`).
 *   - Strips every control character (NUL, BEL, etc.) except \n and \t.
 *   - Decodes the small set of named entities the scrapers see in practice.
 *   - Normalises whitespace runs to a single space (preserving newlines if
 *     the caller asks).
 *   - Caps length to `maxLen` so a malicious source can't blow up memory.
 *
 * What it DELIBERATELY doesn't do:
 *   - It is not a full HTML parser. We don't trust the output as HTML — we
 *     treat it as plain text. If the upstream changes shape, downstream
 *     sees a degraded but never-unsafe value.
 *   - It doesn't transform unicode. Unicode is fine as long as the control
 *     characters and tags are gone.
 */

const CONTROL_CHARS_RE  = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;   // strip C0/DEL except \n, \t
const HTML_TAG_RE       = /<[^>]*>/g;                            // greedy tag stripper
const NAMED_ENTITIES    = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&pound;': '£',
  '&euro;':  '€',
  '&cent;':  '¢',
  '&copy;':  '©',
  '&reg;':   '®',
  '&trade;': '™',
  '&hellip;':'…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
};
const NAMED_RE          = new RegExp(Object.keys(NAMED_ENTITIES).join('|'), 'g');
const NUMERIC_ENTITY_RE = /&#(x[0-9a-f]+|\d+);/gi;
const DEFAULT_MAX_LEN   = 4000;   // long enough for tender notes / addresses; short of a DoS

function decodeNumericEntity(match, body) {
  const cp = body.startsWith('x') || body.startsWith('X')
    ? parseInt(body.slice(1), 16)
    : parseInt(body, 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return '';
  // Re-block control chars after decoding so &#0; can't smuggle a NUL.
  if (cp >= 0 && cp <= 31 && cp !== 0x09 && cp !== 0x0A) return '';
  if (cp === 0x7F) return '';
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/**
 * Sanitise a freeform string for storage in our JSON caches.
 * @param {*} value           Anything; non-strings return null.
 * @param {object} [opts]
 * @param {number} [opts.maxLen=4000]   Cap the result length.
 * @param {boolean}[opts.preserveNewlines=false]  If true, \n is kept; otherwise collapsed to space.
 * @returns {string|null}
 */
export function sanitizeText(value, opts = {}) {
  if (value == null) return null;
  if (typeof value !== 'string') value = String(value);
  if (!value) return '';

  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : DEFAULT_MAX_LEN;
  const preserveNewlines = !!opts.preserveNewlines;

  let out = value;

  // 1. Strip HTML tags — eliminates <script>, <img onerror=…>, <svg onload=…>,
  //    href="javascript:…" anchors, and any other markup. After this step the
  //    string is plain text by construction.
  out = out.replace(HTML_TAG_RE, ' ');

  // 2. Decode entities that survived. Do this AFTER tag stripping so
  //    "&lt;script&gt;" can't reconstitute into a tag.
  out = out.replace(NAMED_RE,         m => NAMED_ENTITIES[m] ?? '');
  out = out.replace(NUMERIC_ENTITY_RE, decodeNumericEntity);

  // 3. Strip control characters (NUL, BEL, etc.). Keep \n and \t.
  out = out.replace(CONTROL_CHARS_RE, ' ');

  // 4. Whitespace normalisation. Newlines either preserved or collapsed.
  if (preserveNewlines) {
    out = out.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  } else {
    out = out.replace(/\s+/g, ' ');
  }

  out = out.trim();

  // 5. Length cap.
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd() + '…';

  return out;
}

/**
 * Recursively sanitise every string field of an object/array. Used for
 * ingesting structured records (e.g. a JSON tender row) without having to
 * hand-pick fields. Non-string leaves are returned untouched.
 */
export function sanitizeRecord(value, opts = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeText(value, opts);
  if (Array.isArray(value)) return value.map(v => sanitizeRecord(v, opts));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeRecord(v, opts);
    return out;
  }
  return value;
}
