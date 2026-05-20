"""Tests for the live-write path on SqliteStreamer — Phase 1.2.5.

Covers `apply_entity` (per-write UPSERT with meta updates),
`truncate_and_replay` (wipe + re-derive in one txn after a JSONL
rewrite), and `mark_dirty` (best-effort meta.dirty=1 for the boot
decision tree to pick up after a failed live-write txn).
"""

import json
import sqlite3
from pathlib import Path

import pytest

from kalairos.entity_normalizer import normalize_raw
from kalairos.schema import (
    META_KEY_DIRTY,
    META_KEY_JSONL_SHA256_FIRST_4KB,
    META_KEY_JSONL_SIZE_BYTES,
    META_KEY_LAST_JSONL_OFFSET,
)
from kalairos.sqlite_index import SqliteStreamer, decide_on_boot, rebuild


# ── helpers ────────────────────────────────────────────────────────────────


def _entity(eid: str, text: str, **overrides) -> dict:
    raw = {"id": eid, "text": text, "versions": [{"timestamp": 1000, "text": text}]}
    raw.update(overrides)
    return normalize_raw(raw)


def _write_jsonl(path: Path, entities: list[dict]) -> int:
    data = (
        "\n".join(json.dumps(e, separators=(",", ":")) for e in entities) + "\n"
    ).encode("utf-8")
    path.write_bytes(data)
    return len(data)


@pytest.fixture
def opened(tmp_path):
    """A SqliteStreamer opened on a fresh path."""
    s = SqliteStreamer(tmp_path / "index.sqlite")
    s.open()
    try:
        yield s
    finally:
        s.close()


# ── apply_entity ───────────────────────────────────────────────────────────


def test_apply_entity_inserts_fact_and_updates_meta(opened):
    opened.apply_entity(_entity("ent", "hello"), jsonl_offset=0)
    row = opened.db.execute(
        "SELECT id, text, jsonl_offset FROM facts"
    ).fetchone()
    assert row == ("ent", "hello", 0)
    # meta.last_jsonl_offset defaults to jsonl_offset when size_after omitted
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == "0"
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == "0"


def test_apply_entity_size_after_defaults_to_jsonl_offset(opened):
    opened.apply_entity(_entity("ent", "x"), jsonl_offset=42)
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == "42"
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == "42"


def test_apply_entity_explicit_size_after_overrides_default(opened):
    """The JSONL hot path knows the file size *after* the append; passing
    it lets meta.last_jsonl_offset reflect the actual end-of-file."""
    opened.apply_entity(
        _entity("ent", "x"), jsonl_offset=42, jsonl_size_after=100
    )
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == "100"
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == "100"


def test_apply_entity_upserts_on_repeat_id(opened):
    opened.apply_entity(_entity("ent", "v1"), jsonl_offset=0, jsonl_size_after=50)
    opened.apply_entity(_entity("ent", "v2"), jsonl_offset=50, jsonl_size_after=100)
    rows = opened.db.execute(
        "SELECT id, text, jsonl_offset FROM facts"
    ).fetchall()
    assert rows == [("ent", "v2", 50)]
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == "100"


def test_apply_entity_raises_when_not_open(tmp_path):
    s = SqliteStreamer(tmp_path / "index.sqlite")
    with pytest.raises(RuntimeError, match="not open"):
        s.apply_entity(_entity("ent", "x"), jsonl_offset=0)


def test_apply_entity_rolls_back_on_internal_failure(opened):
    """A bad entity that crashes _apply_entity must NOT leave a stray
    BEGIN open on the connection — caller must be able to call
    mark_dirty() and continue."""
    # Drop the facts table to force _apply_entity to fail.
    opened.db.execute("DROP TABLE facts")
    with pytest.raises(sqlite3.Error):
        opened.apply_entity(_entity("ent", "x"), jsonl_offset=0)
    # Subsequent statements must work — meaning no leftover BEGIN.
    opened.db.execute("SELECT 1").fetchone()


# ── truncate_and_replay ────────────────────────────────────────────────────


def test_truncate_and_replay_wipes_then_re_derives(opened, tmp_path):
    """After applying entities directly, truncate_and_replay with a
    different JSONL must produce SQLite contents matching the JSONL."""
    opened.apply_entity(_entity("a", "alpha"), jsonl_offset=0)
    opened.apply_entity(_entity("b", "beta"), jsonl_offset=100)

    jsonl = tmp_path / "ledger.jsonl"
    _write_jsonl(jsonl, [_entity("x", "xray"), _entity("y", "yankee")])
    opened.truncate_and_replay(jsonl)

    ids = {
        r[0] for r in opened.db.execute("SELECT id FROM facts").fetchall()
    }
    assert ids == {"x", "y"}


def test_truncate_and_replay_updates_all_decision_tree_meta(opened, tmp_path):
    """Every meta key decide_on_boot reads must reflect the new JSONL
    so the next boot lands in branch f (READY)."""
    jsonl = tmp_path / "ledger.jsonl"
    size = _write_jsonl(jsonl, [_entity("a", "alpha")])
    opened.truncate_and_replay(jsonl)
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == str(size)
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == str(size)
    # sha256 is a 64-char hex digest
    sha = opened._meta(META_KEY_JSONL_SHA256_FIRST_4KB)
    assert sha is not None and len(sha) == 64
    # dirty is cleared
    assert opened._meta(META_KEY_DIRTY) == "0"


