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
//   * rebuild({ jsonlPath, sqlitePath }) — stream-rebuild from JSONL with
//     tmp-DB + atomic rename for crash safety (KAL-104, spec §7).
//   * decideOnBoot({ jsonlPath, sqlitePath }) — the §6.2 8-branch decision
//     tree returning READY / REPLAY / REBUILD (KAL-106). Pure, no mutations.
//   * replayForward({ jsonlPath, sqlitePath }) — apply only the JSONL bytes
//     beyond meta.last_jsonl_offset, in one transaction (KAL-107).
//
// Write path, query API land in later tickets.
"use strict";

const Database = require("better-sqlite3");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const readline = require("readline");

const { normalizeRaw } = require("./entity-normalizer");
const PKG_VERSION = require("../package.json").version;

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

  // Stream-rebuild this index from a JSONL file (spec §7). Closes self if
  // open, builds at `<sqlitePath>.rebuild`, atomic-renames into place. Does
  // NOT auto-open the new file — caller decides when to re-open.
  //
  // sqlitePath defaults to this.path so the spec's single-arg signature
  // (`idx.rebuildFrom(jsonlPath)`) works after a prior open(). Tests and
  // the boot decision tree (KAL-106) use the explicit two-arg form.
  // Marked `async` so a missing-target validation error rejects the returned
  // Promise instead of throwing synchronously — callers should never have to
  // straddle both sync throws and promise rejections from the same method.
  async rebuildFrom(jsonlPath, sqlitePath) {
    const target = sqlitePath ?? this.path;
    if (!target) {
      throw new Error("SqliteIndex.rebuildFrom: sqlitePath required (no instance path set)");
    }
    if (this.db) this.close();
    return rebuild({ jsonlPath, sqlitePath: target });
  }

  _meta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }
}

// ── Rebuild from JSONL (KAL-104, spec §7) ───────────────────────────────────
//
// Crash-safety strategy: build at `<sqlitePath>.rebuild`, fsync, rename into
// place. fs.renameSync is the only filesystem primitive that's crash-atomic
// across platforms we care about (POSIX guarantees it; Windows MoveFileEx
// gets close enough — same trade as the existing JSONL rewrite path in
// store/file-store.js). If we crash mid-build, the canonical SQLite file is
// untouched; the orphan `.rebuild` is reaped on the next attempt or by the
// boot decision tree.
//
// We deliberately do NOT use WAL on the tmp DB during rebuild — WAL leaves
// `-wal` and `-shm` siblings that complicate the rename swap. The rebuild
// runs in journal_mode=DELETE so all bytes land in the single tmp file
// before rename. After rename, the next SqliteIndex.open() flips it back
// to WAL automatically.
const REBUILD_PRAGMAS = [
  "journal_mode = DELETE",
  "synchronous = NORMAL",
  "temp_store = MEMORY",
  "cache_size = -65536",
  "foreign_keys = OFF",
];

