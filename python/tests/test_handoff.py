"""Tests for cross-runtime handoff wait-state — Phase 2.5.

A HandoffNode delegates work to a Node service. The executor emits a
handoff_requested event, then blocks until a handoff_result event with
the matching handoff_id lands in the Ledger. Tests fake the Node side
by subscribing to the Ledger and firing the reply from a background
thread (which is what a real Node service POSTing to LedgerServer would
do — one HTTP worker thread per inbound request).
"""

import json
import threading
import time
from typing import Any

import pytest

from kalairos import (
    Agent,
    Executor,
    HandoffNode,
    Ledger,
    StepNode,
    WorkflowGraph,
    tool,
)
from kalairos.executor import (
    EVENT_HANDOFF_COMPLETED,
    EVENT_HANDOFF_FAILED,
    EVENT_HANDOFF_REQUESTED,
    EVENT_HANDOFF_RESULT,
)
from kalairos.run import STATUS_COMPLETED, STATUS_FAILED


# ── helpers ────────────────────────────────────────────────────────────────


def _events_for_run(ledger: Ledger, run_id: str) -> list[dict]:
    rows = ledger.appender.load_raw()
    return sorted(
        (r for r in rows if r.get("id", "").startswith(f"{run_id}/")),
        key=lambda r: r.get("metadata", {}).get("seq", 0),
    )


def _emit_handoff_result(
    ledger: Ledger, handoff_id: str, result: Any = None, error: str | None = None
) -> None:
    """Append a handoff_result event — the shape a Node service is
    expected to POST to LedgerServer /append."""
    ts = int(time.time() * 1000)
    payload = {"handoff_id": handoff_id, "result": result, "error": error}
    record = {
        "id": f"handoff/{handoff_id}/result",
        "text": json.dumps(payload, separators=(",", ":")),
        "type": "handoff-event",
        "memoryType": "long-term",
        "workspaceId": "agent-runs",
        "tags": [
            "handoff-event",
            EVENT_HANDOFF_RESULT,
            f"handoff:{handoff_id}",
        ],
        "versions": [
            {"timestamp": ts, "text": json.dumps(payload, separators=(",", ":")), "ingestAt": ts}
        ],
        "metadata": {
            "event_type": EVENT_HANDOFF_RESULT,
            "payload": payload,
        },
    }
    ledger.append(record)


def auto_reply(
    ledger: Ledger,
    *,
    result: Any = None,
    error: str | None = None,
    delay: float = 0.0,
):
    """Subscribe to handoff_requested events; spawn a thread that
    appends the matching handoff_result. Returns the unsubscribe
    callable. The reply runs on a separate thread because calling
    `ledger.append` synchronously from inside a subscriber callback
    would re-enter the write path on the same thread the executor is
    blocked on — recursion-deadlock-shaped behavior.
    """

    def listener(record: dict) -> None:
        md = record.get("metadata") or {}
        if md.get("event_type") != EVENT_HANDOFF_REQUESTED:
            return
        handoff_id = md["payload"]["handoff_id"]

        def reply() -> None:
            if delay > 0:
                time.sleep(delay)
            _emit_handoff_result(
                ledger, handoff_id, result=result, error=error
            )

        threading.Thread(target=reply, daemon=True).start()

    return ledger.subscribe(listener)


# ── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


@pytest.fixture
def empty_agent():
    return Agent(name="handoff-tester")


# ── Subscribe / unsubscribe on the Ledger ──────────────────────────────────


def test_subscribe_fires_for_every_appended_record(ledger):
    seen: list[dict] = []
    ledger.subscribe(lambda r: seen.append(r))
    ledger.append({"id": "a", "text": "x"})
    ledger.append({"id": "b", "text": "y"})
    assert [r["id"] for r in seen] == ["a", "b"]


def test_unsubscribe_stops_notifications(ledger):
    seen: list[dict] = []
    unsub = ledger.subscribe(lambda r: seen.append(r))
    ledger.append({"id": "a", "text": "x"})
    unsub()
    ledger.append({"id": "b", "text": "y"})
    assert [r["id"] for r in seen] == ["a"]


def test_subscriber_exception_does_not_break_append(ledger):
    """A buggy subscriber must not block the write path."""

    def boom(_):
        raise RuntimeError("listener bug")

    ledger.subscribe(boom)
    # append still works
    ledger.append({"id": "x", "text": "x"})
    assert ledger.get("x") is not None


def test_unsubscribe_is_idempotent(ledger):
    unsub = ledger.subscribe(lambda r: None)
    unsub()
    unsub()  # second call must not raise