def test_truncate_and_replay_handles_empty_jsonl(opened, tmp_path):
    jsonl = tmp_path / "empty.jsonl"
    jsonl.write_bytes(b"")
    opened.truncate_and_replay(jsonl)
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == "0"
    assert opened._meta(META_KEY_LAST_JSONL_OFFSET) == "0"
    assert opened._meta(META_KEY_JSONL_SHA256_FIRST_4KB) == ""
    assert opened.db.execute("SELECT COUNT(*) FROM facts").fetchone()[0] == 0


def test_truncate_and_replay_handles_missing_jsonl(opened, tmp_path):
    jsonl = tmp_path / "does-not-exist.jsonl"
    opened.truncate_and_replay(jsonl)
    assert opened._meta(META_KEY_JSONL_SIZE_BYTES) == "0"
    assert opened.db.execute("SELECT COUNT(*) FROM facts").fetchone()[0] == 0


def test_truncate_and_replay_skips_malformed_lines(opened, tmp_path, caplog):
    jsonl = tmp_path / "ledger.jsonl"
    valid = _entity("a", "alpha")
    data = (
        json.dumps(valid, separators=(",", ":"))
        + "\nthis is not json\n"
        + json.dumps(_entity("b", "beta"), separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    jsonl.write_bytes(data)
    with caplog.at_level("WARNING", logger="kalairos.sqlite_index"):
        opened.truncate_and_replay(jsonl)
    ids = {
        r[0] for r in opened.db.execute("SELECT id FROM facts").fetchall()
    }
    assert ids == {"a", "b"}
    assert any("malformed" in m for m in caplog.messages)


def test_truncate_and_replay_raises_when_not_open(tmp_path):
    s = SqliteStreamer(tmp_path / "index.sqlite")
    with pytest.raises(RuntimeError, match="not open"):
        s.truncate_and_replay(tmp_path / "ledger.jsonl")


def test_truncate_and_replay_byte_offsets_match(opened, tmp_path):
    """Each row's jsonl_offset must point at its actual line start in JSONL."""
    jsonl = tmp_path / "ledger.jsonl"
    entities = [_entity(f"e{i}", f"text-{i}") for i in range(4)]
    _write_jsonl(jsonl, entities)
    opened.truncate_and_replay(jsonl)

    raw = jsonl.read_bytes()
    for row_id, offset in opened.db.execute(
        "SELECT id, jsonl_offset FROM facts"
    ).fetchall():
        end = raw.index(b"\n", offset)
        parsed = json.loads(raw[offset:end])
        assert parsed["id"] == row_id


# ── mark_dirty ─────────────────────────────────────────────────────────────


def test_mark_dirty_sets_meta_dirty(opened):
    assert opened._meta(META_KEY_DIRTY) != "1"  # fresh — either "0" or unset
    opened.mark_dirty()
    assert opened._meta(META_KEY_DIRTY) == "1"


def test_mark_dirty_no_op_when_not_open(tmp_path):
    """mark_dirty on a never-opened streamer must not raise — the live
    write path calls it from an except block; it can't afford its own
    failure mode."""
    s = SqliteStreamer(tmp_path / "index.sqlite")
    s.mark_dirty()  # must not raise


def test_mark_dirty_swallows_sqlite_errors(opened):
    """Even if the dirty write itself fails, mark_dirty must not raise.
    JSONL is canonical; the cost of a failed dirty-flag write is one
    extra rebuild on next start, not a crash on the live-write path."""
    # Drop meta to force the INSERT OR REPLACE to fail.
    opened.db.execute("DROP TABLE meta")
    opened.mark_dirty()  # must not raise


# ── End-to-end: failed write + mark_dirty + decide_on_boot → REBUILD ───────


def test_e2e_failed_write_marks_dirty_and_next_boot_rebuilds(tmp_path):
    """The contract: when a live-write txn fails, the caller calls
    mark_dirty(), and the next boot's decide_on_boot returns REBUILD via
    branch h. This is what protects against silent SQLite drift after a
    failed apply_entity."""
    jsonl = tmp_path / "ledger.jsonl"
    sqlite = tmp_path / "index.sqlite"

    # Set up an in-sync state via rebuild.
    _write_jsonl(jsonl, [_entity("a", "alpha")])
    rebuild(jsonl, sqlite)

    # Open, simulate a write failure, mark dirty, close.
    s = SqliteStreamer(sqlite)
    s.open()
    s.db.execute("DROP TABLE facts")  # break the next apply_entity
    try:
        s.apply_entity(_entity("b", "beta"), jsonl_offset=100)
    except sqlite3.Error:
        s.mark_dirty()
    s.close()

    # Next boot's decision must be REBUILD via dirty-flag.
    d = decide_on_boot(jsonl, sqlite, quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "dirty-flag-set"


# ── End-to-end: truncate_and_replay leaves index ready ─────────────────────


def test_e2e_truncate_and_replay_leaves_decision_in_ready(tmp_path):
    """After persist_all-style truncate+replay, decide_on_boot must
    return READY — no rebuild needed on next start."""
    jsonl = tmp_path / "ledger.jsonl"
    sqlite = tmp_path / "index.sqlite"

    _write_jsonl(jsonl, [_entity("a", "alpha")])
    rebuild(jsonl, sqlite)

    # Now rewrite JSONL entirely (simulates the persist_all path) and
    # call truncate_and_replay on an open streamer to bring SQLite in
    # sync without a rebuild.
    s = SqliteStreamer(sqlite)
    s.open()
    _write_jsonl(
        jsonl, [_entity("b", "beta"), _entity("c", "gamma")]
    )
    s.truncate_and_replay(jsonl)
    s.close()

    d = decide_on_boot(jsonl, sqlite, quiet=True)
    assert d["action"] == "READY"
