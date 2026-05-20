"""SqliteStreamer — streams JSONL appends into the derived SQLite read index.

Mirrors `store/sqlite-index.js`: schema v1, WAL mode with the §11 PRAGMA
set, stream-rebuild from JSONL, and (in subsequent sub-PRs) the
READY/REPLAY/REBUILD boot decision tree, replay-forward, and live-write
apply path.

Contract (the one rule we never break):
  Every row in this database was first in JSONL. SQLite is a derived,
  rebuildable cache. If it disappears, `rebuild()` reconstructs it
  deterministically from JSONL.

Phase 1.2.1: open / close / health_check + schema v1.
Phase 1.2.3: _apply_entity + _sha256_first_4kb + rebuild() + rebuild_from().
Phase 1.2.4 (this file's current state): decide_on_boot + replay_forward.
Phase 1.2.5+: live-write apply path.
"""

from __future__ import annotations

import errno
import hashlib
import json
import logging
import math
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from .__about__ import __version__
from .entity_normalizer import normalize_raw
from .schema import (
    META_KEY_DIRTY,
    META_KEY_INDEX_BUILT_AT,
    META_KEY_JSONL_PATH,
    META_KEY_JSONL_SHA256_FIRST_4KB,
    META_KEY_JSONL_SIZE_BYTES,
    META_KEY_KALAIROS_VERSION,
    META_KEY_LAST_JSONL_OFFSET,
    META_KEY_SCHEMA_VERSION,
    SCHEMA_VERSION,
)

log = logging.getLogger(__name__)


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

