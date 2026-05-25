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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .control_plane import HTML_PAGE, events_for_run, list_runs
from .ledger import Ledger

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
