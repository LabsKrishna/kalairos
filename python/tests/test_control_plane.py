"""Tests for the control plane — Phase 4.1.

Two layers:
- Pure-function `list_runs` / `events_for_run` over a Ledger — fast,
  no HTTP.
- LedgerServer endpoint integration — confirms `/`, `/runs`, and
  `/runs/<id>/events` route correctly and return the expected JSON.
"""

import json
import time
import urllib.error
import urllib.request
from typing import Any

import pytest

from kalairos import Agent, Executor, Ledger, LedgerServer, StepNode, WorkflowGraph, tool
from kalairos.control_plane import (
    EVENT_BUCKETS,
    HTML_PAGE,
    events_for_run,
    list_runs,
)
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

    return Agent(name="echo-agent", instructions="be terse", tools=[echo])


def _drive_run(agent: Agent, ledger: Ledger, *, finish_value: Any = "ok") -> Run:
    """Hand-drive a Run through start → think → tool → finish so tests
    have a populated trail without going through the Executor."""
    r = Run(agent, ledger, goal="test goal")
    r.start()
    r.think("planning")
    r.call_tool("echo", text="hello")
    r.finish(result=finish_value)
    return r


# ── list_runs ─────────────────────────────────────────────────────────────


def test_list_runs_empty_ledger(ledger):
    assert list_runs(ledger) == []


def test_list_runs_one_completed_run(echo_agent, ledger):
    r = _drive_run(echo_agent, ledger, finish_value="done")
    runs = list_runs(ledger)
    assert len(runs) == 1
    [run] = runs
    assert run["run_id"] == r.run_id
    assert run["agent"] == "echo-agent"
    assert run["status"] == "completed"
    assert run["goal"] == "test goal"
    assert run["result"] == "done"
    assert run["event_count"] == 5  # start, think, tool req, tool result, finish
    assert run["started_at"] is not None
    assert run["ended_at"] is not None
    assert run["duration_ms"] is not None


def test_list_runs_running_status_when_no_end_event(echo_agent, ledger):
    r = Run(echo_agent, ledger, goal="long running")
    r.start()
    r.think("still working")
    # Don't finish — should report status=running.
    runs = list_runs(ledger)
    [run] = runs
    assert run["status"] == "running"
    assert run["ended_at"] is None
    assert run["duration_ms"] is None
    assert run["result"] is None


def test_list_runs_failed_run_includes_error(echo_agent, ledger):
    r = Run(echo_agent, ledger)
    r.start()
    r.fail("simulated failure")
    [run] = list_runs(ledger)
    assert run["status"] == "failed"
    assert run["error"] == "simulated failure"


def test_list_runs_orders_running_first_then_newest_end(echo_agent, ledger):
    """Running runs pin to the top; among ended ones, newest end first."""
    r_old = _drive_run(echo_agent, ledger, finish_value="old")
    time.sleep(0.01)  # ensure timestamp ordering
    r_new = _drive_run(echo_agent, ledger, finish_value="new")
    # Start a third that doesn't finish.
    r_running = Run(echo_agent, ledger)
    r_running.start()

    runs = list_runs(ledger)
    ids = [r["run_id"] for r in runs]
    assert ids[0] == r_running.run_id  # running pinned top
    # Newer of the ended runs comes before older.
    assert ids.index(r_new.run_id) < ids.index(r_old.run_id)


def test_list_runs_ignores_non_run_records(ledger):
    """Records without metadata.run_id (e.g. raw entities from another
    use of the ledger) must not appear as runs."""
    ledger.append({
        "id": "ent-1",
        "text": "not an event",
        "memoryType": "long-term",
    })
    assert list_runs(ledger) == []


def test_list_runs_groups_events_by_run_id(echo_agent, ledger):
    r1 = _drive_run(echo_agent, ledger, finish_value="A")
    r2 = _drive_run(echo_agent, ledger, finish_value="B")
    runs = list_runs(ledger)
    assert len(runs) == 2
    by_id = {r["run_id"]: r for r in runs}
    assert by_id[r1.run_id]["result"] == "A"
    assert by_id[r2.run_id]["result"] == "B"


# ── events_for_run ────────────────────────────────────────────────────────


def test_events_for_run_returns_events_in_seq_order(echo_agent, ledger):
    r = _drive_run(echo_agent, ledger)
    events = events_for_run(ledger, r.run_id)
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)
    assert seqs == [0, 1, 2, 3, 4]


def test_events_for_run_each_has_bucket_and_delta(echo_agent, ledger):
    r = _drive_run(echo_agent, ledger)
    events = events_for_run(ledger, r.run_id)
    for ev in events:
        assert "bucket" in ev
        assert ev["bucket"] in {
            "lifecycle", "think", "tool", "llm", "node", "handoff", "other"
        }
        assert ev["delta_ms"] >= 0
    # First event delta is 0 (relative to itself)
    assert events[0]["delta_ms"] == 0
    # Each subsequent delta is non-decreasing
    deltas = [e["delta_ms"] for e in events]
    assert deltas == sorted(deltas)


