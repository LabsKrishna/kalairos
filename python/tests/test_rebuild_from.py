"""Tests for the stream-rebuild path — `_apply_entity`, `_sha256_first_4kb`,
the standalone `rebuild()` function, and `SqliteStreamer.rebuild_from()`.

Phase 1.2.3 scope. Boot decision tree and replay-forward come in 1.2.4.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from kalairos import __version__ as kalairos_version
from kalairos.entity_normalizer import normalize_raw
from kalairos.schema import (
    META_KEY_DIRTY,
    META_KEY_INDEX_BUILT_AT,
    META_KEY_JSONL_PATH,
    META_KEY_JSONL_SHA256_FIRST_4KB,
    META_KEY_JSONL_SIZE_BYTES,
    META_KEY_KALAIROS_VERSION,
    META_KEY_LAST_JSONL_OFFSET,
)
from kalairos.sqlite_index import (
    SqliteStreamer,
    _apply_entity,
    _sha256_first_4kb,
    apply_schema_v1,
    rebuild,
)


# ── helpers ────────────────────────────────────────────────────────────────


def _make_entity(eid: str, text: str, **overrides) -> dict:
    """Build a minimal entity dict with one version and run it through
    normalize_raw — produces the shape a JSONL line would have post-write."""
    raw = {
        "id": eid,
        "text": text,
        "versions": [{"timestamp": 1000, "text": text}],
    }
    raw.update(overrides)
    return normalize_raw(raw)


def _write_jsonl(path: Path, entities: list[dict]) -> int:
    """Write entities (one per line) and return the file size in bytes.
    Matches the format JsonlAppender produces — separators=(",", ":") plus
    trailing newline."""
    data = (
        "\n".join(json.dumps(e, separators=(",", ":")) for e in entities) + "\n"
    ).encode("utf-8")
    path.write_bytes(data)
    return len(data)


def _meta(db_path: Path, key: str) -> str | None:
    db = sqlite3.connect(str(db_path))
    try:
        row = db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None
    finally:
        db.close()


# ── _sha256_first_4kb ──────────────────────────────────────────────────────


def test_sha256_first_4kb_deterministic(tmp_path):
    p = tmp_path / "f.bin"
    p.write_bytes(b"hello world")
    assert _sha256_first_4kb(p) == _sha256_first_4kb(p)


def test_sha256_first_4kb_only_hashes_first_4kb(tmp_path):
    """A change AFTER the first 4 KiB must not change the digest."""
    base = b"x" * 4096
    p1 = tmp_path / "a.bin"
    p1.write_bytes(base + b"after-the-fence-1")
    p2 = tmp_path / "b.bin"
    p2.write_bytes(base + b"after-the-fence-2-totally-different")
    assert _sha256_first_4kb(p1) == _sha256_first_4kb(p2)


def test_sha256_first_4kb_small_file(tmp_path):
    """Files shorter than 4 KiB hash only the bytes that exist."""
    p = tmp_path / "small.bin"
    p.write_bytes(b"abc")
    h_short = _sha256_first_4kb(p)
    # Different short content → different hash.
    p2 = tmp_path / "small2.bin"
    p2.write_bytes(b"xyz")
    assert _sha256_first_4kb(p2) != h_short


# ── _apply_entity ──────────────────────────────────────────────────────────


@pytest.fixture
def fresh_db(tmp_path):
    """An empty SQLite DB with schema v1 applied, isolation_level=None so
    _apply_entity can run inside the caller's transaction frame (or none)."""
    db_path = tmp_path / "x.sqlite"
    db = sqlite3.connect(str(db_path), isolation_level=None)
    apply_schema_v1(db)
    try:
        yield db
    finally:
        db.close()


def test_apply_entity_inserts_fact_row(fresh_db):
    entity = _make_entity("ent-1", "hello", memoryType="working", workspaceId="alpha")
    _apply_entity(fresh_db, entity, jsonl_offset=42)
    row = fresh_db.execute(
        "SELECT id, text, namespace, workspace_id, jsonl_offset FROM facts"
    ).fetchone()
    assert row == ("ent-1", "hello", "working", "alpha", 42)


