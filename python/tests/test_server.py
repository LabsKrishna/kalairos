"""Tests for the LedgerServer HTTP endpoint — Phase 1.4.

Covers each route, error responses, query-param parsing, and the
concurrent-appends-via-HTTP contract (which exercises the JsonlAppender
lock + SqliteStreamer txn frame end-to-end).
"""

import http.client
import json
import threading

import pytest

from kalairos import Ledger, LedgerServer


@pytest.fixture
def server(tmp_path):
    ledger = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    ledger.open()
    srv = LedgerServer(ledger, host="127.0.0.1", port=0)
    srv.start()
    try:
        yield srv
    finally:
        srv.stop()
        ledger.close()


def _req(server: LedgerServer, method: str, path: str, body=None):
    """Make an HTTP request to the server and return (status, parsed_json)."""
    conn = http.client.HTTPConnection(server.host, server.port, timeout=5)
    try:
        headers = {}
        body_bytes = None
        if body is not None:
            body_bytes = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=body_bytes, headers=headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        parsed = json.loads(raw) if raw else None
        return resp.status, parsed
    finally:
        conn.close()


def _raw_post(server: LedgerServer, path: str, body_bytes: bytes,
              content_type: str = "application/json"):
    """Bypass the JSON wrapping — used to test malformed-body handling."""
    conn = http.client.HTTPConnection(server.host, server.port, timeout=5)
    try:
        conn.request(
            "POST", path, body=body_bytes,
            headers={"Content-Type": content_type},
        )
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        return resp.status, json.loads(raw) if raw else None
    finally:
        conn.close()


# ── Lifecycle ──────────────────────────────────────────────────────────────


def test_server_start_assigns_port_when_zero(tmp_path):
    ledger = Ledger(tmp_path / "l.jsonl", tmp_path / "i.sqlite")
    ledger.open()
    srv = LedgerServer(ledger, port=0)
    srv.start()
    try:
        assert srv.port != 0  # OS assigned a real port
        assert srv.url == f"http://127.0.0.1:{srv.port}"
    finally:
        srv.stop()
        ledger.close()


def test_server_start_is_idempotent(server):
    server.start()  # second start must not raise
    assert server._server is not None


def test_server_stop_is_idempotent(tmp_path):
    ledger = Ledger(tmp_path / "l.jsonl", tmp_path / "i.sqlite")
    ledger.open()
    srv = LedgerServer(ledger, port=0)
    srv.start()
    srv.stop()
    srv.stop()  # must not raise
    ledger.close()


# ── /health ────────────────────────────────────────────────────────────────


def test_health_returns_status(server):
    status, body = _req(server, "GET", "/health")
    assert status == 200
    assert body["open"] is True
    assert "jsonl_path" in body
    assert "sqlite_path" in body


# ── POST /append ───────────────────────────────────────────────────────────


def test_append_writes_record(server):
    status, body = _req(server, "POST", "/append", {"id": "ent", "text": "hello"})
    assert status == 200
    assert body["offset"] == 0
    assert isinstance(body["size"], int) and body["size"] > 0


def test_append_returns_increasing_offsets(server):
    _, b1 = _req(server, "POST", "/append", {"id": "a", "text": "alpha"})
    _, b2 = _req(server, "POST", "/append", {"id": "b", "text": "beta"})
    assert b1["offset"] == 0
    assert b2["offset"] == b1["size"]
    assert b2["size"] > b1["size"]


def test_append_with_invalid_json_body_returns_400(server):
    status, body = _raw_post(server, "/append", b"this is not json")
    assert status == 400
    assert "invalid JSON" in body["error"]


def test_append_with_non_object_body_returns_400(server):
    """A bare JSON array isn't a valid record."""
    status, body = _raw_post(server, "/append", b'["array", "not", "object"]')
    assert status == 400
    assert "JSON object" in body["error"]


def test_append_record_without_id_returns_400(server):
    status, body = _req(server, "POST", "/append", {"text": "no id here"})
    assert status == 400
    assert "id" in body["error"]


def test_append_with_empty_body_returns_400(server):
    status, body = _raw_post(server, "/append", b"")
    assert status == 400


# ── GET /entities/<id> ─────────────────────────────────────────────────────