async function rebuild({ jsonlPath, sqlitePath }) {
  const tmpPath = sqlitePath + ".rebuild";

  // Reap any orphan `.rebuild` from a prior crashed attempt before we open
  // a new connection on it. Same self-heal pattern as store/file-store.js.
  _safeUnlink(tmpPath);
  _safeUnlink(tmpPath + "-wal");
  _safeUnlink(tmpPath + "-shm");

  const jsonlExists  = fs.existsSync(jsonlPath);
  const jsonlSize    = jsonlExists ? fs.statSync(jsonlPath).size : 0;
  const jsonlSha     = jsonlExists ? _sha256First4kb(jsonlPath) : "";

  const tmpDb = new Database(tmpPath);
  for (const p of REBUILD_PRAGMAS) tmpDb.pragma(p);
  applySchemaV1(tmpDb);

  const stmts = _prepareWriteStmts(tmpDb);

  tmpDb.exec("BEGIN IMMEDIATE");
  let lastOffset = 0;
  let rowsApplied = 0;
  try {
    if (jsonlExists && jsonlSize > 0) {
      const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
      const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let offset = 0;
      for await (const line of rl) {
        const lineStart = offset;
        offset += Buffer.byteLength(line, "utf8") + 1;
        if (!line) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          console.warn(`[kalairos] sqlite-index: skipping malformed JSONL line at offset ${lineStart}`);
          continue;
        }
        try {
          const entity = normalizeRaw(raw);
          _applyEntity(stmts, entity, lineStart);
          rowsApplied++;
        } catch (err) {
          console.warn(`[kalairos] sqlite-index: skipping unindexable entity ${raw?.id}: ${err.message}`);
        }
      }
      lastOffset = offset;
    }

    // Meta is written exactly once at the end of the txn so a partial rebuild
    // never leaves stale meta visible (the orphan tmp DB gets reaped instead).
    stmts.upsertMeta.run("jsonl_path",             String(jsonlPath));
    stmts.upsertMeta.run("jsonl_size_bytes",       String(jsonlSize));
    stmts.upsertMeta.run("jsonl_sha256_first_4kb", jsonlSha);
    stmts.upsertMeta.run("last_jsonl_offset",      String(lastOffset));
    stmts.upsertMeta.run("kalairos_version",       String(PKG_VERSION));
    stmts.upsertMeta.run("index_built_at",         String(Date.now()));
    stmts.upsertMeta.run("dirty",                  "0");

    tmpDb.exec("COMMIT");
  } catch (err) {
    try { tmpDb.exec("ROLLBACK"); } catch {}
    tmpDb.close();
    _safeUnlink(tmpPath);
    throw err;
  }

  tmpDb.close();
  fs.renameSync(tmpPath, sqlitePath);
  _fsyncDir(path.dirname(sqlitePath));

  return { rowsApplied, jsonlSize, lastOffset };
}

function _prepareWriteStmts(db) {
  return {
    insertFact: db.prepare(`
      INSERT INTO facts (
        id, text, namespace, type, workspace_id, tags,
        trust_score, confidence, created_at, updated_at,
        deleted_at, deleted_by, source_turn_id, jsonl_offset
      ) VALUES (
        @id, @text, @namespace, @type, @workspace_id, @tags,
        @trust_score, @confidence, @created_at, @updated_at,
        @deleted_at, @deleted_by, @source_turn_id, @jsonl_offset
      )
      ON CONFLICT(id) DO UPDATE SET
        text           = excluded.text,
        namespace      = excluded.namespace,
        type           = excluded.type,
        workspace_id   = excluded.workspace_id,
        tags           = excluded.tags,
        trust_score    = excluded.trust_score,
        confidence     = excluded.confidence,
        created_at     = excluded.created_at,
        updated_at     = excluded.updated_at,
        deleted_at     = excluded.deleted_at,
        deleted_by     = excluded.deleted_by,
        source_turn_id = excluded.source_turn_id,
        jsonl_offset   = excluded.jsonl_offset
    `),
    insertVersion: db.prepare(`
      INSERT OR REPLACE INTO fact_versions (
        fact_id, version, text, trust_score, written_at, jsonl_offset
      ) VALUES (
        @fact_id, @version, @text, @trust_score, @written_at, @jsonl_offset
      )
    `),
    insertLink: db.prepare(`
      INSERT OR IGNORE INTO links (src_id, dst_id, kind, created_at)
      VALUES (@src_id, @dst_id, @kind, @created_at)
    `),
    upsertMeta: db.prepare(`
      INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)
    `),
  };
}