def test_apply_entity_upserts_on_conflict(fresh_db):
    """A second apply of the same entity must UPDATE the existing row, not
    error or duplicate. jsonl_offset reflects the latest write."""
    e1 = _make_entity("ent-1", "v1")
    _apply_entity(fresh_db, e1, jsonl_offset=0)
    e2 = _make_entity("ent-1", "v2")
    _apply_entity(fresh_db, e2, jsonl_offset=100)
    rows = fresh_db.execute("SELECT id, text, jsonl_offset FROM facts").fetchall()
    assert rows == [("ent-1", "v2", 100)]


def test_apply_entity_inserts_versions_oldest_first(fresh_db):
    """fact_versions must have version=1 for the oldest, ascending forward."""
    raw = {
        "id": "ent",
        "text": "v3",
        "versions": [
            {"timestamp": 300, "text": "v3"},
            {"timestamp": 200, "text": "v2"},
            {"timestamp": 100, "text": "v1"},
        ],
    }
    _apply_entity(fresh_db, normalize_raw(raw), jsonl_offset=0)
    rows = fresh_db.execute(
        "SELECT version, text, written_at FROM fact_versions ORDER BY version"
    ).fetchall()
    assert rows == [(1, "v1", 100), (2, "v2", 200), (3, "v3", 300)]


def test_apply_entity_inserts_links(fresh_db):
    entity = _make_entity("src", "x", links=["dst-1", "dst-2"])
    _apply_entity(fresh_db, entity, jsonl_offset=0)
    rows = fresh_db.execute(
        "SELECT src_id, dst_id, kind FROM links ORDER BY dst_id"
    ).fetchall()
    assert rows == [("src", "dst-1", "related"), ("src", "dst-2", "related")]


def test_apply_entity_delete_then_insert_links(fresh_db):
    """A re-write that drops a link must reflect in SQLite."""
    e1 = _make_entity("src", "x", links=["a", "b", "c"])
    _apply_entity(fresh_db, e1, jsonl_offset=0)
    e2 = _make_entity("src", "x", links=["b"])  # dropped a, c
    _apply_entity(fresh_db, e2, jsonl_offset=100)
    rows = fresh_db.execute("SELECT dst_id FROM links").fetchall()
    assert rows == [("b",)]


def test_apply_entity_soft_delete_fields(fresh_db):
    entity = _make_entity("ent", "x", deletedAt=9999, deletedBy="alice")
    _apply_entity(fresh_db, entity, jsonl_offset=0)
    row = fresh_db.execute(
        "SELECT deleted_at, deleted_by FROM facts WHERE id = 'ent'"
    ).fetchone()
    assert row == (9999, "alice")


def test_apply_entity_handles_no_versions(fresh_db):
    raw = {"id": "ent", "text": "x"}
    _apply_entity(fresh_db, normalize_raw(raw), jsonl_offset=0)
    row = fresh_db.execute("SELECT id, text FROM facts").fetchone()
    assert row == ("ent", "x")
    versions = fresh_db.execute("SELECT * FROM fact_versions").fetchall()
    assert versions == []


def test_apply_entity_non_finite_trust_becomes_null(fresh_db):
    """JS Number.isFinite check: NaN/Infinity/bool → NULL trust_score."""
    raw = {"id": "ent", "text": "x", "trustScore": float("inf")}
    _apply_entity(fresh_db, normalize_raw(raw), jsonl_offset=0)
    (trust,) = fresh_db.execute("SELECT trust_score FROM facts").fetchone()
    assert trust is None


# ── rebuild() — end-to-end JSONL → SQLite ──────────────────────────────────


@pytest.fixture
def workspace(tmp_path):
    """A scratch dir with paths for jsonl and sqlite, neither pre-existing."""
    return {
        "jsonl": tmp_path / "ledger.jsonl",
        "sqlite": tmp_path / "index.sqlite",
        "dir": tmp_path,
    }


def test_rebuild_creates_sqlite_from_jsonl(workspace):
    entities = [
        _make_entity("a", "alpha"),
        _make_entity("b", "beta"),
        _make_entity("c", "gamma"),
    ]
    jsonl_size = _write_jsonl(workspace["jsonl"], entities)
    result = rebuild(workspace["jsonl"], workspace["sqlite"])
    assert result["rows_applied"] == 3
    assert result["jsonl_size"] == jsonl_size
    assert result["last_offset"] == jsonl_size
    # SQLite file exists, contains the rows
    assert workspace["sqlite"].exists()
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        rows = db.execute("SELECT id, text FROM facts ORDER BY id").fetchall()
    finally:
        db.close()
    assert rows == [("a", "alpha"), ("b", "beta"), ("c", "gamma")]


