"""Tests for the SSE live-update endpoint — Phase 4.3.

Uses a real LedgerServer + HTTP client to verify the end-to-end stream
behavior: subscribers fire on append, events arrive in SSE format,
disconnect cleans up.
"""

import json
import socket
import threading
import time
import urllib.request
from typing import Any

import pytest

from kalairos import Agent, Ledger, LedgerServer, tool
from kalairos.control_plane import record_to_sse_event
from kalairos.run import Run


# ── fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


@pytest.fixture
def server(ledger):
    s = LedgerServer(ledger, host="127.0.0.1", port=0)
    s.start()
    try:
        yield s
    finally:
        s.stop()


@pytest.fixture
def echo_agent():
    @tool(
        description="Echo back its input",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    def echo(text: str) -> str:
        return f"echo:{text}"

    return Agent(name="sse-tester", tools=[echo])


# ── SSE event shape ───────────────────────────────────────────────────────


def test_record_to_sse_event_shape():
    """The wire format must carry exactly the fields the client UI reads."""
    record = {
        "id": "run-x/0/run_started",
        "metadata": {
            "run_id": "run-x",
            "agent_name": "agent-a",
            "seq": 0,
            "event_type": "run_started",
            "payload": {"goal": "do the thing"},
        },
        "versions": [{"timestamp": 1234567890, "text": "x", "ingestAt": 1234567890}],
    }
    ev = record_to_sse_event(record)
    assert ev == {
        "run_id": "run-x",
        "agent_name": "agent-a",
        "seq": 0,
        "event_type": "run_started",
        "bucket": "lifecycle",
        "timestamp": 1234567890,
        "payload": {"goal": "do the thing"},
    }


def test_record_to_sse_event_handles_record_without_metadata():
    """Raw entities (not run events) come through with run_id=None so
    the client can ignore them."""
    record = {"id": "ent-1", "text": "raw entity"}
    ev = record_to_sse_event(record)
    assert ev["run_id"] is None
    assert ev["event_type"] is None


def test_record_to_sse_event_unknown_event_falls_back_to_other_bucket():
    record = {
        "metadata": {
            "run_id": "r",
            "event_type": "some-new-event-type",
            "payload": {},
        },
    }
    ev = record_to_sse_event(record)
    assert ev["bucket"] == "other"


# ── SSE streaming end-to-end ──────────────────────────────────────────────


class _SSEClient:
    """Minimal SSE client that collects parsed `data:` payloads.

    Reads line-by-line on a background thread and stuffs parsed events
    into a Queue the test can drain. Stops on close()."""

    def __init__(self, url: str):
        self.url = url
        self._resp = None
        self._thread = None
        self.events: list[dict] = []
        self.comments: list[str] = []
        self._stop = threading.Event()
        self._opened = threading.Event()

    def start(self) -> None:
        self._resp = urllib.request.urlopen(self.url, timeout=5)
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

    def _reader(self) -> None:
        try:
            for raw in self._resp:
                if self._stop.is_set():
                    break
                line = raw.decode("utf-8")
                if line.startswith(":"):
                    self.comments.append(line.rstrip("\n"))
                    self._opened.set()
                elif line.startswith("data: "):
                    try:
                        self.events.append(json.loads(line[len("data: ") :].rstrip()))
                    except json.JSONDecodeError:
                        pass
                # blank lines (event boundaries) are ignored
        except Exception:
            pass

    def wait_for_open(self, timeout: float = 2.0) -> bool:
        return self._opened.wait(timeout)

    def wait_for_events(self, n: int, timeout: float = 2.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if len(self.events) >= n:
                return True
            time.sleep(0.02)
        return False

    def close(self) -> None:
        self._stop.set()
        if self._resp is not None:
            try:
                self._resp.close()
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)


def test_sse_sends_connected_comment_on_open(server):
    client = _SSEClient(f"{server.url}/events/stream")
    client.start()
    try:
        assert client.wait_for_open(timeout=2.0), "SSE never opened"
        assert any("connected" in c for c in client.comments)
    finally:
        client.close()


def test_sse_streams_appended_record(server, ledger, echo_agent):
    """Append after the SSE connection is open → the event arrives in
    the stream."""
    client = _SSEClient(f"{server.url}/events/stream")
    client.start()
    try:
        assert client.wait_for_open(timeout=2.0)
        # Now append something via a Run so we get a properly-shaped event.
        r = Run(echo_agent, ledger, goal="test")
        r.start()
        assert client.wait_for_events(1, timeout=2.0), "no event arrived"
        ev = client.events[0]
        assert ev["event_type"] == "run_started"
        assert ev["run_id"] == r.run_id
        assert ev["agent_name"] == "sse-tester"
    finally:
        client.close()


def test_sse_streams_multiple_records_in_order(server, ledger, echo_agent):
    client = _SSEClient(f"{server.url}/events/stream")
    client.start()
    try:
        assert client.wait_for_open(timeout=2.0)
        r = Run(echo_agent, ledger)
        r.start()
        r.think("step one")
        r.think("step two")
        r.finish(result="done")
        assert client.wait_for_events(4, timeout=2.0)
        types = [e["event_type"] for e in client.events[:4]]
        assert types == [
            "run_started",
            "thought",
            "thought",
            "run_completed",
        ]
    finally:
        client.close()


def test_sse_ignores_appends_before_connection(server, ledger, echo_agent):
    """Events appended BEFORE the SSE client connects should not be
    backfilled — the client is expected to load /runs first, then
    open the stream for new events only."""
    # Append an event before connecting.
    r = Run(echo_agent, ledger)
    r.start()

    client = _SSEClient(f"{server.url}/events/stream")
    client.start()
    try:
        assert client.wait_for_open(timeout=2.0)
        # Wait a bit; we should NOT receive the pre-connection event.
        time.sleep(0.2)
        assert client.events == []
        # New event after connecting arrives.
        r.finish(result="ok")
        assert client.wait_for_events(1, timeout=2.0)
        assert client.events[0]["event_type"] == "run_completed"
    finally:
        client.close()


def test_sse_unsubscribes_on_disconnect(ledger, echo_agent, monkeypatch):
    """Closing the connection must remove the subscriber so the ledger
    isn't holding references to dead clients. Verified by inspecting
    the ledger's subscriber list before / during / after.

    Builds a server INSIDE the test so the monkeypatched heartbeat
    interval is picked up when LedgerServer's handler is constructed.
    The default 15s would force the test to wait an entire cycle for
    the handler to notice the disconnect (no events flowing → blocked
    on queue.get). 0.1s lets the heartbeat write fail-and-cleanup
    promptly when the client socket goes away."""
    from kalairos import server as server_module

    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_S", 0.1)

    s = LedgerServer(ledger, host="127.0.0.1", port=0)
    s.start()
    try:
        initial = len(ledger._subscribers)
        client = _SSEClient(f"{s.url}/events/stream")
        client.start()
        try:
            assert client.wait_for_open(timeout=2.0)
            # During the connection, one extra subscriber registered.
            assert len(ledger._subscribers) == initial + 1
        finally:
            client.close()
        # After close, the SSE handler's finally block should fire on
        # the next heartbeat (≤0.1s) when the write to the dead socket
        # raises.
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if len(ledger._subscribers) == initial:
                break
            time.sleep(0.05)
        assert len(ledger._subscribers) == initial
    finally:
        s.stop()


def test_sse_multiple_clients_each_get_all_events(server, ledger, echo_agent):
    """Two clients both subscribed; both should receive every event."""
    c1 = _SSEClient(f"{server.url}/events/stream")
    c2 = _SSEClient(f"{server.url}/events/stream")
    c1.start()
    c2.start()
    try:
        assert c1.wait_for_open(timeout=2.0)
        assert c2.wait_for_open(timeout=2.0)
        r = Run(echo_agent, ledger)
        r.start()
        r.finish(result="done")
        assert c1.wait_for_events(2, timeout=2.0)
        assert c2.wait_for_events(2, timeout=2.0)
        assert [e["event_type"] for e in c1.events[:2]] == [
            "run_started", "run_completed"
        ]
        assert [e["event_type"] for e in c2.events[:2]] == [
            "run_started", "run_completed"
        ]
    finally:
        c1.close()
        c2.close()


def test_sse_content_type_header(server):
    """text/event-stream is required for browser EventSource clients."""
    resp = urllib.request.urlopen(f"{server.url}/events/stream", timeout=5)
    try:
        ct = resp.headers.get("Content-Type", "")
        assert "text/event-stream" in ct
        cc = resp.headers.get("Cache-Control", "")
        assert "no-cache" in cc
    finally:
        resp.close()


# ── HTML page integration ─────────────────────────────────────────────────


def test_html_page_opens_event_source():
    """The page must connect to /events/stream so live updates work."""
    from kalairos.control_plane import HTML_PAGE
    assert "/events/stream" in HTML_PAGE
    assert "EventSource" in HTML_PAGE
    assert "connectSSE" in HTML_PAGE
