"""Audit-grade replay over the canonical JSONL ledger.

`replay(jsonl_path)` streams the ledger through the same `_apply_entity`
path used by `rebuild()`, into a throwaway SQLite, and returns a
content-addressable `state_hash` over the derived rows. Same JSONL in,
same hash out — regardless of when, where, or on what machine the replay
runs. This is the determinism signature the §17 CI gate publishes.

What the hash covers:
  - facts (every column except jsonl_offset positional aliases)
  - fact_versions
  - links

What it deliberately excludes:
  - meta.index_built_at, meta.kalairos_version, meta.jsonl_path —
    timestamp- / environment-bearing, would defeat determinism
  - facts_fts — trigger-derived from facts, redundant
  - jsonl_offset on the row tables — included; an offset shift means the
    JSONL itself drifted and replay should surface that

Use cases:
  - CI determinism gate: replay every PR's sample fixture and assert
    state_hash matches the recorded baseline.
  - Regulator-facing audit: "the agent state on date X was state_hash=Y;
    here is the JSONL that produces it."
  - Drift detection: compare a production SQLite's projection against
    replay(jsonl)'s hash to detect silent divergence.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from .sqlite_index import rebuild

log = logging.getLogger(__name__)


# Columns hashed per row table. Order is fixed and load-bearing — changing
# it changes every published baseline. Add new columns at the end if the
# schema grows; never reorder.
_FACTS_COLS = (
    "id",
    "text",
    "namespace",
    "type",
    "workspace_id",
    "tags",
    "trust_score",
    "confidence",
    "created_at",
    "updated_at",
    "deleted_at",
    "deleted_by",
    "source_turn_id",
    "jsonl_offset",
)
_VERSIONS_COLS = (
    "fact_id",
    "version",
    "text",
    "trust_score",
    "written_at",
    "jsonl_offset",
)
_LINKS_COLS = ("src_id", "dst_id", "kind", "created_at")


@dataclass(frozen=True)
class ReplayResult:
    """Outcome of a replay run.

    `state_hash` is the determinism signature: SHA-256 over the canonical
    serialization of the derived rows. `rows_applied` is what rebuild()
    consumed from JSONL. `last_offset` is the JSONL size in bytes at
    replay time — pin this alongside the hash when publishing a baseline.
    """

    state_hash: str
    rows_applied: int
    last_offset: int
    jsonl_size: int
    facts_count: int
    versions_count: int
    links_count: int

    def as_dict(self) -> dict:
        return asdict(self)


def replay(jsonl_path: Path | str) -> ReplayResult:
    """Replay a JSONL ledger into a throwaway SQLite and return a
    `ReplayResult` with the content-addressable `state_hash`.

    The throwaway DB is created under a tempdir and deleted before
    return — replay leaves no on-disk state behind. JSONL is not
    modified.

    Determinism contract: for any JSONL whose bytes are identical, the
    returned `state_hash` is identical, regardless of filesystem path,
    tempdir location, kalairos version, or wall-clock time at replay.
    """
    jsonl_path = Path(jsonl_path)

    with tempfile.TemporaryDirectory(prefix="kalairos-replay-") as td:
        sqlite_path = Path(td) / "index.sqlite"
        rebuild_result = rebuild(jsonl_path, sqlite_path)
        hash_, counts = _hash_state(sqlite_path)

    return ReplayResult(
        state_hash=hash_,
        rows_applied=rebuild_result["rows_applied"],
        last_offset=rebuild_result["last_offset"],
        jsonl_size=rebuild_result["jsonl_size"],
        facts_count=counts["facts"],
        versions_count=counts["fact_versions"],
        links_count=counts["links"],
    )


def _hash_state(sqlite_path: Path) -> tuple[str, dict]:
    """SHA-256 over the canonical serialization of facts, fact_versions,
    and links. Returns `(hex_digest, {table: row_count})`.

    Canonical form:
      - rows sorted by their primary key
      - each row encoded as a JSON array (not object) so column ORDER is
        the contract, not column names — names can rename in a future
        schema migration, the hash should keep working
      - tables emitted in fixed order with single-byte separators
    """
    db = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    try:
        h = hashlib.sha256()
        counts: dict[str, int] = {}

        facts_rows = db.execute(
            f"SELECT {','.join(_FACTS_COLS)} FROM facts ORDER BY id"
        ).fetchall()
        counts["facts"] = _fold_rows(h, b"facts", facts_rows)

        versions_rows = db.execute(
            f"SELECT {','.join(_VERSIONS_COLS)} "
            "FROM fact_versions ORDER BY fact_id, version"
        ).fetchall()
        counts["fact_versions"] = _fold_rows(h, b"fact_versions", versions_rows)

        links_rows = db.execute(
            f"SELECT {','.join(_LINKS_COLS)} "
            "FROM links ORDER BY src_id, dst_id, kind"
        ).fetchall()
        counts["links"] = _fold_rows(h, b"links", links_rows)

        return h.hexdigest(), counts
    finally:
        db.close()


def _fold_rows(h: "hashlib._Hash", table: bytes, rows: list[tuple]) -> int:
    """Fold one table's rows into the running hash. Returns row count.

    Table name is mixed in first so two empty tables don't collide and
    so a column shifting between tables would change the digest. Rows
    are length-prefixed-by-newline JSON arrays — `separators=(",", ":")`
    matches the JSONL appender's encoding for cross-tool reproducibility.
    """
    h.update(b"\x1e")  # ASCII record separator — table boundary marker
    h.update(table)
    h.update(b"\x1e")
    for row in rows:
        line = json.dumps(list(row), separators=(",", ":"), ensure_ascii=False)
        h.update(line.encode("utf-8"))
        h.update(b"\n")
    return len(rows)


# ── CLI ─────────────────────────────────────────────────────────────────────


def _main(argv: list[str] | None = None) -> int:
    """`python -m kalairos.replay <jsonl> [--baseline HEX]`.

    Prints the ReplayResult as JSON on stdout. With `--baseline`, exits
    1 if `state_hash` does not match — the CI gate uses this. With no
    baseline, exits 0 on success.
    """
    import argparse
    import sys

    p = argparse.ArgumentParser(
        prog="kalairos.replay",
        description=(
            "Replay a JSONL ledger deterministically and emit the "
            "content-addressable state hash."
        ),
    )
    p.add_argument("jsonl", type=Path, help="path to the JSONL ledger")
    p.add_argument(
        "--baseline",
        metavar="HEX",
        help="expected state_hash; exit 1 on mismatch",
    )
    args = p.parse_args(argv)

    if not args.jsonl.exists():
        print(
            json.dumps({"error": "jsonl-not-found", "path": str(args.jsonl)}),
            file=sys.stderr,
        )
        return 2

    result = replay(args.jsonl)
    print(json.dumps(result.as_dict(), indent=2))

    if args.baseline and args.baseline != result.state_hash:
        print(
            json.dumps(
                {
                    "error": "baseline-mismatch",
                    "expected": args.baseline,
                    "actual": result.state_hash,
                }
            ),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