# ── HandoffNode shape ──────────────────────────────────────────────────────


def test_handoff_node_requires_service():
    with pytest.raises(ValueError, match="`service` is required"):
        HandoffNode(name="x", service="")


def test_handoff_node_validates_next_reference():
    g = WorkflowGraph(name="g")
    g.add(HandoffNode(name="h", service="svc", next="missing"))
    g.set_start("h")
    with pytest.raises(ValueError, match="unknown next"):
        g.validate()


# ── Handoff happy path ────────────────────────────────────────────────────


def test_handoff_completes_when_reply_arrives(empty_agent, ledger):
    g = WorkflowGraph(name="ho")
    g.add(
        HandoffNode(
            name="ask-node",
            service="dep-graph-builder",
            inputs=lambda s: {"files": s["files"]},
            output_key="graph",
        )
    )
    g.set_start("ask-node")

    auto_reply(ledger, result={"nodes": 5, "edges": 12})

    run, state = Executor(g).run(
        empty_agent, ledger, initial_state={"files": ["a.py", "b.py"]}
    )

    assert run.status == STATUS_COMPLETED
    assert state["graph"] == {"nodes": 5, "edges": 12}


def test_handoff_emits_requested_then_completed(empty_agent, ledger):
    g = WorkflowGraph(name="ho")
    g.add(HandoffNode(name="ask", service="svc", output_key="r"))
    g.set_start("ask")

    auto_reply(ledger, result="ok")

    run, _ = Executor(g).run(empty_agent, ledger)
    events = _events_for_run(ledger, run.run_id)
    types = [e["metadata"]["event_type"] for e in events]
    assert EVENT_HANDOFF_REQUESTED in types
    assert EVENT_HANDOFF_COMPLETED in types
    # Requested comes before completed
    assert types.index(EVENT_HANDOFF_REQUESTED) < types.index(EVENT_HANDOFF_COMPLETED)


def test_handoff_requested_payload_carries_id_service_and_input(empty_agent, ledger):
    g = WorkflowGraph(name="ho")
    g.add(
        HandoffNode(
            name="ask",
            service="dep-graph-builder",
            inputs=lambda s: {"files": s["files"]},
            output_key="r",
        )
    )
    g.set_start("ask")

    auto_reply(ledger, result="done")

    run, _ = Executor(g).run(
        empty_agent, ledger, initial_state={"files": ["x.py"]}
    )
    events = _events_for_run(ledger, run.run_id)
    req = next(
        e for e in events if e["metadata"]["event_type"] == EVENT_HANDOFF_REQUESTED
    )
    p = req["metadata"]["payload"]
    assert p["service"] == "dep-graph-builder"
    assert p["input"] == {"files": ["x.py"]}
    assert isinstance(p["handoff_id"], str) and p["handoff_id"].startswith("ho_")


def test_handoff_result_flows_to_state_and_next_node_runs(empty_agent, ledger):
    """Handoff result populates `output_key`; subsequent nodes can read
    from it. End-to-end shape: think → handoff → think."""
    g = WorkflowGraph(name="chain")
    g.add(StepNode(name="prepare", think="about to delegate", next="delegate"))
    g.add(
        HandoffNode(
            name="delegate",
            service="svc",
            output_key="result",
            next="finalize",
        )
    )
    g.add(StepNode(name="finalize", think="got the result"))
    g.set_start("prepare")

    auto_reply(ledger, result={"hello": "world"})

    run, state = Executor(g).run(empty_agent, ledger)
    assert run.status == STATUS_COMPLETED
    assert state["result"] == {"hello": "world"}


def test_handoff_no_output_key_does_not_mutate_state(empty_agent, ledger):
    g = WorkflowGraph(name="ho")
    g.add(HandoffNode(name="ask", service="svc"))
    g.set_start("ask")

    auto_reply(ledger, result={"ignored": True})

    _, state = Executor(g).run(empty_agent, ledger)
    assert "ignored" not in state


# ── Timeout ────────────────────────────────────────────────────────────────


def test_handoff_timeout_fails_run(empty_agent, ledger):
    """No auto_reply registered, so the result never arrives. Short
    timeout (50ms) so the test doesn't slow down."""
    g = WorkflowGraph(name="timeout")
    g.add(HandoffNode(name="ask", service="svc", timeout=0.05))
    g.set_start("ask")

    with pytest.raises(TimeoutError, match="timed out"):
        Executor(g).run(empty_agent, ledger)

    rows = ledger.appender.load_raw()
    types = [r.get("metadata", {}).get("event_type") for r in rows]
    assert EVENT_HANDOFF_REQUESTED in types
    assert EVENT_HANDOFF_FAILED in types
    failed = next(
        r for r in rows if r.get("metadata", {}).get("event_type") == EVENT_HANDOFF_FAILED
    )
    assert failed["metadata"]["payload"]["error"] == "timeout"


