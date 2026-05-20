"""Ledger — unified read/write API over the JSONL + SQLite pipeline.

`append(record)` is the canonical write: it appends to JSONL first (the
durable source of truth) and then UPSERTs into the SQLite read index. If
SQLite fails, the ledger marks itself dirty so the next `open()` detects
divergence and rebuilds.

`open()` inspects the JSONL/SQLite state via `decide_on_boot` and
dispatches to rebuild, replay-forward, or just-open as appropriate.

`get(id)` / `query(...)` read from SQLite — fast, indexed, and never
authoritative (JSONL is). If SQLite ever disappears, `rebuild()`
deterministically reconstructs it from JSONL.

Tail / subscriptions / the Python-side MCP append endpoint come in later
sub-PRs.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .entity_normalizer import normalize_raw
from .jsonl import JsonlAppender
from .sqlite_index import (
    SqliteStreamer,
    decide_on_boot,
    rebuild,
    replay_forward,
)


class Ledger:
    """Read/write façade over a (JSONL, SQLite) pair.

    The ledger owns both halves. Callers don't touch the appender or
    streamer directly — that would let them diverge from the v1.7
    invariant.
    """

    def __init__(self, jsonl_path: Path | str, sqlite_path: Path | str):
        self.jsonl_path = Path(jsonl_path)
        self.sqlite_path = Path(sqlite_path)
        self.appender = JsonlAppender(self.jsonl_path)
        self.streamer = SqliteStreamer(self.sqlite_path)

    # ── Context manager ────────────────────────────────────────────────

    def __enter__(self) -> "Ledger":
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # ── Lifecycle ──────────────────────────────────────────────────────

    def open(self) -> dict:
        """Open the ledger. Returns the boot decision dict so callers can
        observe what happened (READY / REPLAY / REBUILD + reason).

        Dispatch (per spec §6.2):
          - READY:   just open the streamer
          - REPLAY:  apply only the new bytes (replay_forward), then open
          - REBUILD: full rebuild from JSONL, then open
        """
        decision = decide_on_boot(
            self.jsonl_path, self.sqlite_path, quiet=True
        )
        action = decision["action"]
        if action == "REPLAY":
            replay_forward(self.jsonl_path, self.sqlite_path)
        elif action == "REBUILD":
            rebuild(self.jsonl_path, self.sqlite_path)
        # READY needs no remediation.
        self.streamer.open()
        return decision

    def close(self) -> None:
        self.appender.shutdown()
        self.streamer.close()

    # ── Write path ─────────────────────────────────────────────────────

    def append(self, record: dict) -> int:
        """Append a record to JSONL (canonical), then UPSERT it into
        SQLite. Returns the byte offset of the JSONL line.

        On SQLite failure: marks the streamer dirty and re-raises. The
        JSONL write has already landed, so JSONL remains the source of
        truth — the next `open()` will detect dirty via branch h and
        REBUILD, bringing SQLite back into sync.
        """
        if self.streamer.db is None:
            raise RuntimeError(
                "Ledger.append: not open — call .open() first"
            )
        if not isinstance(record, dict) or "id" not in record:
            raise ValueError(
                "Ledger.append: record must be a dict with an 'id' field"
            )

        offset = self.appender.append(record)
        size_after = self.jsonl_path.stat().st_size
        try:
            # Deep-copy so normalize_raw's in-place mutation doesn't
            # surprise the caller — they get back exactly what they
            # passed in.
            normalized = normalize_raw(copy.deepcopy(record))
            self.streamer.apply_entity(normalized, offset, size_after)
        except Exception:
            self.streamer.mark_dirty()
            raise
        return offset

    # ── Read path ──────────────────────────────────────────────────────

    def get(self, entity_id: str) -> dict | None:
        """Get one fact by id. Returns `None` if not found or soft-deleted.
        Use `query(..., include_deleted=True)` to inspect tombstones."""
        self._require_open("get")
        with self.streamer.lock:
            row = self.streamer.db.execute(
                _SELECT_FACTS + " WHERE id = ? AND deleted_at IS NULL",
                (entity_id,),
            ).fetchone()
        return _row_to_dict(row) if row else None

    def query(
        self,
        *,
        namespace: str | None = None,
        workspace: str | None = None,
        include_deleted: bool = False,
        limit: int | None = None,
    ) -> list[dict]:
        """Query the SQLite read index. Returns facts ordered by
        `updated_at` descending. All filters are optional and conjunctive.
        """
        self._require_open("query")
        clauses: list[str] = []
        params: list = []
        if namespace is not None:
            clauses.append("namespace = ?")
            params.append(namespace)
        if workspace is not None:
            clauses.append("workspace_id = ?")
            params.append(workspace)
        if not include_deleted:
            clauses.append("deleted_at IS NULL")
        sql = _SELECT_FACTS
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY updated_at DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        with self.streamer.lock:
            rows = self.streamer.db.execute(sql, params).fetchall()
        return [_row_to_dict(r) for r in rows]

    # ── Internal ───────────────────────────────────────────────────────

    def _require_open(self, op: str) -> None:
        if self.streamer.db is None:
            raise RuntimeError(
                f"Ledger.{op}: not open — call .open() first"
            )


# Column order matched by _row_to_dict — keep these in lockstep.
_SELECT_FACTS = (
    "SELECT id, text, namespace, type, workspace_id, tags, trust_score, "
    "created_at, updated_at, deleted_at, deleted_by, jsonl_offset "
    "FROM facts"
)


def _row_to_dict(row) -> dict:
    return {
        "id": row[0],
        "text": row[1],
        "namespace": row[2],
        "type": row[3],
        "workspaceId": row[4],
        "tags": json.loads(row[5]) if row[5] else [],
        "trustScore": row[6],
        "createdAt": row[7],
        "updatedAt": row[8],
        "deletedAt": row[9],
        "deletedBy": row[10],
        "jsonlOffset": row[11],
    }
