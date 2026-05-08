// store/sqlite-index.js — SQLite-backed index over the canonical JSONL store.
// See docs/storage-architecture-jsonl-sqlite-hybrid.md for the full design.
//
// Contract (the one rule we never break):
//   Every row in this database was first in JSONL. SQLite is a derived,
//   rebuildable cache. If it disappears, `rebuildFrom(jsonlPath)` (KAL-104)
//   reconstructs it deterministically.
//
// This file currently provides:
//   * Connection lifecycle (open/close/healthCheck) with the §11 PRAGMAs.
//   * applySchemaV1(db) — the v1 DDL from spec §3, idempotent.
//
// Write path, boot decision tree, rebuild, query API land in later tickets.
"use strict";

const Database = require("better-sqlite3");

// ── PRAGMA configuration (spec §11) ─────────────────────────────────────────
// Applied immediately on every open(). Order matters: journal_mode first so
// WAL is in effect before any DDL, then synchronous and the rest.
//
// `synchronous = NORMAL` (not FULL) is deliberate: durability of the *derived*
// index is not load-bearing — JSONL is canonical. If a SQLite commit isn't
// fully fsynced and the process crashes, the boot decision tree (§6.2)
// catches the mismatch via last_jsonl_offset and replays forward. We trade
// one fsync per write for the activation-burst latency budget.
const PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "wal_autocheckpoint = 1000",
  "temp_store = MEMORY",
  "mmap_size = 268435456",   // 256 MB
  "cache_size = -65536",     // 64 MB (negative = KiB)
  "foreign_keys = OFF",
];

// ── Schema v1 (spec §3) ─────────────────────────────────────────────────────
// Embedded as a single SQL string so it executes in one parse pass and stays
// readable as a unit. All statements are idempotent (`IF NOT EXISTS`) so
// re-applying on an existing DB is a no-op.
const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  namespace       TEXT NOT NULL,
  type            TEXT,
  workspace_id    TEXT,
  tags            TEXT,
  trust_score     REAL,
  confidence      REAL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  deleted_by      TEXT,
  source_turn_id  TEXT,
  jsonl_offset    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_namespace      ON facts(namespace);
CREATE INDEX IF NOT EXISTS idx_facts_workspace      ON facts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_facts_updated        ON facts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_live_recent    ON facts(deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS fact_versions (
  fact_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,
  text         TEXT NOT NULL,
  trust_score  REAL,
  written_at   INTEGER NOT NULL,
  jsonl_offset INTEGER NOT NULL,
  PRIMARY KEY (fact_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_written ON fact_versions(written_at DESC);

CREATE TABLE IF NOT EXISTS links (
  src_id      TEXT NOT NULL,
  dst_id      TEXT NOT NULL,
  kind        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  text, tags,
  content='facts',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO facts_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SCHEMA_VERSION = "1";

// applySchemaV1 is exported separately so rebuild paths (KAL-104) can apply
// the same DDL to a freshly-created tmp DB without going through open().
// INSERT OR IGNORE on schema_version preserves whatever migrations may
// have written there in the future; for v1 it's just a seed.
function applySchemaV1(db) {
  db.exec(SCHEMA_V1_SQL);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
    .run("schema_version", SCHEMA_VERSION);
}

class SqliteIndex {
  constructor() {
    this.db = null;
    this.path = null;
  }

  // Open the index at `path`. Idempotent: a second call with the same path
  // is a no-op; a call with a *different* path while already open throws —
  // there's only one canonical SQLite file per Kalairos store.
  open(path) {
    if (this.db) {
      if (this.path === path) return;
      throw new Error(
        `SqliteIndex.open: already open at ${this.path}, refusing to reopen at ${path}`
      );
    }
    const db = new Database(path);
    for (const p of PRAGMAS) db.pragma(p);
    applySchemaV1(db);
    this.db = db;
    this.path = path;
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally {
      this.db = null;
      this.path = null;
    }
  }

  // Diagnostic snapshot. Used by KAL-112 (`npx kalairos index status`) and
  // by tests verifying that PRAGMAs took effect.
  // For `:memory:` DBs, journal_mode reports "memory" — WAL is a file-level
  // mode and silently downgraded by SQLite. Treat both as healthy.
  healthCheck() {
    if (!this.db) return { open: false };
    const journalMode   = this.db.pragma("journal_mode", { simple: true });
    const synchronous   = this.db.pragma("synchronous", { simple: true });
    const schemaVersion = this._meta("schema_version");
    return {
      open: true,
      path: this.path,
      journalMode,
      synchronous,
      schemaVersion,
    };
  }

  _meta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }
}

module.exports = { SqliteIndex, applySchemaV1, SCHEMA_VERSION };
