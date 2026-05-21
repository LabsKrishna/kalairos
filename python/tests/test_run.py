"""Tests for the Run class — Phase 2.2.

Run drives an Agent step-by-step (caller-controlled; Phase 2.4 adds
LLM-autonomous stepping on this same contract). Every step persists as
an event in the Ledger, which the control plane will replay.
"""

import pytest

from kalairos import Agent, Ledger, Run, tool
from kalairos.run import (
    EVENT_RUN_COMPLETED,
    EVENT_RUN_FAILED,
    EVENT_RUN_STARTED,
    EVENT_THOUGHT,
    EVENT_TOOL_CALL_FAILED,
    EVENT_TOOL_CALL_REQUESTED,
    EVENT_TOOL_CALL_RESULT,
    RUN_NAMESPACE,
    RUN_RECORD_TYPE,
    RUN_WORKSPACE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
)


# ── helpers ────────────────────────────────────────────────────────────────


def _events_for_run(ledger: Ledger, run_id: str) -> list[dict]:
    """Pull all events emitted by `run_id` from the canonical JSONL.

    We read JSONL via `appender.load_raw` rather than via `ledger.query`
    because the SQLite `facts` table doesn't surface the `metadata`
    field that carries event_type / seq / payload — those live only in
    the JSONL canonical record. Filtering + sorting in Python is fine
    at test scale.
    """
    rows = ledger.appender.load_raw()
    return sorted(
        (r for r in rows if r.get("id", "").startswith(f"{run_id}/")),
        key=lambda r: r.get("metadata", {}).get("seq", 0),
    )


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
def echo_tool():
    @tool(
        description="Echo a message back, prefixed",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    def echo(text: str) -> str:
        return f"echo:{text}"

    return echo


@pytest.fixture
def boom_tool():
    @tool(description="Always raises", parameters={})
    def boom() -> None:
        raise RuntimeError("kaboom")

    return boom


@pytest.fixture
def agent(echo_tool, boom_tool):
    return Agent(
        name="tester",
        instructions="echo what you're told, then stop",
        tools=[echo_tool, boom_tool],
    )


@pytest.fixture
def run(agent, ledger):
    return Run(agent, ledger, goal="echo something useful")


# ── Lifecycle ──────────────────────────────────────────────────────────────


def test_run_starts_pending(run):
    assert run.status == STATUS_PENDING


def test_start_transitions_to_running(run):
    run.start()
    assert run.status == STATUS_RUNNING


def test_start_emits_run_started_event(run, ledger):
    run.start()
    events = _events_for_run(ledger, run.run_id)
    assert len(events) == 1
    e = events[0]
    assert e["metadata"]["event_type"] == EVENT_RUN_STARTED
    assert e["metadata"]["payload"]["agent"] == run.agent.name
    assert e["metadata"]["payload"]["goal"] == run.goal
    assert (
        e["metadata"]["payload"]["instructions"] == run.agent.instructions
    )


def test_finish_transitions_to_completed(run):
    run.start()
    run.finish(result="done")
    assert run.status == STATUS_COMPLETED
    assert run.result == "done"


def test_finish_emits_run_completed_event(run, ledger):
    run.start()
    run.finish(result="done")
    events = _events_for_run(ledger, run.run_id)
    assert events[-1]["metadata"]["event_type"] == EVENT_RUN_COMPLETED
    assert events[-1]["metadata"]["payload"]["result"] == "done"


def test_fail_transitions_to_failed(run):
    run.start()
    run.fail("simulated")
    assert run.status == STATUS_FAILED
    assert run.error == "simulated"


def test_fail_emits_run_failed_event(run, ledger):
    run.start()
    run.fail("simulated")
    events = _events_for_run(ledger, run.run_id)
    assert events[-1]["metadata"]["event_type"] == EVENT_RUN_FAILED
    assert events[-1]["metadata"]["payload"]["error"] == "simulated"


def test_cannot_start_twice(run):
    run.start()
    with pytest.raises(RuntimeError, match="cannot start"):
        run.start()


def test_cannot_act_before_start(run):
    with pytest.raises(RuntimeError, match="not running"):
        run.think("anything")


def test_cannot_finish_after_failed(run):
    run.start()
    run.fail("oops")
    with pytest.raises(RuntimeError, match="not running"):
        run.finish()


def test_cannot_call_tool_after_completed(run):
    run.start()
    run.finish()
    with pytest.raises(RuntimeError, match="not running"):
        run.call_tool("echo", text="x")


# ── Run id ─────────────────────────────────────────────────────────────────


def test_run_id_auto_generated(agent, ledger):
    r = Run(agent, ledger)
    assert r.run_id.startswith("run-")
    # 12 hex chars after "run-"
    assert len(r.run_id) == len("run-") + 12


def test_run_id_explicit(agent, ledger):
    r = Run(agent, ledger, run_id="my-run-1")
    assert r.run_id == "my-run-1"


def test_two_runs_have_distinct_ids(agent, ledger):
    r1 = Run(agent, ledger)
    r2 = Run(agent, ledger)
    assert r1.run_id != r2.run_id


# ── Stepping ───────────────────────────────────────────────────────────────


def test_think_emits_thought_event(run, ledger):
    run.start()
    run.think("I should call echo")
    events = _events_for_run(ledger, run.run_id)
    assert len(events) == 2
    assert events[1]["metadata"]["event_type"] == EVENT_THOUGHT
    assert (
        events[1]["metadata"]["payload"]["text"] == "I should call echo"
    )


def test_call_tool_returns_handler_result(run):
    run.start()
    assert run.call_tool("echo", text="hi") == "echo:hi"


def test_call_tool_emits_requested_then_result(run, ledger):
    run.start()
    run.call_tool("echo", text="hi")
    events = _events_for_run(ledger, run.run_id)
    types = [e["metadata"]["event_type"] for e in events]
    assert types == [
        EVENT_RUN_STARTED,
        EVENT_TOOL_CALL_REQUESTED,
        EVENT_TOOL_CALL_RESULT,
    ]
    req = events[1]["metadata"]["payload"]
    res = events[2]["metadata"]["payload"]
    assert req["tool"] == "echo"
    assert req["input"] == {"text": "hi"}
    assert res["tool"] == "echo"
    assert res["result"] == "echo:hi"


def test_call_tool_failure_emits_failed_event_and_reraises(run, ledger):
    run.start()
    with pytest.raises(RuntimeError, match="kaboom"):
        run.call_tool("boom")
    events = _events_for_run(ledger, run.run_id)
    types = [e["metadata"]["event_type"] for e in events]
    assert types == [
        EVENT_RUN_STARTED,
        EVENT_TOOL_CALL_REQUESTED,
        EVENT_TOOL_CALL_FAILED,
    ]
    failed = events[2]["metadata"]["payload"]
    assert failed["tool"] == "boom"
    assert failed["error"] == "kaboom"
    assert failed["error_type"] == "RuntimeError"


def test_call_tool_unknown_name_raises(run):
    run.start()
    with pytest.raises(KeyError, match="no tool"):
        run.call_tool("nonexistent")


# ── Event sequencing ──────────────────────────────────────────────────────


def test_event_seq_is_monotonic(run, ledger):
    run.start()
    run.think("a")
    run.think("b")
    run.call_tool("echo", text="c")
    events = _events_for_run(ledger, run.run_id)
    seqs = [e["metadata"]["seq"] for e in events]
    assert seqs == [0, 1, 2, 3, 4]  # start + 2 thoughts + req + result


def test_event_ids_are_unique_and_path_shaped(run, ledger):
    run.start()
    run.think("a")
    run.call_tool("echo", text="b")
    events = _events_for_run(ledger, run.run_id)
    ids = [e["id"] for e in events]
    for eid in ids:
        assert eid.startswith(f"{run.run_id}/")
    assert len(set(ids)) == len(ids)


# ── Ledger integration ────────────────────────────────────────────────────


def test_events_tagged_with_run_and_agent(run, ledger):
    run.start()
    run.think("x")
    rows = ledger.query(workspace=RUN_WORKSPACE)
    assert len(rows) == 2  # don't let the loop-over-empty pattern hide a regression
    for r in rows:
        assert f"run:{run.run_id}" in r["tags"]
        assert f"agent:{run.agent.name}" in r["tags"]


def test_events_use_run_workspace(run, ledger):
    """Run events scope under workspace="agent-runs" so the control
    plane can isolate them from unrelated long-term entities."""
    run.start()
    rows = ledger.query(workspace=RUN_WORKSPACE)
    assert len(rows) == 1
    assert rows[0]["namespace"] == RUN_NAMESPACE
    assert rows[0]["workspaceId"] == RUN_WORKSPACE
    assert rows[0]["type"] == RUN_RECORD_TYPE


def test_two_runs_share_a_ledger_without_event_id_collisions(agent, ledger):
    """Run ids are part of every event id, so two runs against the same
    Ledger don't trip the SQLite PK constraint."""
    r1 = Run(agent, ledger, run_id="r1")
    r2 = Run(agent, ledger, run_id="r2")
    r1.start()
    r2.start()
    r1.think("from r1")
    r2.think("from r2")
    r1.finish()
    r2.finish()

    r1_events = _events_for_run(ledger, "r1")
    r2_events = _events_for_run(ledger, "r2")
    assert len(r1_events) == 3
    assert len(r2_events) == 3
    # No id leaks
    r1_ids = {e["id"] for e in r1_events}
    r2_ids = {e["id"] for e in r2_events}
    assert not r1_ids & r2_ids


# ── End-to-end ─────────────────────────────────────────────────────────────


def test_full_run_lifecycle_e2e(run, ledger):
    """The complete sequence the LLM-driven layer will eventually emit
    autonomously — proven here via explicit caller control."""
    run.start()
    run.think("starting")
    out = run.call_tool("echo", text="hello")
    run.think(f"got {out}")
    run.finish(result=out)

    assert run.status == STATUS_COMPLETED
    assert run.result == "echo:hello"

    events = _events_for_run(ledger, run.run_id)
    types = [e["metadata"]["event_type"] for e in events]
    assert types == [
        EVENT_RUN_STARTED,
        EVENT_THOUGHT,
        EVENT_TOOL_CALL_REQUESTED,
        EVENT_TOOL_CALL_RESULT,
        EVENT_THOUGHT,
        EVENT_RUN_COMPLETED,
    ]
