"""Tests for SqliteStreamer — connection lifecycle, PRAGMAs, schema v1 DDL.

Phase 1.2.1 scope. apply_entity, truncate_and_replay, decide_on_boot,
replay_forward, and rebuild_from come in subsequent sub-PRs and pick up
their own test files.
"""

import sqlite3

import pytest

from kalairos.schema import SCHEMA_VERSION
from kalairos.sqlite_index import SqliteStreamer, apply_schema_v1


@pytest.fixture
def streamer(tmp_path):
    return SqliteStreamer(tmp_path / "index.sqlite")


# ── Lifecycle ───────────────────────────────────────────────────────────────


def test_health_check_when_closed_reports_not_open(streamer):
    assert streamer.health_check() == {"open": False}


def test_open_creates_database_file(streamer):
    assert not streamer.path.exists()
    streamer.open()
    assert streamer.path.exists()


def test_open_is_idempotent_for_same_path(streamer):
    streamer.open()
    first_conn = streamer.db
    streamer.open()  # second call must be a no-op
    assert streamer.db is first_conn


def test_open_refuses_different_path_while_open(tmp_path):
    streamer = SqliteStreamer(tmp_path / "a.sqlite")
    streamer.open()
    streamer.path = tmp_path / "b.sqlite"
    with pytest.raises(RuntimeError, match="already open"):
        streamer.open()


def test_close_is_no_op_when_not_open(streamer):
    streamer.close()  # must not raise
    assert streamer.db is None


def test_close_then_reopen_is_allowed(streamer):
    streamer.open()
    streamer.close()
    assert streamer.db is None
    streamer.open()
    assert streamer.db is not None
    streamer.close()


def test_in_memory_path(tmp_path):
    """`:memory:` is a legitimate target. SQLite reports journal_mode as
    `memory` for in-memory databases — WAL is a file-level mode and gets
    silently downgraded."""
    streamer = SqliteStreamer(":memory:")
    streamer.open()
    h = streamer.health_check()
    assert h["open"] is True
    assert h["journal_mode"] == "memory"
    assert h["schema_version"] == SCHEMA_VERSION
    streamer.close()


# ── PRAGMAs ─────────────────────────────────────────────────────────────────


def test_health_check_when_open(streamer):
    streamer.open()
    h = streamer.health_check()
    assert h["open"] is True
    assert h["path"] == str(streamer.path)
    assert h["journal_mode"] == "wal"
    assert h["synchronous"] == 1  # SQLite returns 1 for NORMAL
    assert h["schema_version"] == SCHEMA_VERSION


def test_pragmas_persist_across_statements(streamer):
    streamer.open()
    # Run any query; PRAGMA state must still report the configured values
    # afterwards — catches regressions where pragmas get reset by a
    # connection-level operation.
    streamer.db.execute("SELECT 1").fetchone()
    assert streamer.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert streamer.db.execute("PRAGMA synchronous").fetchone()[0] == 1


# ── Schema v1 ───────────────────────────────────────────────────────────────


def test_schema_v1_creates_all_named_tables(streamer):
    streamer.open()
    tables = {
        r[0]
        for r in streamer.db.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    expected = {"facts", "fact_versions", "links", "meta", "facts_fts"}
    missing = expected - tables
    assert not missing, f"missing tables: {missing}"


def test_schema_v1_creates_named_indexes(streamer):
    streamer.open()
    indexes = {
        r[0]
        for r in streamer.db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        )
    }
    expected = {
        "idx_facts_namespace",
        "idx_facts_workspace",
        "idx_facts_updated",
        "idx_facts_live_recent",
        "idx_versions_written",
        "idx_links_dst",
    }
    missing = expected - indexes
    assert not missing, f"missing indexes: {missing}"


def test_schema_v1_creates_fts_triggers(streamer):
    streamer.open()
    triggers = {
        r[0]
        for r in streamer.db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger'"
        )
    }
    expected = {"facts_ai", "facts_ad", "facts_au"}
    missing = expected - triggers
    assert not missing, f"missing triggers: {missing}"


def test_apply_schema_v1_is_idempotent(tmp_path):
    """Re-applying schema on an existing DB must not raise. IF NOT EXISTS
    is the whole contract — important when the boot decision tree replays
    onto an already-built index."""
    db_path = tmp_path / "x.sqlite"
    db = sqlite3.connect(db_path)
    try:
        apply_schema_v1(db)
        apply_schema_v1(db)
    finally:
        db.close()


def test_meta_seed_does_not_clobber_existing_value(tmp_path):
    """A future migration writing to meta.schema_version must not be
    overwritten when open() re-applies schema. INSERT OR IGNORE is what
    protects this — verify the OR IGNORE actually IGNOREs."""
    db_path = tmp_path / "x.sqlite"
    db = sqlite3.connect(db_path)
    apply_schema_v1(db)
    db.execute(
        "UPDATE meta SET value = '99' WHERE key = 'schema_version'"
    )
    db.commit()
    db.close()

    streamer = SqliteStreamer(db_path)
    streamer.open()
    # The "99" must survive the second apply.
    assert streamer.health_check()["schema_version"] == "99"
    streamer.close()