def test_rebuild_meta_written_correctly(workspace):
    entities = [_make_entity("a", "alpha")]
    jsonl_size = _write_jsonl(workspace["jsonl"], entities)
    rebuild(workspace["jsonl"], workspace["sqlite"])

    assert _meta(workspace["sqlite"], META_KEY_JSONL_PATH) == str(workspace["jsonl"])
    assert _meta(workspace["sqlite"], META_KEY_JSONL_SIZE_BYTES) == str(jsonl_size)
    assert _meta(workspace["sqlite"], META_KEY_LAST_JSONL_OFFSET) == str(jsonl_size)
    assert _meta(workspace["sqlite"], META_KEY_DIRTY) == "0"
    assert _meta(workspace["sqlite"], META_KEY_KALAIROS_VERSION) == kalairos_version
    # sha256 is a 64-char hex digest of the first 4KB of JSONL
    sha = _meta(workspace["sqlite"], META_KEY_JSONL_SHA256_FIRST_4KB)
    assert sha is not None and len(sha) == 64
    # index_built_at is a millisecond timestamp parseable as an int
    built_at = _meta(workspace["sqlite"], META_KEY_INDEX_BUILT_AT)
    assert built_at is not None and int(built_at) > 0


def test_rebuild_byte_offsets_match_actual_lines(workspace):
    """Each row's `jsonl_offset` in SQLite must point at the actual byte
    position of its line in JSONL."""
    entities = [_make_entity(f"e{i}", f"text-{i}") for i in range(5)]
    raw_bytes = workspace["jsonl"]
    _write_jsonl(raw_bytes, entities)
    rebuild(workspace["jsonl"], workspace["sqlite"])

    raw = workspace["jsonl"].read_bytes()
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        for row_id, offset in db.execute(
            "SELECT id, jsonl_offset FROM facts"
        ).fetchall():
            # The line at `offset` must parse to JSON with that id.
            end = raw.index(b"\n", offset)
            parsed = json.loads(raw[offset:end])
            assert parsed["id"] == row_id
    finally:
        db.close()


def test_rebuild_handles_empty_jsonl(workspace):
    workspace["jsonl"].write_bytes(b"")
    result = rebuild(workspace["jsonl"], workspace["sqlite"])
    assert result == {"rows_applied": 0, "jsonl_size": 0, "last_offset": 0}
    assert _meta(workspace["sqlite"], META_KEY_JSONL_SIZE_BYTES) == "0"
    assert _meta(workspace["sqlite"], META_KEY_LAST_JSONL_OFFSET) == "0"


def test_rebuild_handles_missing_jsonl(workspace):
    """If JSONL doesn't exist, rebuild yields an empty index with size=0."""
    assert not workspace["jsonl"].exists()
    result = rebuild(workspace["jsonl"], workspace["sqlite"])
    assert result == {"rows_applied": 0, "jsonl_size": 0, "last_offset": 0}
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        assert db.execute("SELECT COUNT(*) FROM facts").fetchone()[0] == 0
    finally:
        db.close()


def test_rebuild_skips_malformed_lines(workspace, caplog):
    entities = [_make_entity("a", "alpha"), _make_entity("b", "beta")]
    # Inject a garbage line between two valid entries.
    data = (
        json.dumps(entities[0], separators=(",", ":"))
        + "\nthis line is not json at all\n"
        + json.dumps(entities[1], separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    workspace["jsonl"].write_bytes(data)
    with caplog.at_level("WARNING", logger="kalairos.sqlite_index"):
        result = rebuild(workspace["jsonl"], workspace["sqlite"])
    assert result["rows_applied"] == 2
    assert any("malformed" in m for m in caplog.messages)
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        ids = {r[0] for r in db.execute("SELECT id FROM facts").fetchall()}
    finally:
        db.close()
    assert ids == {"a", "b"}


def test_rebuild_atomic_rename_cleans_up_tmp(workspace):
    """After a successful rebuild there must be no orphan `.rebuild` file."""
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "x")])
    rebuild(workspace["jsonl"], workspace["sqlite"])
    tmp = workspace["dir"] / "index.sqlite.rebuild"
    assert not tmp.exists()


