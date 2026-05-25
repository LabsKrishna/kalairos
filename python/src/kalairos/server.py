"""LedgerServer — HTTP endpoint for cross-process Ledger access.

Phase 1.4 of the agent-platform: completes the single-writer
arbitration described in project_agent_platform.md. Python is the sole
writer to `ledger.jsonl`; Node services emit "append this" events to
this server over HTTP, which serializes them through the Ledger's own
threading.Lock + SQLite BEGIN IMMEDIATE — no contention on the canonical
file.

Routes:
  POST /append            — body = JSON record → 200 {offset, size}
  GET  /health            — 200 {open, jsonl_path, sqlite_path}
  GET  /entities/<id>     — 200 record | 404
  GET  /entities          — query params: namespace, workspace,
                            include_deleted (true/false), limit (int)
  GET  /                  — Control plane HTML page (Phase 4.1)
  GET  /runs              — 200 {runs: [...]} — distinct runs in the ledger
  GET  /runs/<id>/events  — 200 {events: [...]} — chronological events
  GET  /events/stream     — Server-Sent Events stream of new appends (Phase 4.3)

Transport: stdlib http.server (ThreadingHTTPServer). Each request runs in
its own thread. Thread safety is delegated to the Ledger — JsonlAppender
holds a threading.Lock, and SqliteStreamer wraps every write in
BEGIN IMMEDIATE.

For local-only deployment (host=127.0.0.1). Remote exposure should sit
behind a proper auth layer that this Phase doesn't ship.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .control_plane import (
    EVENT_BUCKETS,
    HTML_PAGE,
    events_for_run,
    list_runs,
    record_to_sse_event,
)
from .ledger import Ledger


# How long to wait for a new event before sending a heartbeat. Browsers
# drop SSE connections that go quiet for too long; 15s is well inside
# every default I've checked.
_SSE_HEARTBEAT_INTERVAL_S = 15.0

# Per-client SSE queue depth. If a client falls behind beyond this,
# the oldest events get dropped (a comment-line marker is sent so the
# client knows to resync). Sized for short network blips, not extended
# outages.
_SSE_QUEUE_DEPTH = 1000

log = logging.getLogger(__name__)


class LedgerServer:
    """HTTP server wrapping a Ledger.

    Usage:
        ledger = Ledger(jsonl, sqlite)
        ledger.open()
        server = LedgerServer(ledger, host="127.0.0.1", port=0)
        server.start()
        # ... clients hit server.url ...
        server.stop()
        ledger.close()

    port=0 means "let the OS choose"; the assigned port is available on
    `server.port` (and reflected in `server.url`) after `start()`.
    """

    def __init__(
        self,
        ledger: Ledger,
        host: str = "127.0.0.1",
        port: int = 0,
    ):
        self.ledger = ledger
        self.host = host
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Bind, serve in a daemon thread. Non-blocking. Idempotent."""
        if self._server is not None:
            return
        handler_cls = _build_handler(self.ledger)
        self._server = ThreadingHTTPServer((self.host, self.port), handler_cls)
        # If port=0 was passed, the OS assigned a port; reflect that.
        self.port = self._server.server_port
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name=f"LedgerServer:{self.port}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        """Graceful shutdown. Idempotent."""
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        self._server = None
        self._thread = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"


# ── Handler factory ────────────────────────────────────────────────────────


def _build_handler(ledger: Ledger):
    """Build a BaseHTTPRequestHandler subclass that closes over `ledger`.

    The handler class is constructed per LedgerServer instance so each
    server has its own ledger reference; this avoids module-level state
    that would prevent running multiple LedgerServers in one process
    (useful for tests).
    """

    class Handler(BaseHTTPRequestHandler):
        # Route stdlib's HTTP log line through our logger so it
        # respects the caller's logging configuration.
        def log_message(self, format, *args):  # noqa: A002 - stdlib name
            log.info("LedgerServer: " + format, *args)

        def do_GET(self):  # noqa: N802 - stdlib name
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/":
                return self._handle_control_plane()
            if path == "/health":
                return self._json(200, _health(ledger))
            if path == "/entities":
                return self._handle_list_entities(parsed.query)
            if path.startswith("/entities/"):
                eid = path[len("/entities/") :]
                return self._handle_get_entity(eid)
            if path == "/runs":
                return self._handle_list_runs()
            # /runs/<id>/events — match without a trailing slash too.
            if path.startswith("/runs/"):
                tail = path[len("/runs/") :]
                if tail.endswith("/events"):
                    run_id = tail[: -len("/events")]
                    return self._handle_run_events(run_id)
            if path == "/events/stream":
                return self._handle_sse()
            return self._json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802 - stdlib name
            if urlparse(self.path).path == "/append":
                return self._handle_append()
            return self._json(404, {"error": "not found"})

        # ── Endpoints ──────────────────────────────────────────────────

        def _handle_append(self):
            try:
                body = self._read_json_body()
            except (ValueError, json.JSONDecodeError) as e:
                return self._json(400, {"error": f"invalid JSON body: {e}"})
            if not isinstance(body, dict):
                return self._json(400, {"error": "body must be a JSON object"})
            try:
                offset = ledger.append(body)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:
                log.exception("LedgerServer: /append failed")
                return self._json(500, {"error": str(e)})
            try:
                size = ledger.jsonl_path.stat().st_size
            except OSError:
                size = None
            return self._json(200, {"offset": offset, "size": size})

        def _handle_get_entity(self, entity_id: str):
            if not entity_id:
                return self._json(400, {"error": "entity id required"})
            try:
                rec = ledger.get(entity_id)
            except Exception as e:
                log.exception("LedgerServer: /entities/<id> failed")
                return self._json(500, {"error": str(e)})
            if rec is None:
                return self._json(404, {"error": "not found"})
            return self._json(200, rec)

        def _handle_control_plane(self):
            """Serve the inline control-plane HTML. Static — the JS in
            the page fetches /runs and /runs/<id>/events for data."""
            body = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle_list_runs(self):
            try:
                runs = list_runs(ledger)
            except Exception as e:
                log.exception("LedgerServer: /runs failed")
                return self._json(500, {"error": str(e)})
            return self._json(200, {"runs": runs})

        def _handle_sse(self):
            """Stream new ledger appends as Server-Sent Events.

            Phase 4.3: subscribes to the Ledger's pub/sub on entry,
            unsubscribes on disconnect. Heartbeats every 15s to keep
            the connection alive through browser/proxy idle timeouts.

            The Ledger subscriber fires on the append thread (which
            may be the HTTP /append worker or the in-process caller);
            we use a bounded queue to hand events off to the SSE
            handler thread. If the client falls behind beyond
            _SSE_QUEUE_DEPTH events, the oldest are dropped and the
            client receives a comment-line marker so it can re-sync
            via /runs and /runs/<id>/events.
            """
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            # Disable proxy buffering — nginx, Cloudflare, etc. need
            # this hint to stream immediately rather than collecting
            # bytes for a content-length write.
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            q: queue.Queue = queue.Queue(maxsize=_SSE_QUEUE_DEPTH)
            dropped = {"n": 0}

            def listener(record: dict) -> None:
                try:
                    q.put_nowait(record)
                except queue.Full:
                    # Drop the oldest item to make room, but also count
                    # how many we shed so the client gets a marker.
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        pass
                    try:
                        q.put_nowait(record)
                    except queue.Full:
                        dropped["n"] += 1

            unsubscribe = ledger.subscribe(listener)
            try:
                # Confirm the stream is open — the client uses this to
                # flip from "connecting…" to "live".
                self._sse_write(": connected\n\n")
                while True:
                    try:
                        record = q.get(timeout=_SSE_HEARTBEAT_INTERVAL_S)
                    except queue.Empty:
                        # Idle — heartbeat to keep the socket warm.
                        self._sse_write(": heartbeat\n\n")
                        continue
                    if dropped["n"] > 0:
                        self._sse_write(
                            f": dropped {dropped['n']} events; resync via /runs\n\n"
                        )
                        dropped["n"] = 0
                    payload = json.dumps(
                        record_to_sse_event(record), ensure_ascii=False
                    )
                    self._sse_write(f"data: {payload}\n\n")
            except (BrokenPipeError, ConnectionResetError, ValueError):
                # Client closed the connection. Normal — fall through
                # to unsubscribe in the finally.
                pass
            except OSError as e:
                # Often a benign "Broken pipe" on socket close; log at
                # info, not error, to avoid noise.
                log.info("LedgerServer: /events/stream closed: %s", e)
            finally:
                unsubscribe()

        def _sse_write(self, text: str) -> None:
            """Write + flush. Raises BrokenPipeError/etc on closed
            socket so _handle_sse can clean up."""
            self.wfile.write(text.encode("utf-8"))
            self.wfile.flush()

        def _handle_run_events(self, run_id: str):
            if not run_id:
                return self._json(400, {"error": "run id required"})
            try:
                events = events_for_run(ledger, run_id)
            except Exception as e:
                log.exception("LedgerServer: /runs/<id>/events failed")
                return self._json(500, {"error": str(e)})
            return self._json(200, {"events": events})

        def _handle_list_entities(self, raw_query: str):
            params = parse_qs(raw_query)
            kwargs = {}
            if "namespace" in params:
                kwargs["namespace"] = params["namespace"][0]
            if "workspace" in params:
                kwargs["workspace"] = params["workspace"][0]
            if "include_deleted" in params:
                kwargs["include_deleted"] = (
                    params["include_deleted"][0].lower() == "true"
                )
            if "limit" in params:
                try:
                    kwargs["limit"] = int(params["limit"][0])
                except ValueError:
                    return self._json(
                        400, {"error": "limit must be an integer"}
                    )
            try:
                rows = ledger.query(**kwargs)
            except Exception as e:
                log.exception("LedgerServer: /entities failed")
                return self._json(500, {"error": str(e)})
            return self._json(200, rows)

        # ── helpers ────────────────────────────────────────────────────

        def _read_json_body(self) -> object:
            length = int(self.headers.get("Content-Length", "0"))
            if length == 0:
                raise ValueError("empty body")
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw)

        def _json(self, status: int, payload: object) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def _health(ledger: Ledger) -> dict:
    return {
        "open": ledger.streamer.db is not None,
        "jsonl_path": str(ledger.jsonl_path),
        "sqlite_path": str(ledger.sqlite_path),
    }