function _applyEntity(stmts, raw, jsonlOffset) {
  const id      = String(raw.id);
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  // After normalizeRaw, versions are newest-first. SQLite stores them
  // oldest-first with version=1 for the original write, matching the
  // natural reading order of the audit trail.
  const oldestFirst = [...versions].reverse();
  const createdAt = oldestFirst[0]?.timestamp ?? 0;
  const updatedAt = versions[0]?.timestamp ?? createdAt;

  stmts.insertFact.run({
    id,
    text:           String(raw.text ?? ""),
    namespace:      String(raw.memoryType),
    type:           raw.type ?? null,
    workspace_id:   raw.workspaceId ?? null,
    tags:           JSON.stringify(raw.tags ?? []),
    trust_score:    Number.isFinite(raw.trustScore) ? raw.trustScore : null,
    confidence:     null,
    created_at:     createdAt,
    updated_at:     updatedAt,
    deleted_at:     raw.deletedAt ?? null,
    deleted_by:     raw.deletedBy ?? null,
    source_turn_id: null,
    jsonl_offset:   jsonlOffset,
  });

  for (let i = 0; i < oldestFirst.length; i++) {
    const v = oldestFirst[i];
    stmts.insertVersion.run({
      fact_id:      id,
      version:      i + 1,
      text:         String(v.text ?? raw.text ?? ""),
      trust_score:  Number.isFinite(v.trustScore) ? v.trustScore
                  : Number.isFinite(raw.trustScore) ? raw.trustScore
                  : null,
      written_at:   v.timestamp ?? v.ingestAt ?? 0,
      jsonl_offset: jsonlOffset,
    });
  }

  // Legacy entity links carry no per-link kind. We use a stable sentinel
  // ("related") so the (src_id, dst_id, kind) PK is well-defined and
  // deterministic across rebuilds. KAL-108+ may introduce typed kinds.
  if (raw.links && typeof raw.links.forEach === "function") {
    raw.links.forEach(dst => {
      stmts.insertLink.run({
        src_id:     id,
        dst_id:     String(dst),
        kind:       "related",
        created_at: createdAt,
      });
    });
  }
}

