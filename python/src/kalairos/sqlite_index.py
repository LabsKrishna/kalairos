"""SqliteStreamer — streams JSONL appends into the derived SQLite read index.

Mirrors `store/sqlite-index.js`: schema v1, WAL mode with the §11 PRAGMA
set, and (in subsequent sub-PRs) the READY/REPLAY/REBUILD boot decision
tree, stream-rebuild, replay-forward, and live-write apply path.

Contract (the one rule we never break):
  Every row in this database was first in JSONL. SQLite is a derived,
  rebuildable cache.

Phase 1.2.1 lands the connection lifecycle and schema. Streaming and
applying entities follow in Phase 1.2.2+.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .schema import SCHEMA_VERSION

# PRAGMA configuration (spec §11). Applied on every open(); order matters
# — journal_mode first so WAL is in effect before any DDL, then synchronous
# and the rest.
#
# `synchronous = NORMAL` (not FULL) is deliberate: durability of the
# *derived* index is not load-bearing because JSONL is canonical. If a
# SQLite commit isn't fully fsynced and the process crashes, the boot
# decision tree catches the mismatch via meta.last_jsonl_offset and replays
# forward. We trade one fsync per write for the activation-burst latency
# budget.
PRAGMAS = (
    "journal_mode = WAL",
    "synchronous = NORMAL",
    "wal_autocheckpoint = 1000",
    "temp_store = MEMORY",
    "mmap_size = 268435456",
    "cache_size = -65536",
    "foreign_keys = OFF",
)

# Schema v1 (spec §3) — verbatim mirror of SCHEMA_V1_SQL in
# store/sqlite-index.js. Kept literally rather than abstracted into Python
# objects so any drift from the JS side shows up as a string-level mismatch
# in the smoke-test drift check.
SCHEMA_V1_SQL = """
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
"""


def apply_schema_v1(db: sqlite3.Connection) -> None:
    """Apply schema v1 DDL. Idempotent (every CREATE is IF NOT EXISTS).

    Seeds `meta.schema_version` with INSERT OR IGNORE so a future migration
    that has already written there isn't clobbered.
    """
    db.executescript(SCHEMA_V1_SQL)
    db.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
        ("schema_version", SCHEMA_VERSION),
    )
    db.commit()


class SqliteStreamer:
    """Connection lifecycle for the SQLite read index over canonical JSONL.

    Phase 1.2.1: open / close / health_check + schema v1.
    Phase 1.2.2+: stream-rebuild, replay-forward, apply-entity, decision tree.
    """

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.db: sqlite3.Connection | None = None
        self._open_path: str | None = None

    def open(self) -> None:
        """Open the SQLite index. Idempotent for the same path; raises if
        called with a different path while already open — there's only one
        canonical SQLite file per Kalairos store."""
        path_str = str(self.path)
        if self.db is not None:
            if self._open_path == path_str:
                return
            raise RuntimeError(
                f"SqliteStreamer.open: already open at {self._open_path!r}, "
                f"refusing to reopen at {path_str!r}"
            )
        # isolation_level=None means we manage BEGIN/COMMIT explicitly — the
        # apply-entity and truncate-and-replay paths (Phase 1.2.4+) need
        # explicit transaction frames.
        db = sqlite3.connect(path_str, isolation_level=None)
        for pragma in PRAGMAS:
            db.execute(f"PRAGMA {pragma}")
        apply_schema_v1(db)
        self.db = db
        self._open_path = path_str

    def close(self) -> None:
        if self.db is None:
            return
        try:
            self.db.close()
        finally:
            self.db = None
            self._open_path = None

    def health_check(self) -> dict:
        """Diagnostic snapshot of the index state. Used by tests verifying
        the PRAGMAs took effect and by future CLI status commands.

        For `:memory:` databases SQLite silently downgrades journal_mode
        from `wal` to `memory` — WAL is a file-level mode. Treat both as
        healthy.
        """
        if self.db is None:
            return {"open": False}
        journal_mode = self.db.execute("PRAGMA journal_mode").fetchone()[0]
        synchronous = self.db.execute("PRAGMA synchronous").fetchone()[0]
        return {
            "open": True,
            "path": self._open_path,
            "journal_mode": journal_mode,
            "synchronous": synchronous,
            "schema_version": self._meta("schema_version"),
        }

    def _meta(self, key: str) -> str | None:
        if self.db is None:
            return None
        row = self.db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None
