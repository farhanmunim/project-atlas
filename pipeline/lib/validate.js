/**
 * validate.js — pre-land data-quality gate.
 *
 * "Validate before it lands" (claude.md). Builders run a batch of assertions on
 * the data they're about to write; any failure throws a ValidationError, which
 * the orchestrator treats as a failed dataset — the LAST-GOOD file is kept and
 * the bad batch never poisons the store.
 *
 * These are cheap structural/sanity checks, not a schema engine: row counts in
 * range, required fields present, numbers finite, no all-null columns.
 */

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = "ValidationError"; }
}

export function check(cond, msg) {
  if (!cond) throw new ValidationError(msg);
}

/** Array with a row count within [min, max] (max optional). */
export function rowsWithin(arr, min, max, label = "rows") {
  check(Array.isArray(arr), `${label}: expected an array`);
  check(arr.length >= min, `${label}: ${arr.length} < min ${min}`);
  if (max != null) check(arr.length <= max, `${label}: ${arr.length} > max ${max}`);
  return arr;
}

/** Every item has all `fields` present (not undefined/null). */
export function everyHas(arr, fields, label = "rows") {
  for (let i = 0; i < arr.length; i++) {
    for (const f of fields) {
      check(arr[i][f] !== undefined && arr[i][f] !== null, `${label}[${i}]: missing "${f}"`);
    }
  }
  return arr;
}

/** Guard against a silently-empty column (e.g. every lat became null). */
export function notAllNull(arr, field, label = "rows") {
  if (!arr.length) return arr;
  const someValue = arr.some((r) => r[field] !== undefined && r[field] !== null);
  check(someValue, `${label}: column "${field}" is entirely null`);
  return arr;
}

export function finiteNumber(n, label) {
  check(typeof n === "number" && Number.isFinite(n), `${label}: not a finite number (${n})`);
  return n;
}
