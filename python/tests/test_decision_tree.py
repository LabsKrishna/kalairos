"""Tests for the boot decision tree + replay_forward — Phase 1.2.4.

decide_on_boot is a pure function over (jsonl, sqlite); these tests set
up known states (typically via rebuild) and then mutate either side to
exercise each branch (a → b → h → c → d → e → g → f).

replay_forward is the case-g action: applies only the JSONL bytes beyond
meta.last_jsonl_offset.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from kalairos.entity_normalizer import normalize_raw
from kalairos.schema import (
    META_KEY_DIRTY,
    META_KEY_JSONL_SIZE_BYTES,
    META_KEY_LAST_JSONL_OFFSET,
    META_KEY_SCHEMA_VERSION,
)
from kalairos.sqlite_index import (
    decide_on_boot,
    rebuild,
    replay_forward,
)


# ── helpers ────────────────────────────────────────────────────────────────


def _entity(eid: str, text: str, **overrides) -> dict:
    raw = {"id": eid, "text": text, "versions": [{"timestamp": 1000, "text": text}]}
    raw.update(overrides)
    return normalize_raw(raw)


def _append_jsonl(path: Path, entities: list[dict]) -> int:
    """Append entities to JSONL, return new file size."""
    with path.open("ab") as f:
        for e in entities:
            f.write((json.dumps(e, separators=(",", ":")) + "\n").encode("utf-8"))
    return path.stat().st_size


def _write_jsonl(path: Path, entities: list[dict]) -> int:
    data = (
        "\n".join(json.dumps(e, separators=(",", ":")) for e in entities) + "\n"
    ).encode("utf-8")
    path.write_bytes(data)
    return len(data)


def _write_jsonl_over_4kb(path: Path, entities: list[dict]) -> tuple[int, set[str]]:
    """Write `entities` plus enough padding dummies that the file exceeds
    4 KiB. Returns (size, padding_ids). Tests that exercise REPLAY
    (branch g) need this: the sha256 fingerprint covers only the first
    4 KiB of JSONL, so on a small file any append changes the hash and
    branch d (REBUILD) short-circuits before branch g (REPLAY) can fire.
    Padding past 4 KiB keeps the head bytes stable across appends."""
    rows = list(entities)
    padding_ids: set[str] = set()
    i = 0
    while True:
        data = (
            "\n".join(json.dumps(e, separators=(",", ":")) for e in rows) + "\n"
        ).encode("utf-8")
        if len(data) > 4096:
            break
        pad_id = f"_pad_{i}"
        rows.append(_entity(pad_id, "x" * 200))
        padding_ids.add(pad_id)
        i += 1
    path.write_bytes(data)
    return len(data), padding_ids


def _set_meta(db_path: Path, key: str, value: str) -> None:
    db = sqlite3.connect(str(db_path))
    try:
        db.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value)
        )
        db.commit()
    finally:
        db.close()


def _get_meta(db_path: Path, key: str) -> str | None:
    db = sqlite3.connect(str(db_path))
    try:
        row = db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None
    finally:
        db.close()


@pytest.fixture
def workspace(tmp_path):
    return {
        "jsonl": tmp_path / "ledger.jsonl",
        "sqlite": tmp_path / "index.sqlite",
    }


@pytest.fixture
def synced(workspace):
    """A workspace with rebuild() already run — JSONL and SQLite in sync."""
    _write_jsonl(workspace["jsonl"], [_entity("a", "alpha"), _entity("b", "beta")])
    rebuild(workspace["jsonl"], workspace["sqlite"])
    return workspace


# ── Branch a — SQLite missing ───────────────────────────────────────────────


def test_branch_a_sqlite_missing_returns_rebuild(workspace):
    _write_jsonl(workspace["jsonl"], [_entity("a", "x")])
    # SQLite does not exist
    assert not workspace["sqlite"].exists()
    d = decide_on_boot(workspace["jsonl"], workspace["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "sqlite-missing"


def test_branch_a_takes_priority_over_jsonl_missing(tmp_path):
    """If both files are missing, SQLite-missing is reported (it's checked
    first per spec §6.2)."""
    d = decide_on_boot(
        tmp_path / "nope.jsonl", tmp_path / "nope.sqlite", quiet=True
    )
    assert d == {
        "action": "REBUILD",
        "reason": "sqlite-missing",
        "sqlite_path": str(tmp_path / "nope.sqlite"),
    }


# ── sqlite-open-failed ──────────────────────────────────────────────────────


def test_corrupt_sqlite_returns_rebuild(workspace):
    """A SQLite file with garbage contents triggers the open-failed branch."""
    _write_jsonl(workspace["jsonl"], [_entity("a", "x")])
    workspace["sqlite"].write_bytes(b"this is not a valid sqlite file")
    d = decide_on_boot(workspace["jsonl"], workspace["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "sqlite-open-failed"


# ── Branch b — schema version mismatch ──────────────────────────────────────


def test_branch_b_schema_version_mismatch_returns_rebuild(synced):
    _set_meta(synced["sqlite"], META_KEY_SCHEMA_VERSION, "99")
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "schema-version-mismatch"
    assert d["actual"] == "99"


# ── Branch h — dirty flag (ordered before c/d/e/g) ──────────────────────────


def test_branch_h_dirty_flag_returns_rebuild(synced):
    _set_meta(synced["sqlite"], META_KEY_DIRTY, "1")
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "dirty-flag-set"


def test_branch_h_dirty_wins_over_jsonl_grew(synced):
    """Even when JSONL has grown (would normally trigger REPLAY), the dirty
    flag forces a full REBUILD because we can't trust meta.last_jsonl_offset
    once the last write txn failed."""
    _set_meta(synced["sqlite"], META_KEY_DIRTY, "1")
    _append_jsonl(synced["jsonl"], [_entity("c", "new")])
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "dirty-flag-set"


# ── Branch c — jsonl_path mismatch ──────────────────────────────────────────


def test_branch_c_jsonl_path_mismatch_returns_rebuild(synced, tmp_path):
    """Pointing at a different JSONL than the one this index was built from
    triggers rebuild — the offsets in SQLite reference the original file."""
    other_jsonl = tmp_path / "other.jsonl"
    _write_jsonl(other_jsonl, [_entity("a", "alpha"), _entity("b", "beta")])
    d = decide_on_boot(other_jsonl, synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "jsonl-path-mismatch"


# ── Branch d — sha256 mismatch ──────────────────────────────────────────────


def test_branch_d_jsonl_hash_mismatch_returns_rebuild(synced):
    """Rewriting the start of the JSONL (within the first 4 KiB) flips the
    sha256 fingerprint and forces rebuild."""
    # Overwrite the file with different leading content.
    synced["jsonl"].write_text(
        '{"id":"different","text":"different","versions":[]}\n', encoding="utf-8"
    )
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "jsonl-hash-mismatch"


# ── Branch e — JSONL shrunk ─────────────────────────────────────────────────


def test_branch_e_jsonl_shrunk_returns_rebuild(synced):
    """If the file shrinks below what meta records, SQLite knows offsets
    that no longer exist. Only safe move is rebuild.

    We pin the sha256 first (Branch d would normally short-circuit) and
    nudge meta.jsonl_size_bytes up artificially to simulate shrinkage
    against an unchanged head."""
    original_size = synced["jsonl"].stat().st_size
    # Inflate the recorded size so the actual file is "smaller" than meta.
    _set_meta(
        synced["sqlite"], META_KEY_JSONL_SIZE_BYTES, str(original_size + 100)
    )
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "REBUILD"
    assert d["reason"] == "jsonl-shrunk"


# ── Branch g — JSONL grew → REPLAY ──────────────────────────────────────────


def test_branch_g_jsonl_grew_returns_replay(workspace):
    """REPLAY only fires when JSONL has grown AND the first 4 KiB is
    unchanged. Pad the initial JSONL past 4 KiB so the append doesn't
    flip the sha256 fingerprint (branch d would otherwise short-circuit
    with REBUILD)."""
    _write_jsonl_over_4kb(
        workspace["jsonl"], [_entity("a", "alpha"), _entity("b", "beta")]
    )
    rebuild(workspace["jsonl"], workspace["sqlite"])
    assert workspace["jsonl"].stat().st_size > 4096

    pre_size = workspace["jsonl"].stat().st_size
    _append_jsonl(workspace["jsonl"], [_entity("c", "gamma"), _entity("d", "delta")])
    d = decide_on_boot(workspace["jsonl"], workspace["sqlite"], quiet=True)
    assert d["action"] == "REPLAY"
    assert d["reason"] == "jsonl-grew"
    assert d["last_offset"] == pre_size
    assert d["size_now"] == workspace["jsonl"].stat().st_size


# ── Branch f — READY ────────────────────────────────────────────────────────


def test_branch_f_in_sync_returns_ready(synced):
    d = decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert d["action"] == "READY"
    assert d["reason"] == "in-sync"
    assert d["size_now"] == synced["jsonl"].stat().st_size


# ── Logging ─────────────────────────────────────────────────────────────────


def test_quiet_suppresses_decision_log(synced, caplog):
    with caplog.at_level("INFO", logger="kalairos.sqlite_index"):
        decide_on_boot(synced["jsonl"], synced["sqlite"], quiet=True)
    assert not any("decide_on_boot" in m for m in caplog.messages)


def test_decision_logged_when_not_quiet(synced, caplog):
    with caplog.at_level("INFO", logger="kalairos.sqlite_index"):
        decide_on_boot(synced["jsonl"], synced["sqlite"])
    assert any("decide_on_boot" in m for m in caplog.messages)


# ── replay_forward ──────────────────────────────────────────────────────────


def test_replay_forward_applies_only_new_lines(synced):
    """After a rebuild leaves SQLite in sync, appending new lines and
    running replay_forward should bring in exactly those new lines —
    without re-applying the originals."""
    pre_size = synced["jsonl"].stat().st_size
    _append_jsonl(synced["jsonl"], [_entity("c", "gamma")])

    result = replay_forward(synced["jsonl"], synced["sqlite"])
    assert result["rows_applied"] == 1
    assert result["last_offset"] == synced["jsonl"].stat().st_size

    # Meta updated to the new size.
    assert (
        _get_meta(synced["sqlite"], META_KEY_LAST_JSONL_OFFSET)
        == str(synced["jsonl"].stat().st_size)
    )

    # All three entities are in the index now.
    db = sqlite3.connect(str(synced["sqlite"]))
    try:
        ids = {r[0] for r in db.execute("SELECT id FROM facts").fetchall()}
    finally:
        db.close()
    assert ids == {"a", "b", "c"}


def test_replay_forward_byte_offset_accurate(synced):
    """The new row's jsonl_offset must point at the actual byte start of
    the appended line."""
    pre_size = synced["jsonl"].stat().st_size
    _append_jsonl(synced["jsonl"], [_entity("c", "gamma")])
    replay_forward(synced["jsonl"], synced["sqlite"])

    db = sqlite3.connect(str(synced["sqlite"]))
    try:
        (offset,) = db.execute(
            "SELECT jsonl_offset FROM facts WHERE id = 'c'"
        ).fetchone()
    finally:
        db.close()
    assert offset == pre_size


def test_replay_forward_no_op_when_size_equal(synced):
    """If JSONL hasn't grown beyond last_offset, replay returns a zero
    result without opening a write transaction."""
    result = replay_forward(synced["jsonl"], synced["sqlite"])
    assert result["rows_applied"] == 0
    assert result["last_offset"] == synced["jsonl"].stat().st_size


def test_replay_forward_handles_multiple_appends(synced):
    pre = synced["jsonl"].stat().st_size
    _append_jsonl(synced["jsonl"], [_entity("c", "gamma"), _entity("d", "delta")])
    _append_jsonl(synced["jsonl"], [_entity("e", "epsilon")])
    result = replay_forward(synced["jsonl"], synced["sqlite"])
    assert result["rows_applied"] == 3
    db = sqlite3.connect(str(synced["sqlite"]))
    try:
        ids = {r[0] for r in db.execute("SELECT id FROM facts").fetchall()}
    finally:
        db.close()
    assert ids == {"a", "b", "c", "d", "e"}


def test_replay_forward_skips_malformed_lines(synced, caplog):
    """A malformed line in the appended region is skipped with a warning,
    and valid lines following it are still applied."""
    with synced["jsonl"].open("ab") as f:
        f.write(b"this is not json at all\n")
        f.write((json.dumps(_entity("c", "gamma"), separators=(",", ":")) + "\n").encode())
    with caplog.at_level("WARNING", logger="kalairos.sqlite_index"):
        result = replay_forward(synced["jsonl"], synced["sqlite"])
    assert result["rows_applied"] == 1
    assert any("malformed" in m for m in caplog.messages)


def test_replay_forward_meta_last_offset_matches_file_size(synced):
    """The last_offset stored in meta must equal stat().st_size, not the
    line-counted offset — they can diverge by one byte if the file omits a
    trailing newline."""
    _append_jsonl(synced["jsonl"], [_entity("c", "gamma")])
    replay_forward(synced["jsonl"], synced["sqlite"])
    assert (
        _get_meta(synced["sqlite"], META_KEY_LAST_JSONL_OFFSET)
        == str(synced["jsonl"].stat().st_size)
    )
    assert (
        _get_meta(synced["sqlite"], META_KEY_JSONL_SIZE_BYTES)
        == str(synced["jsonl"].stat().st_size)
    )


# ── End-to-end: rebuild + grow + decide + replay ───────────────────────────


def test_e2e_rebuild_grow_decide_replay(workspace):
    """The full happy-path workflow: rebuild, append, decide identifies
    REPLAY, replay catches up, decide then says READY. Initial JSONL is
    padded past 4 KiB so the append doesn't flip the fingerprint."""
    _write_jsonl_over_4kb(workspace["jsonl"], [_entity("a", "alpha")])
    rebuild(workspace["jsonl"], workspace["sqlite"])

    _append_jsonl(workspace["jsonl"], [_entity("b", "beta")])

    d = decide_on_boot(workspace["jsonl"], workspace["sqlite"], quiet=True)
    assert d["action"] == "REPLAY"

    result = replay_forward(workspace["jsonl"], workspace["sqlite"])
    assert result["rows_applied"] == 1

    d2 = decide_on_boot(workspace["jsonl"], workspace["sqlite"], quiet=True)
    assert d2["action"] == "READY"