def test_events_for_run_unknown_run_id_returns_empty(echo_agent, ledger):
    _drive_run(echo_agent, ledger)
    assert events_for_run(ledger, "does-not-exist") == []


def test_events_for_run_isolates_runs(echo_agent, ledger):
    """Events from run A must not appear in events_for_run(B)."""
    r_a = _drive_run(echo_agent, ledger, finish_value="A")
    r_b = _drive_run(echo_agent, ledger, finish_value="B")
    ev_a = events_for_run(ledger, r_a.run_id)
    ev_b = events_for_run(ledger, r_b.run_id)
    # Each run has 5 events.
    assert len(ev_a) == 5
    assert len(ev_b) == 5
    # The finish event's payload differs by run.
    finish_a = next(e for e in ev_a if e["event_type"] == "run_completed")
    finish_b = next(e for e in ev_b if e["event_type"] == "run_completed")
    assert finish_a["payload"]["result"] == "A"
    assert finish_b["payload"]["result"] == "B"


def test_event_buckets_cover_all_known_event_types():
    """Every event type the runtime emits should have a bucket so the UI
    never renders 'other' for known events."""
    known_events = {
        "run_started", "run_completed", "run_failed",
        "thought",
        "tool_call_requested", "tool_call_result", "tool_call_failed",
        "llm_request", "llm_response", "llm_text",
        "node_entered", "node_completed", "branch_chosen",
        "handoff_requested", "handoff_completed", "handoff_failed",
    }
    missing = known_events - set(EVENT_BUCKETS.keys())
    assert not missing, f"event types missing from EVENT_BUCKETS: {missing}"


# ── HTML page shape ────────────────────────────────────────────────────────


def test_html_page_is_valid_doctype():
    assert HTML_PAGE.lstrip().startswith("<!doctype")


def test_html_page_references_runs_endpoint():
    """The page must fetch from /runs — otherwise the UI shows nothing."""
    assert "/runs" in HTML_PAGE


def test_html_page_renders_known_event_types():
    """Each known event type should have a switch case in the JS
    `summary` function so the timeline shows meaningful text rather
    than a blank line."""
    for ev in EVENT_BUCKETS:
        assert ev in HTML_PAGE, (
            f"event type {ev!r} has no rendering case in HTML_PAGE"
        )


# ── HTTP endpoints — end-to-end through LedgerServer ──────────────────────


@pytest.fixture
def server(ledger):
    s = LedgerServer(ledger, host="127.0.0.1", port=0)
    s.start()
    try:
        yield s
    finally:
        s.stop()


def _get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _get_text(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8")


def test_root_serves_html_page(server):
    status, body = _get_text(f"{server.url}/")
    assert status == 200
    assert body.lstrip().startswith("<!doctype")
    assert "Kalairos · Control Plane" in body


def test_runs_endpoint_empty(server):
    status, body = _get_json(f"{server.url}/runs")
    assert status == 200
    assert body == {"runs": []}


def test_runs_endpoint_lists_completed_run(server, ledger, echo_agent):
    r = _drive_run(echo_agent, ledger, finish_value="done")
    status, body = _get_json(f"{server.url}/runs")
    assert status == 200
    [run] = body["runs"]
    assert run["run_id"] == r.run_id
    assert run["status"] == "completed"


def test_run_events_endpoint(server, ledger, echo_agent):
    r = _drive_run(echo_agent, ledger)
    status, body = _get_json(f"{server.url}/runs/{r.run_id}/events")
    assert status == 200
    types = [e["event_type"] for e in body["events"]]
    assert types == [
        "run_started",
        "thought",
        "tool_call_requested",
        "tool_call_result",
        "run_completed",
    ]


def test_run_events_endpoint_unknown_id_returns_empty(server, ledger):
    status, body = _get_json(f"{server.url}/runs/nope/events")
    assert status == 200
    assert body == {"events": []}


def test_run_events_endpoint_with_executor_emits_node_events(server, ledger, echo_agent):
    """End-to-end through the Executor — the resulting trail should
    include node_entered + node_completed for the workflow graph."""
    g = WorkflowGraph(name="solo")
    g.add(StepNode(name="t", think="hi"))
    g.set_start("t")
    run, _ = Executor(g).run(echo_agent, ledger)

    status, body = _get_json(f"{server.url}/runs/{run.run_id}/events")
    assert status == 200
    types = [e["event_type"] for e in body["events"]]
    assert "node_entered" in types
    assert "node_completed" in types