def test_rebuild_reaps_orphan_rebuild_file(workspace):
    """A stale `.rebuild` from a prior crashed attempt must be reaped on
    entry; the new rebuild then succeeds."""
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "x")])
    tmp = workspace["dir"] / "index.sqlite.rebuild"
    tmp.write_bytes(b"garbage from a crashed rebuild")
    rebuild(workspace["jsonl"], workspace["sqlite"])
    assert not tmp.exists()
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        assert db.execute("SELECT id FROM facts").fetchall() == [("a",)]
    finally:
        db.close()


def test_rebuild_overwrites_existing_index(workspace):
    """Rebuilding into a path that already has an index must replace it
    atomically with the new content."""
    # First rebuild
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "alpha")])
    rebuild(workspace["jsonl"], workspace["sqlite"])
    # Replace JSONL contents, then rebuild
    _write_jsonl(workspace["jsonl"], [_make_entity("b", "beta")])
    rebuild(workspace["jsonl"], workspace["sqlite"])
    db = sqlite3.connect(str(workspace["sqlite"]))
    try:
        ids = {r[0] for r in db.execute("SELECT id FROM facts").fetchall()}
    finally:
        db.close()
    assert ids == {"b"}  # `a` is gone — full replace, not append


# ── SqliteStreamer.rebuild_from() method ───────────────────────────────────


def test_streamer_rebuild_from_defaults_sqlite_path_to_self_path(workspace):
    """`streamer.rebuild_from(jsonl)` without a target uses `self.path`."""
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "x")])
    streamer = SqliteStreamer(workspace["sqlite"])
    result = streamer.rebuild_from(workspace["jsonl"])
    assert result["rows_applied"] == 1
    assert workspace["sqlite"].exists()


def test_streamer_rebuild_from_closes_open_db_first(workspace):
    """If the streamer is already open, rebuild_from must close before
    swapping in the rebuilt index — you can't hold a fd on a file you're
    about to be replaced via rename."""
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "x")])
    streamer = SqliteStreamer(workspace["sqlite"])
    streamer.open()
    assert streamer.db is not None
    streamer.rebuild_from(workspace["jsonl"])
    # After rebuild_from, the streamer's db handle is released.
    assert streamer.db is None


def test_streamer_rebuild_from_explicit_sqlite_path(workspace, tmp_path):
    """Explicit sqlite_path overrides self.path."""
    _write_jsonl(workspace["jsonl"], [_make_entity("a", "x")])
    streamer = SqliteStreamer(workspace["sqlite"])
    target = tmp_path / "alternate.sqlite"
    streamer.rebuild_from(workspace["jsonl"], target)
    assert target.exists()
    # self.path wasn't touched
    assert not workspace["sqlite"].exists()


# ── Determinism: same JSONL → same rows ────────────────────────────────────


def test_rebuild_is_deterministic(workspace, tmp_path):
    """Rebuilding the same JSONL into two separate SQLite files must
    produce row-equivalent results — this is what makes 'SQLite is
    rebuildable from JSONL' actually hold."""
    entities = [_make_entity(f"e{i}", f"text-{i}", links=["x", "y"]) for i in range(5)]
    _write_jsonl(workspace["jsonl"], entities)
    target_a = tmp_path / "a.sqlite"
    target_b = tmp_path / "b.sqlite"
    rebuild(workspace["jsonl"], target_a)
    rebuild(workspace["jsonl"], target_b)

    def _snapshot(p: Path):
        db = sqlite3.connect(str(p))
        try:
            facts = sorted(
                db.execute(
                    "SELECT id, text, namespace, jsonl_offset FROM facts"
                ).fetchall()
            )
            versions = sorted(
                db.execute(
                    "SELECT fact_id, version, text, written_at FROM fact_versions"
                ).fetchall()
            )
            links = sorted(
                db.execute(
                    "SELECT src_id, dst_id, kind FROM links"
                ).fetchall()
            )
        finally:
            db.close()
        return facts, versions, links

    assert _snapshot(target_a) == _snapshot(target_b)