# ── Node-side error ────────────────────────────────────────────────────────


def test_handoff_node_error_fails_run_with_message(empty_agent, ledger):
    """Node service reports an error in the handoff_result payload."""
    g = WorkflowGraph(name="erroring")
    g.add(HandoffNode(name="ask", service="svc", timeout=2.0))
    g.set_start("ask")

    auto_reply(ledger, error="dep-graph build failed: missing module")

    with pytest.raises(RuntimeError, match="missing module"):
        Executor(g).run(empty_agent, ledger)

    rows = ledger.appender.load_raw()
    types = [r.get("metadata", {}).get("event_type") for r in rows]
    assert EVENT_HANDOFF_FAILED in types


# ── Listener filtering ────────────────────────────────────────────────────


def test_handoff_ignores_unrelated_handoff_results(empty_agent, ledger):
    """A handoff_result with a DIFFERENT handoff_id must not unblock us."""
    g = WorkflowGraph(name="ho")
    g.add(HandoffNode(name="ask", service="svc", output_key="r", timeout=0.3))
    g.set_start("ask")

    # Auto-reply with a noise event first (different handoff_id), then
    # the real reply.
    def listener(record: dict) -> None:
        md = record.get("metadata") or {}
        if md.get("event_type") != EVENT_HANDOFF_REQUESTED:
            return
        real_id = md["payload"]["handoff_id"]

        def reply() -> None:
            # Noise: a different handoff_id
            _emit_handoff_result(ledger, "ho_other", result={"wrong": "result"})
            # Real reply
            _emit_handoff_result(ledger, real_id, result={"right": "result"})

        threading.Thread(target=reply, daemon=True).start()

    ledger.subscribe(listener)

    run, state = Executor(g).run(empty_agent, ledger)
    assert run.status == STATUS_COMPLETED
    assert state["r"] == {"right": "result"}


# ── Multiple handoffs in one run ──────────────────────────────────────────


def test_multiple_handoffs_in_sequence(empty_agent, ledger):
    g = WorkflowGraph(name="two-step")
    g.add(
        HandoffNode(
            name="first",
            service="svc-a",
            output_key="a",
            next="second",
        )
    )
    g.add(
        HandoffNode(
            name="second",
            service="svc-b",
            output_key="b",
            inputs=lambda s: {"prev": s["a"]},
        )
    )
    g.set_start("first")

    # Smart auto-reply: replies vary by service in the requested event.
    def listener(record: dict) -> None:
        md = record.get("metadata") or {}
        if md.get("event_type") != EVENT_HANDOFF_REQUESTED:
            return
        p = md["payload"]
        handoff_id = p["handoff_id"]
        result = {"from": p["service"]}

        def reply() -> None:
            _emit_handoff_result(ledger, handoff_id, result=result)

        threading.Thread(target=reply, daemon=True).start()

    ledger.subscribe(listener)

    run, state = Executor(g).run(empty_agent, ledger)
    assert run.status == STATUS_COMPLETED
    assert state["a"] == {"from": "svc-a"}
    assert state["b"] == {"from": "svc-b"}


# ── E2E: graph with step → handoff → step ─────────────────────────────────


def test_e2e_step_then_handoff_then_step(empty_agent, ledger):
    @tool(
        description="Identity",
        parameters={
            "type": "object",
            "properties": {"x": {"type": "string"}},
            "required": ["x"],
        },
    )
    def identity(x: str) -> str:
        return x

    agent = Agent(name="e2e", tools=[identity])

    g = WorkflowGraph(name="step-handoff-step")
    g.add(
        StepNode(
            name="prep",
            tool="identity",
            inputs=lambda s: {"x": s["seed"]},
            output_key="prepped",
            next="ask",
        )
    )
    g.add(
        HandoffNode(
            name="ask",
            service="builder",
            inputs=lambda s: {"data": s["prepped"]},
            output_key="ho_result",
            next="finalize",
        )
    )
    g.add(StepNode(name="finalize", think="all done"))
    g.set_start("prep")

    auto_reply(ledger, result={"built": True})

    run, state = Executor(g).run(
        agent, ledger, initial_state={"seed": "alpha"}
    )

    assert run.status == STATUS_COMPLETED
    assert state["prepped"] == "alpha"
    assert state["ho_result"] == {"built": True}