def test_get_entity_after_append(server):
    _req(server, "POST", "/append", {"id": "ent", "text": "hello"})
    status, body = _req(server, "GET", "/entities/ent")
    assert status == 200
    assert body["id"] == "ent"
    assert body["text"] == "hello"


def test_get_entity_returns_404_for_missing(server):
    status, body = _req(server, "GET", "/entities/does-not-exist")
    assert status == 404


def test_get_entity_returns_400_for_empty_id(server):
    # /entities/ with trailing slash → empty id
    status, body = _req(server, "GET", "/entities/")
    assert status == 400


# ── GET /entities ──────────────────────────────────────────────────────────


def test_list_entities_empty(server):
    status, body = _req(server, "GET", "/entities")
    assert status == 200
    assert body == []


def test_list_entities_returns_all_live(server):
    for i in range(3):
        _req(server, "POST", "/append", {"id": f"e{i}", "text": f"t{i}"})
    status, body = _req(server, "GET", "/entities")
    assert status == 200
    assert {r["id"] for r in body} == {"e0", "e1", "e2"}


def test_list_entities_namespace_filter(server):
    _req(server, "POST", "/append", {"id": "a", "text": "x", "memoryType": "working"})
    _req(server, "POST", "/append", {"id": "b", "text": "y", "memoryType": "long-term"})
    status, body = _req(server, "GET", "/entities?namespace=working")
    assert status == 200
    assert {r["id"] for r in body} == {"a"}


def test_list_entities_workspace_filter(server):
    _req(server, "POST", "/append", {"id": "a", "text": "x", "workspaceId": "alpha"})
    _req(server, "POST", "/append", {"id": "b", "text": "y", "workspaceId": "beta"})
    status, body = _req(server, "GET", "/entities?workspace=alpha")
    assert {r["id"] for r in body} == {"a"}


def test_list_entities_include_deleted(server):
    _req(server, "POST", "/append", {"id": "a", "text": "x"})
    _req(server, "POST", "/append",
         {"id": "b", "text": "y", "deletedAt": 999, "deletedBy": "alice"})

    _, live_only = _req(server, "GET", "/entities")
    assert {r["id"] for r in live_only} == {"a"}

    _, with_deleted = _req(server, "GET", "/entities?include_deleted=true")
    assert {r["id"] for r in with_deleted} == {"a", "b"}


def test_list_entities_limit(server):
    for i in range(5):
        _req(server, "POST", "/append", {"id": f"e{i}", "text": f"t{i}"})
    _, body = _req(server, "GET", "/entities?limit=2")
    assert len(body) == 2


def test_list_entities_invalid_limit_returns_400(server):
    status, body = _req(server, "GET", "/entities?limit=not-a-number")
    assert status == 400
    assert "limit" in body["error"]


# ── Routing ────────────────────────────────────────────────────────────────


def test_unknown_path_returns_404(server):
    status, _ = _req(server, "GET", "/no-such-path")
    assert status == 404


def test_unknown_post_path_returns_404(server):
    status, _ = _req(server, "POST", "/no-such-path", {"x": 1})
    assert status == 404


# ── Concurrency ────────────────────────────────────────────────────────────


def test_concurrent_appends_serialize_safely(server):
    """Many parallel POST /append calls must produce one valid line per
    request with no torn writes. Exercises the JsonlAppender lock +
    SqliteStreamer BEGIN IMMEDIATE end-to-end over HTTP."""
    n_threads = 8
    n_per_thread = 10
    errors: list[str] = []

    def worker(tid: int) -> None:
        try:
            for i in range(n_per_thread):
                status, _ = _req(
                    server,
                    "POST",
                    "/append",
                    {"id": f"t{tid}-i{i}", "text": "x"},
                )
                if status != 200:
                    errors.append(f"thread {tid} got status {status}")
        except Exception as e:
            errors.append(f"thread {tid} raised: {e}")

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors

    _, listed = _req(server, "GET", "/entities?limit=200")
    assert len(listed) == n_threads * n_per_thread
    ids = {r["id"] for r in listed}
    expected = {f"t{t}-i{i}" for t in range(n_threads) for i in range(n_per_thread)}
    assert ids == expected