# Rebuild-time PRAGMAs (spec §7). journal_mode = DELETE (not WAL) so the
# rebuild stays in a single file before the atomic rename swap; WAL leaves
# `-wal` and `-shm` siblings that complicate moving the DB into place.
# After rename, the next `open()` flips back to WAL automatically.
REBUILD_PRAGMAS = (
    "journal_mode = DELETE",
    "synchronous = NORMAL",
    "temp_store = MEMORY",
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


# ── Hashing / fingerprinting ────────────────────────────────────────────────


def _sha256_first_4kb(path: Path | str) -> str:
    """SHA-256 of the first 4 KiB of a file. Used by the boot decision
    tree as a cheap fingerprint to detect that JSONL has been *replaced*
    (versus appended-to) since the last open.

    Returns the hex digest. Reads at most 4096 bytes — large files are
    not hashed in full because we only need divergence detection, not
    integrity.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        chunk = f.read(4096)
        if chunk:
            h.update(chunk)
    return h.hexdigest()


# ── Apply entity to SQLite (UPSERT into facts/fact_versions/links) ──────────


def _apply_entity(db: sqlite3.Connection, raw: dict, jsonl_offset: int) -> None:
    """UPSERT one entity into facts/fact_versions/links.

    Mirrors `store/sqlite-index.js` _applyEntity step-for-step. Caller is
    responsible for the transaction frame — both rebuild() (single big txn)
    and the live-write path (per-write txn) use this helper.
    """
    eid = str(raw["id"])
    versions = raw.get("versions") or []
    # In JS the versions list is newest-first after normalize_raw; we walk
    # oldest-first for inserts so version=1 (oldest) lands first, matching
    # the natural reading order of the audit trail.
    oldest_first = list(reversed(versions))
    created_at = oldest_first[0].get("timestamp", 0) if oldest_first else 0
    updated_at = versions[0].get("timestamp", created_at) if versions else created_at

    db.execute(
        """
        INSERT INTO facts (
          id, text, namespace, type, workspace_id, tags,
          trust_score, confidence, created_at, updated_at,
          deleted_at, deleted_by, source_turn_id, jsonl_offset
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        """,
        (
            eid,
            str(raw.get("text") or ""),
            str(raw["memoryType"]),
            raw.get("type"),
            raw.get("workspaceId"),
            json.dumps(raw.get("tags") or []),
            _finite_or_none(raw.get("trustScore")),
            None,  # confidence — not populated in v1 spec
            int(created_at or 0),
            int(updated_at or 0),
            raw.get("deletedAt"),
            raw.get("deletedBy"),
            None,  # source_turn_id — not populated in v1 spec
            jsonl_offset,
        ),
    )

    for i, v in enumerate(oldest_first):
        v_trust = _finite_or_none(v.get("trustScore"))
        if v_trust is None:
            v_trust = _finite_or_none(raw.get("trustScore"))
        db.execute(
            """
            INSERT OR REPLACE INTO fact_versions (
              fact_id, version, text, trust_score, written_at, jsonl_offset
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                eid,
                i + 1,
                str(v.get("text") or raw.get("text") or ""),
                v_trust,
                int(v.get("timestamp") or v.get("ingestAt") or 0),
                jsonl_offset,
            ),
        )

    # Delete-before-insert keeps live re-writes correct: if a later JSONL
    # line drops a link, that drop must reflect in SQLite. On a rebuild,
    # the delete is a no-op for first visits.
    db.execute("DELETE FROM links WHERE src_id = ?", (eid,))
    # Legacy entity links carry no per-link kind. The sentinel "related"
    # keeps (src_id, dst_id, kind) PK well-defined and deterministic across
    # rebuilds.
    for dst in raw.get("links") or []:
        db.execute(
            """
            INSERT OR IGNORE INTO links (src_id, dst_id, kind, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (eid, str(dst), "related", int(created_at or 0)),
        )


# ── Stream-rebuild from JSONL ───────────────────────────────────────────────


def rebuild(jsonl_path: Path | str, sqlite_path: Path | str) -> dict:
    """Stream-rebuild a SQLite index from a canonical JSONL ledger.

    Crash-safety strategy mirrors store/sqlite-index.js's rebuild(): build
    at `<sqlite_path>.rebuild`, fsync, atomically rename into place. If
    the caller crashes mid-rebuild, the canonical SQLite file is untouched
    and the orphan `.rebuild` is reaped on the next attempt.

    Returns `{"rows_applied": N, "jsonl_size": K, "last_offset": L}`.
    """
    jsonl_path = Path(jsonl_path)
    sqlite_path = Path(sqlite_path)
    tmp_path = sqlite_path.parent / (sqlite_path.name + ".rebuild")

    # Reap orphan .rebuild + WAL/SHM siblings from a prior crashed attempt.
    for stale in (tmp_path, Path(f"{tmp_path}-wal"), Path(f"{tmp_path}-shm")):
        try:
            stale.unlink()
        except FileNotFoundError:
            pass

    jsonl_exists = jsonl_path.exists()
    jsonl_size = jsonl_path.stat().st_size if jsonl_exists else 0
    jsonl_sha = (
        _sha256_first_4kb(jsonl_path) if (jsonl_exists and jsonl_size > 0) else ""
    )

    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_db = sqlite3.connect(str(tmp_path), isolation_level=None)
    try:
        for pragma in REBUILD_PRAGMAS:
            tmp_db.execute(f"PRAGMA {pragma}")
        apply_schema_v1(tmp_db)

        rows_applied = 0
        last_offset = 0

        tmp_db.execute("BEGIN IMMEDIATE")
        try:
            if jsonl_exists and jsonl_size > 0:
                with open(jsonl_path, "rb") as f:
                    offset = 0
                    for line_bytes in f:
                        line_start = offset
                        offset += len(line_bytes)
                        line = line_bytes.rstrip(b"\n").decode("utf-8")
                        if not line:
                            continue
                        try:
                            raw = json.loads(line)
                        except json.JSONDecodeError:
                            log.warning(
                                "SqliteStreamer.rebuild: skipping malformed "
                                "JSONL line at offset %d",
                                line_start,
                            )
                            continue
                        try:
                            entity = normalize_raw(raw)
                            _apply_entity(tmp_db, entity, line_start)
                            rows_applied += 1
                        except Exception as e:
                            log.warning(
                                "SqliteStreamer.rebuild: skipping unindexable "
                                "entity %r: %s",
                                raw.get("id") if isinstance(raw, dict) else None,
                                e,
                            )
                    last_offset = offset

            # Meta written exactly once at the end of the txn so a partial
            # rebuild never leaves stale meta visible — the orphan tmp DB
            # gets reaped instead.
            _upsert_meta(tmp_db, META_KEY_JSONL_PATH, str(jsonl_path))
            _upsert_meta(tmp_db, META_KEY_JSONL_SIZE_BYTES, str(jsonl_size))
            _upsert_meta(tmp_db, META_KEY_JSONL_SHA256_FIRST_4KB, jsonl_sha)
            _upsert_meta(tmp_db, META_KEY_LAST_JSONL_OFFSET, str(last_offset))
            _upsert_meta(tmp_db, META_KEY_KALAIROS_VERSION, __version__)
            _upsert_meta(
                tmp_db, META_KEY_INDEX_BUILT_AT, str(int(time.time() * 1000))
            )
            _upsert_meta(tmp_db, META_KEY_DIRTY, "0")

            tmp_db.execute("COMMIT")
        except Exception:
            try:
                tmp_db.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            raise
    except Exception:
        tmp_db.close()
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise

    tmp_db.close()
    os.replace(tmp_path, sqlite_path)
    _fsync_dir(sqlite_path.parent)

    return {
        "rows_applied": rows_applied,
        "jsonl_size": jsonl_size,
        "last_offset": last_offset,
    }


# ── Boot decision tree (spec §6.2) ──────────────────────────────────────────


def decide_on_boot(
    jsonl_path: Path | str,
    sqlite_path: Path | str,
    *,
    quiet: bool = False,
) -> dict:
    """Pure boot decision over (jsonl_path, sqlite_path). No mutations.

    Returns one of:
      {"action": "READY",   "reason": ..., "size_now": int}
      {"action": "REPLAY",  "reason": ..., "last_offset": int, ...}
      {"action": "REBUILD", "reason": ..., ...}

    Evaluation order is locked by spec §6.2: a → b → h → c → d → e → g → f.
    First matching branch short-circuits. Branch h (dirty flag) is ordered
    *before* c/d/e/g because once dirty we can't trust the index's claimed
    offset — a size comparison against `meta.jsonl_size_bytes` would be
    against a stale value.

    `quiet=True` suppresses the structured info-level log line. Used by
    tests to keep output readable; production callers leave it False.
    """
    jsonl_path = Path(jsonl_path)
    sqlite_path = Path(sqlite_path)

    # Branch a — SQLite missing entirely (first run, or deleted file).
    if not sqlite_path.exists():
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "sqlite-missing",
                "sqlite_path": str(sqlite_path),
            },
            quiet,
        )

    # Compute current JSONL state. Missing JSONL is treated as size=0 /
    # hash=""; downstream branches surface the divergence cleanly.
    jsonl_exists = jsonl_path.exists()
    size_now = jsonl_path.stat().st_size if jsonl_exists else 0
    sha256_now = (
        _sha256_first_4kb(jsonl_path) if jsonl_exists and size_now > 0 else ""
    )

    # Read meta read-only. This is a pure decision — no SQLite writes.
    # Any open failure (corrupt header, missing tables, locked file) means
    # we can't trust the index → REBUILD.
    try:
        db = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
        try:
            meta = _read_boot_meta(db)
        finally:
            db.close()
    except sqlite3.Error as e:
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "sqlite-open-failed",
                "error": str(e),
            },
            quiet,
        )

    # Branch b — schema-version drift. Future-proofs migrations.
    if meta.get(META_KEY_SCHEMA_VERSION) != SCHEMA_VERSION:
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "schema-version-mismatch",
                "expected": SCHEMA_VERSION,
                "actual": meta.get(META_KEY_SCHEMA_VERSION),
            },
            quiet,
        )

    # Branch h — dirty bit from a failed write txn. Ordered before c/d/e/g
    # because once dirty we don't trust meta.last_jsonl_offset.
    if meta.get(META_KEY_DIRTY) == "1":
        return _log_decision(
            {"action": "REBUILD", "reason": "dirty-flag-set"}, quiet
        )

    # Branch c — different JSONL than this index was built from.
    if meta.get(META_KEY_JSONL_PATH) != str(jsonl_path):
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "jsonl-path-mismatch",
                "expected": str(jsonl_path),
                "actual": meta.get(META_KEY_JSONL_PATH),
            },
            quiet,
        )

    # Branch d — JSONL replaced or edited at the start. SQLite offsets may
    # now point at stale bytes; only safe move is rebuild.
    if (meta.get(META_KEY_JSONL_SHA256_FIRST_4KB) or "") != sha256_now:
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "jsonl-hash-mismatch",
                "expected": meta.get(META_KEY_JSONL_SHA256_FIRST_4KB),
                "actual": sha256_now,
            },
            quiet,
        )

    meta_size = int(meta.get(META_KEY_JSONL_SIZE_BYTES) or "0")

    # Branch e — JSONL shrunk (truncation or replacement). The index claims
    # to know offsets that no longer exist.
    if size_now < meta_size:
        return _log_decision(
            {
                "action": "REBUILD",
                "reason": "jsonl-shrunk",
                "size_now": size_now,
                "meta_size": meta_size,
            },
            quiet,
        )

    # Branch g — JSONL grew (external append). Replay only the new lines.
    if size_now > meta_size:
        return _log_decision(
            {
                "action": "REPLAY",
                "reason": "jsonl-grew",
                "size_now": size_now,
                "meta_size": meta_size,
                "last_offset": meta_size,
            },
            quiet,
        )

    # Branch f — same path, same hash, same size, schema match, not dirty.
    return _log_decision(
        {"action": "READY", "reason": "in-sync", "size_now": size_now},
        quiet,
    )


def _read_boot_meta(db: sqlite3.Connection) -> dict:
    """Pluck just the keys the boot decision tree reads."""
    rows = db.execute(
        """
        SELECT key, value FROM meta WHERE key IN (
          'schema_version',
          'jsonl_path',
          'jsonl_sha256_first_4kb',
          'jsonl_size_bytes',
          'dirty'
        )
        """
    ).fetchall()
    return {key: value for key, value in rows}


def _log_decision(decision: dict, quiet: bool) -> dict:
    if not quiet:
        log.info("SqliteStreamer.decide_on_boot: %s", decision)
    return decision


# ── Replay-forward (spec §6.2 case g) ───────────────────────────────────────


def replay_forward(
    jsonl_path: Path | str, sqlite_path: Path | str
) -> dict:
    """Apply only the JSONL bytes beyond `meta.last_jsonl_offset` into the
    SQLite index. One BEGIN IMMEDIATE / COMMIT around the whole run so a
    partial replay never leaves SQLite half-updated.

    Returns `{"rows_applied": int, "last_offset": int}`. Caller is expected
    to have established via `decide_on_boot` that REPLAY is the correct
    action; this function does not re-check the decision.
    """
    jsonl_path = Path(jsonl_path)
    sqlite_path = Path(sqlite_path)

    db = sqlite3.connect(str(sqlite_path), isolation_level=None)
    try:
        for pragma in PRAGMAS:
            db.execute(f"PRAGMA {pragma}")

        row = db.execute(
            "SELECT value FROM meta WHERE key = ?",
            (META_KEY_LAST_JSONL_OFFSET,),
        ).fetchone()
        start_offset = int(row[0]) if row else 0

        size_now = jsonl_path.stat().st_size if jsonl_path.exists() else 0
        if size_now <= start_offset:
            # No-op situation. Shape a result so callers don't have to
            # re-check sizes before branching.
            return {"rows_applied": 0, "last_offset": start_offset}

        rows_applied = 0
        offset = start_offset

        db.execute("BEGIN IMMEDIATE")
        try:
            with open(jsonl_path, "rb") as f:
                f.seek(start_offset)
                for line_bytes in f:
                    line_start = offset
                    offset += len(line_bytes)
                    line = line_bytes.rstrip(b"\n").decode("utf-8")
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        log.warning(
                            "SqliteStreamer.replay_forward: skipping malformed "
                            "JSONL line at offset %d",
                            line_start,
                        )
                        continue
                    try:
                        entity = normalize_raw(raw)
                        _apply_entity(db, entity, line_start)
                        rows_applied += 1
                    except Exception as e:
                        log.warning(
                            "SqliteStreamer.replay_forward: skipping "
                            "unindexable entity %r: %s",
                            raw.get("id") if isinstance(raw, dict) else None,
                            e,
                        )

            # Trust the file's actual size as the canonical end-of-replay
            # marker — line accounting can drift by one byte if the file
            # omits a trailing newline. stat() is authoritative.
            _upsert_meta(db, META_KEY_JSONL_SIZE_BYTES, str(size_now))
            _upsert_meta(db, META_KEY_LAST_JSONL_OFFSET, str(size_now))

            db.execute("COMMIT")
        except Exception:
            try:
                db.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            raise

        return {"rows_applied": rows_applied, "last_offset": size_now}
    finally:
        db.close()


# ── Helpers ─────────────────────────────────────────────────────────────────


def _upsert_meta(db: sqlite3.Connection, key: str, value: str) -> None:
    db.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value)
    )


def _finite_or_none(x: Any):
    """Return x if it's a finite number, else None — matches the JS
    `Number.isFinite(x) ? x : null` check used at SQLite-write time."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        if math.isnan(x) or math.isinf(x):
            return None
        return x
    return None


# Errnos tolerated when fsyncing a directory. Mirrors
# python/src/kalairos/jsonl.py — Windows can't open a directory for read at
# all (EACCES); some filesystems return ENOTSUP / EINVAL when fsyncing a
# directory fd. Anything else surfaces.
_DIR_FSYNC_OK = frozenset(
    {errno.EACCES, errno.EISDIR, errno.EINVAL, errno.ENOTSUP, errno.EPERM}
)


def _fsync_dir(dir_path: Path) -> None:
    """Best-effort fsync of a directory after a rename. Mirrors
    python/src/kalairos/jsonl.py — see that file for the platform exception
    list rationale."""
    try:
        fd = os.open(dir_path, os.O_RDONLY)
    except OSError as e:
        if e.errno in _DIR_FSYNC_OK:
            return
        raise
    try:
        try:
            os.fsync(fd)
        except OSError as e:
            if e.errno not in _DIR_FSYNC_OK:
                raise
    finally:
        os.close(fd)


# ── SqliteStreamer class ────────────────────────────────────────────────────


class SqliteStreamer:
    """Connection lifecycle for the SQLite read index over canonical JSONL.

    Phase 1.2.1: open / close / health_check + schema v1.
    Phase 1.2.3 (current): + `rebuild_from()` (close + standalone rebuild).
    Phase 1.2.4+: boot decision tree, replay-forward, live-write apply path.
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
        # isolation_level=None means we manage BEGIN/COMMIT explicitly —
        # the apply-entity and truncate-and-replay paths (Phase 1.2.4+)
        # need explicit transaction frames.
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
        """Diagnostic snapshot of the index state. For `:memory:` SQLite
        silently downgrades journal_mode from `wal` to `memory` — treat
        both as healthy."""
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

    def rebuild_from(
        self, jsonl_path: Path | str, sqlite_path: Path | str | None = None
    ) -> dict:
        """Rebuild this index from `jsonl_path`. Defaults `sqlite_path` to
        `self.path` so the common case (`idx.rebuild_from(jsonl)`) works
        after a prior open(). Closes the current connection first; caller
        re-opens when ready."""
        target = sqlite_path if sqlite_path is not None else self.path
        if target is None:
            raise ValueError(
                "SqliteStreamer.rebuild_from: sqlite_path required "
                "(no instance path set)"
            )
        if self.db is not None:
            self.close()
        return rebuild(jsonl_path, target)

    def _meta(self, key: str) -> str | None:
        if self.db is None:
            return None
        row = self.db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None
