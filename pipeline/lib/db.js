/**
 * db.js — the SQLite warehouse (zero-dependency, built-in node:sqlite).
 *
 * Captures EVERY datapoint we touch — periodic pipeline pulls AND live tool
 * refreshes — using change-data-capture so we store everything without
 * duplicating unchanged values:
 *
 *   observation  — one row EVERY time we touch an entity (what/when/hash/kind).
 *                  Nothing is ever ignored; this is the "we saw it" log.
 *   snapshot     — the actual data, written only when the hash CHANGES vs the
 *                  last value (deduped history → full timeline, bounded growth).
 *   current      — fast latest-value lookup per entity.
 *   run          — one row per ingest run (provenance).
 *
 * Entity = (entity_type, entity_id), e.g. ('line_status','73'), ('tender','2017'),
 * ('route_geometry','33:1'). The schema is generic so any datapoint fits.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "./store.js";

export const DB_PATH = path.join(DATA_DIR, "transit.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observation(
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, value_hash TEXT NOT NULL,
  kind TEXT NOT NULL, changed INTEGER NOT NULL, run_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_obs ON observation(entity_type, entity_id, observed_at);
CREATE TABLE IF NOT EXISTS snapshot(
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, value_hash TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, value_hash)
);
CREATE INDEX IF NOT EXISTS ix_snap ON snapshot(entity_type, entity_id, observed_at);
CREATE TABLE IF NOT EXISTS current(
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, value_hash TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS run(
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, kind TEXT NOT NULL, note TEXT
);
`;

function hashOf(data) { return createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 16); }

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  // WAL + busy_timeout: the server (live ingest) and the pipeline (periodic
  // mirror) can both open the DB; WAL allows concurrent readers and the timeout
  // makes the single writer wait rather than throw SQLITE_BUSY.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const insObs = db.prepare("INSERT INTO observation(entity_type,entity_id,observed_at,value_hash,kind,changed,run_id) VALUES(?,?,?,?,?,?,?)");
  const insSnap = db.prepare("INSERT OR IGNORE INTO snapshot(entity_type,entity_id,observed_at,value_hash,data) VALUES(?,?,?,?,?)");
  const upCur = db.prepare(`INSERT INTO current(entity_type,entity_id,observed_at,value_hash,data) VALUES(?,?,?,?,?)
    ON CONFLICT(entity_type,entity_id) DO UPDATE SET observed_at=excluded.observed_at, value_hash=excluded.value_hash, data=excluded.data`);
  const getCur = db.prepare("SELECT value_hash FROM current WHERE entity_type=? AND entity_id=?");
  const insRun = db.prepare("INSERT INTO run(started_at,kind,note) VALUES(?,?,?)");

  return {
    db,
    startRun(kind, note = null, at = new Date().toISOString()) { return Number(insRun.run(at, kind, note).lastInsertRowid); },
    /** Observe one datapoint. Always logs; snapshots only on change. Returns {changed}. */
    observe(entityType, entityId, data, { observedAt = new Date().toISOString(), kind = "periodic", runId = null } = {}) {
      const h = hashOf(data);
      const prev = getCur.get(entityType, String(entityId));
      const changed = !prev || prev.value_hash !== h;
      if (changed) {
        const json = JSON.stringify(data);
        insSnap.run(entityType, String(entityId), observedAt, h, json);
        upCur.run(entityType, String(entityId), observedAt, h, json);
      }
      insObs.run(entityType, String(entityId), observedAt, h, kind, changed ? 1 : 0, runId);
      return { changed };
    },
    /** Observe many [{id,data}] in one transaction. Returns {seen, changed}. */
    observeMany(entityType, items, opts = {}) {
      let changed = 0;
      this.db.exec("BEGIN");
      try { for (const it of items) { if (this.observe(entityType, it.id, it.data, opts).changed) changed++; } this.db.exec("COMMIT"); }
      catch (e) { this.db.exec("ROLLBACK"); throw e; }
      return { seen: items.length, changed };
    },
    /** Latest value for every entity of a type → [{id, data}]. */
    allCurrent(entityType) {
      return db.prepare("SELECT entity_id id, data, observed_at FROM current WHERE entity_type=?").all(entityType)
        .map((r) => ({ id: r.id, observedAt: r.observed_at, data: JSON.parse(r.data) }));
    },
    /** Most recent observed_at across the whole warehouse (for freshness). */
    latestObservedAt() { return db.prepare("SELECT max(observed_at) m FROM current").get().m; },
    stats() {
      const obs = db.prepare("SELECT count(*) c FROM observation").get().c;
      const snap = db.prepare("SELECT count(*) c FROM snapshot").get().c;
      const cur = db.prepare("SELECT count(*) c FROM current").get().c;
      const byType = db.prepare("SELECT entity_type, count(*) c FROM current GROUP BY entity_type ORDER BY c DESC").all();
      return { observations: obs, snapshots: snap, entities: cur, byType };
    },
    close() { db.close(); },
  };
}
