"""Tests for JsonlAppender — sequential durable writes, atomic rewrites,
malformed-line skip, orphan-tmp reap, thread-safe concurrent appends."""

import json
import threading

import pytest

from kalairos.jsonl import JsonlAppender


@pytest.fixture
def ledger(tmp_path):
    return JsonlAppender(tmp_path / "ledger.jsonl")


def _encoded(record: dict) -> bytes:
    return (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")


def test_append_load_roundtrip(ledger):
    records = [{"id": "a", "n": 1}, {"id": "b", "n": 2}, {"id": "c", "n": 3}]
    for r in records:
        ledger.append(r)
    assert ledger.load_raw() == records


def test_append_returns_byte_offset(ledger):
    a = {"id": "a"}
    b = {"id": "b"}
    c = {"id": "c"}

    off_a = ledger.append(a)
    off_b = ledger.append(b)
    off_c = ledger.append(c)

    assert off_a == 0
    assert off_b == len(_encoded(a))
    assert off_c == len(_encoded(a)) + len(_encoded(b))


def test_load_empty_when_path_does_not_exist(tmp_path):
    appender = JsonlAppender(tmp_path / "does-not-exist.jsonl")
    assert appender.load_raw() == []


def test_append_creates_parent_directory(tmp_path):
    """First write should mkdir -p; users shouldn't pre-create the dir."""
    nested = tmp_path / "nested" / "deeply" / "ledger.jsonl"
    appender = JsonlAppender(nested)
    appender.append({"id": "a"})
    assert nested.exists()
    assert appender.load_raw() == [{"id": "a"}]


def test_load_skips_malformed_lines(ledger, caplog):
    ledger.path.write_text(
        '{"ok": 1}\nnot json at all\n{"ok": 2}\n', encoding="utf-8"
    )
    with caplog.at_level("WARNING", logger="kalairos.jsonl"):
        rows = ledger.load_raw()
    assert rows == [{"ok": 1}, {"ok": 2}]
    assert any("malformed" in m for m in caplog.messages)


def test_load_reaps_orphan_tmp(tmp_path, caplog):
    ledger = JsonlAppender(tmp_path / "ledger.jsonl")
    tmp = tmp_path / "ledger.jsonl.tmp"
    tmp.write_text("stale partial write from a crashed rewrite", encoding="utf-8")
    with caplog.at_level("WARNING", logger="kalairos.jsonl"):
        rows = ledger.load_raw()
    assert rows == []
    assert not tmp.exists(), "orphan .tmp must be reaped"
    assert any("reaped" in m for m in caplog.messages)


def test_persist_all_atomic_rewrite(ledger):
    ledger.append({"id": "a"})
    ledger.append({"id": "b"})
    ledger.persist_all([{"id": "x"}, {"id": "y"}, {"id": "z"}])
    assert ledger.load_raw() == [{"id": "x"}, {"id": "y"}, {"id": "z"}]
    assert not (ledger.path.parent / "ledger.jsonl.tmp").exists()


def test_persist_all_empty_clears_file(ledger):
    ledger.append({"id": "a"})
    ledger.persist_all([])
    assert ledger.load_raw() == []
    # File still exists (we wrote zero bytes), just has nothing in it.
    assert ledger.path.exists()
    assert ledger.path.read_bytes() == b""


def test_persist_all_then_append(ledger):
    ledger.persist_all([{"id": "a"}])
    ledger.append({"id": "b"})
    assert ledger.load_raw() == [{"id": "a"}, {"id": "b"}]


def test_concurrent_appends_are_thread_safe(ledger):
    """Many threads appending simultaneously must produce one valid line
    per append, with no torn writes."""
    n_threads = 16
    n_per_thread = 50
    errors: list[Exception] = []

    def worker(tid: int) -> None:
        try:
            for i in range(n_per_thread):
                ledger.append({"tid": tid, "i": i})
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    rows = ledger.load_raw()
    assert len(rows) == n_threads * n_per_thread

    seen = {(r["tid"], r["i"]) for r in rows}
    assert len(seen) == n_threads * n_per_thread, "every (tid, i) must appear once"


def test_concurrent_offsets_point_at_their_lines(ledger):
    """The offset returned by `append` must point at that record's bytes,
    even under concurrent writers."""
    n_threads = 8
    n_per_thread = 25
    results_lock = threading.Lock()
    results: list[tuple[int, dict]] = []

    def worker(tid: int) -> None:
        for i in range(n_per_thread):
            rec = {"tid": tid, "i": i}
            offset = ledger.append(rec)
            with results_lock:
                results.append((offset, rec))

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    raw = ledger.path.read_bytes()
    for offset, rec in results:
        expected = _encoded(rec)
        assert raw[offset : offset + len(expected)] == expected, (
            f"record at offset {offset} doesn't match expected {rec!r}"
        )