function _sha256First4kb(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n   = fs.readSync(fd, buf, 0, 4096, 0);
    return crypto.createHash("sha256").update(buf.subarray(0, n)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function _fsyncDir(dir) {
  // Best-effort. Mirrors store/file-store.js — see that file for the
  // platform exception list rationale.
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    if (err.code !== "EISDIR" && err.code !== "ENOTSUP" && err.code !== "EPERM") throw err;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function _safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (err) { if (err.code !== "ENOENT") throw err; }
}

// ── Boot decision tree (KAL-106, spec §6.2) ─────────────────────────────────
//
// Pure decision — no state mutations. Returns one of:
//   { action: "READY",   reason, ... }
//   { action: "REPLAY",  reason, lastOffset, sizeNow, ... }
//   { action: "REBUILD", reason, ... }
//
// Evaluation order is locked by spec §6.2: a → b → h → c → d → e → g → f.
// The first matching branch short-circuits.
//
// Pass `quiet: true` to suppress the structured log line — the function still
// returns the decision object. Used by tests to keep output readable.
function decideOnBoot({ jsonlPath, sqlitePath, quiet = false }) {
  // Branch a — SQLite missing entirely (first run, deleted file).
  if (!fs.existsSync(sqlitePath)) {
    return _logDecision({ action: "REBUILD", reason: "sqlite-missing", sqlitePath }, quiet);
  }

  // Compute current JSONL state. Missing JSONL is treated as size=0 / hash="";
  // downstream branches surface the divergence.
  const jsonlExists = fs.existsSync(jsonlPath);
  const sizeNow     = jsonlExists ? fs.statSync(jsonlPath).size : 0;
  const sha256Now   = jsonlExists && sizeNow > 0 ? _sha256First4kb(jsonlPath) : "";

  // Read meta read-only — this is a pure decision.
  let meta;
  try {
    const db = new Database(sqlitePath, { readonly: true });
    try {
      meta = _readBootMeta(db);
    } finally {
      db.close();
    }
  } catch (err) {
    // Corrupt header, missing tables, or any other open failure — rebuild.
    return _logDecision({ action: "REBUILD", reason: "sqlite-open-failed", error: err.message }, quiet);
  }

  // Branch b — schema-version drift; future-proofs migrations.
  if (meta.schema_version !== SCHEMA_VERSION) {
    return _logDecision({ action: "REBUILD", reason: "schema-version-mismatch",
                          expected: SCHEMA_VERSION, actual: meta.schema_version }, quiet);
  }

  // Branch h — last write to SQLite failed; meta.dirty was set by the write
  // path (KAL-108). Order h before c/d/e/g per §6.2: dirty trumps any size
  // comparison since we don't trust the index's claimed offset.
  if (meta.dirty === "1") {
    return _logDecision({ action: "REBUILD", reason: "dirty-flag-set" }, quiet);
  }

  // Branch c — different JSONL than this index was built from.
  if (meta.jsonl_path !== jsonlPath) {
    return _logDecision({ action: "REBUILD", reason: "jsonl-path-mismatch",
                          expected: jsonlPath, actual: meta.jsonl_path }, quiet);
  }

  // Branch d — JSONL replaced or edited at the start. SQLite offsets may now
  // point at stale bytes; only safe move is rebuild.
  if (meta.jsonl_sha256_first_4kb !== sha256Now) {
    return _logDecision({ action: "REBUILD", reason: "jsonl-hash-mismatch",
                          expected: meta.jsonl_sha256_first_4kb, actual: sha256Now }, quiet);
  }

  const metaSize = parseInt(meta.jsonl_size_bytes ?? "0", 10);

  // Branch e — JSONL shrunk. Either truncation or replacement; either way the
  // index claims to know offsets that no longer exist.
  if (sizeNow < metaSize) {
    return _logDecision({ action: "REBUILD", reason: "jsonl-shrunk", sizeNow, metaSize }, quiet);
  }

  // Branch g — JSONL grew (external append). Replay only the new lines.
  if (sizeNow > metaSize) {
    return _logDecision({ action: "REPLAY", reason: "jsonl-grew",
                          sizeNow, metaSize, lastOffset: metaSize }, quiet);
  }

  // Branch f — same path, same hash, same size, schema match, not dirty.
  return _logDecision({ action: "READY", reason: "in-sync", sizeNow }, quiet);
}

function _readBootMeta(db) {
  const rows = db.prepare(
    "SELECT key, value FROM meta WHERE key IN ('schema_version','jsonl_path','jsonl_sha256_first_4kb','jsonl_size_bytes','dirty')"
  ).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function _logDecision(d, quiet) {
  if (!quiet) console.log(`[kalairos] sqlite-index: decision=${JSON.stringify(d)}`);
  return d;
}

// ── Replay-forward (KAL-107, spec §6.2 case g) ──────────────────────────────
//
// Open the live SQLite, seek to meta.last_jsonl_offset in JSONL, parse and
// apply only the newer bytes. One BEGIN IMMEDIATE / COMMIT around the whole
// run so a partial replay doesn't leave SQLite half-updated. Malformed lines
// are logged and skipped, matching loadRaw's behaviour.
async function replayForward({ jsonlPath, sqlitePath }) {
  const db = new Database(sqlitePath);
  for (const p of PRAGMAS) db.pragma(p);

  const startOffset = parseInt(
    db.prepare("SELECT value FROM meta WHERE key = 'last_jsonl_offset'").get()?.value ?? "0",
    10,
  );
  const sizeNow = fs.existsSync(jsonlPath) ? fs.statSync(jsonlPath).size : 0;

  if (sizeNow <= startOffset) {
    // Nothing to do — caller invoked replay on a no-op situation. Return a
    // shaped result so callers can branch without re-checking sizes.
    db.close();
    return { rowsApplied: 0, lastOffset: startOffset };
  }

  const stmts = _prepareWriteStmts(db);

  db.exec("BEGIN IMMEDIATE");
  let offset = startOffset;
  let rowsApplied = 0;
  try {
    const stream = fs.createReadStream(jsonlPath, { encoding: "utf8", start: startOffset });
    const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const lineStart = offset;
      offset += Buffer.byteLength(line, "utf8") + 1;
      if (!line) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        console.warn(`[kalairos] sqlite-index: replay skipping malformed JSONL line at offset ${lineStart}`);
        continue;
      }
      try {
        const entity = normalizeRaw(raw);
        _applyEntity(stmts, entity, lineStart);
        rowsApplied++;
      } catch (err) {
        console.warn(`[kalairos] sqlite-index: replay skipping unindexable entity ${raw?.id}: ${err.message}`);
      }
    }

    // Trust the file's actual size as the canonical end-of-replay marker —
    // line accounting can drift by one byte if the file omits a trailing
    // newline. fs.stat is authoritative.
    stmts.upsertMeta.run("jsonl_size_bytes",  String(sizeNow));
    stmts.upsertMeta.run("last_jsonl_offset", String(sizeNow));

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    throw err;
  }

  db.close();
  return { rowsApplied, lastOffset: sizeNow };
}

module.exports = {
  SqliteIndex,
  applySchemaV1,
  rebuild,
  decideOnBoot,
  replayForward,
  SCHEMA_VERSION,
};
