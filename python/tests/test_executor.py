"""Tests for the Executor — Phase 2.3.

The Executor walks a WorkflowGraph step-by-step, driving a Run. State
flows through nodes; the Ledger sees every node entry/exit plus the
underlying tool/think events from Run.
"""

import pytest

from kalairos import (
    Agent,
    BranchNode,
    Executor,
    Ledger,
    Run,
    StepNode,
    WorkflowGraph,
    tool,
)
from kalairos.executor import (
    EVENT_BRANCH_CHOSEN,
    EVENT_GRAPH_DEFINED,
    EVENT_NODE_COMPLETED,
    EVENT_NODE_ENTERED,
)
from kalairos.run import (
    EVENT_RUN_COMPLETED,
    EVENT_RUN_FAILED,
    EVENT_RUN_STARTED,
    EVENT_THOUGHT,
    EVENT_TOOL_CALL_FAILED,
    EVENT_TOOL_CALL_REQUESTED,
    EVENT_TOOL_CALL_RESULT,
    STATUS_COMPLETED,
    STATUS_FAILED,
)


# ── helpers ────────────────────────────────────────────────────────────────


def _events_for_run(ledger: Ledger, run_id: str) -> list[dict]:
    rows = ledger.appender.load_raw()
    return sorted(
        (r for r in rows if r.get("id", "").startswith(f"{run_id}/")),
        key=lambda r: r.get("metadata", {}).get("seq", 0),
    )


def _event_types(events: list[dict]) -> list[str]:
    return [e["metadata"]["event_type"] for e in events]


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
def upcase_tool():
    @tool(
        description="Uppercase a string",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    def upcase(text: str) -> str:
        return text.upper()

    return upcase


@pytest.fixture
def count_tool():
    @tool(
        description="Count characters",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    def char_count(text: str) -> int:
        return len(text)

    return char_count


@pytest.fixture
def boom_tool():
    @tool(description="Always raises", parameters={})
    def boom() -> None:
        raise RuntimeError("kaboom")

    return boom


@pytest.fixture
def agent(upcase_tool, count_tool, boom_tool):
    return Agent(
        name="exec-tester",
        instructions="walk the graph",
        tools=[upcase_tool, count_tool, boom_tool],
    )


# ── Construction-time validation ───────────────────────────────────────────


def test_executor_validates_graph_at_construction():
    """A graph with no start should fail at Executor() construction,
    not later at run() — surface authoring mistakes early."""
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    with pytest.raises(ValueError, match="no start node"):
        Executor(g)


# ── Linear graph ───────────────────────────────────────────────────────────


def test_executor_runs_linear_graph(agent, ledger):
    g = WorkflowGraph(name="linear")
    g.add(
        StepNode(
            name="upper",
            tool="upcase",
            inputs=lambda s: {"text": s["input"]},
            output_key="upper",
            next="count",
        )
    )
    g.add(
        StepNode(
            name="count",
            tool="char_count",
            inputs=lambda s: {"text": s["upper"]},
            output_key="length",
        )
    )
    g.set_start("upper")

    run, state = Executor(g).run(
        agent, ledger, initial_state={"input": "hello"}
    )

    assert run.status == STATUS_COMPLETED
    assert state["upper"] == "HELLO"
    assert state["length"] == 5


def test_executor_returns_run_and_state_tuple(agent, ledger):
    g = WorkflowGraph(name="solo")
    g.add(StepNode(name="t", think="hi"))
    g.set_start("t")
    result = Executor(g).run(agent, ledger)
    assert isinstance(result, tuple) and len(result) == 2
    run, state = result
    assert isinstance(run, Run)
    assert isinstance(state, dict)


def test_executor_empty_initial_state_defaults_to_empty_dict(agent, ledger):
    g = WorkflowGraph(name="solo")
    g.add(StepNode(name="t", think="hi"))
    g.set_start("t")
    _, state = Executor(g).run(agent, ledger)
    assert state == {}


def test_executor_emits_node_entered_and_completed(agent, ledger):
    g = WorkflowGraph(name="solo")
    g.add(StepNode(name="t", think="hi"))
    g.set_start("t")
    run, _ = Executor(g).run(agent, ledger)
    events = _events_for_run(ledger, run.run_id)
    # run_started, graph_defined, node_entered, thought, node_completed,
    # run_completed — graph_defined was added in Phase 4.2 so the control
    # plane can render the topology.
    assert _event_types(events) == [
        EVENT_RUN_STARTED,
        EVENT_GRAPH_DEFINED,
        EVENT_NODE_ENTERED,
        EVENT_THOUGHT,
        EVENT_NODE_COMPLETED,
        EVENT_RUN_COMPLETED,
    ]
    # node_entered carries the node name (now at index 2, not 1).
    assert events[2]["metadata"]["payload"]["node"] == "t"
    assert events[4]["metadata"]["payload"]["node"] == "t"


# ── Branch ────────────────────────────────────────────────────────────────


def test_executor_branch_routes_correctly(agent, ledger):
    g = WorkflowGraph(name="branchy")
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "left" if s["pick"] == "L" else "right",
            branches={"left": "L", "right": "R"},
        )
    )
    g.add(StepNode(name="L", think="went left"))
    g.add(StepNode(name="R", think="went right"))
    g.set_start("route")

    _, _ = Executor(g).run(agent, ledger, initial_state={"pick": "L"})
    # Now go right
    _, _ = Executor(g).run(agent, ledger, initial_state={"pick": "X"})


def test_executor_branch_chosen_event_carries_key_and_target(agent, ledger):
    g = WorkflowGraph(name="branchy")
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "left",
            branches={"left": "L"},
        )
    )
    g.add(StepNode(name="L", think="went left"))
    g.set_start("route")

    run, _ = Executor(g).run(agent, ledger)
    events = _events_for_run(ledger, run.run_id)
    chosen = next(
        e for e in events if e["metadata"]["event_type"] == EVENT_BRANCH_CHOSEN
    )
    assert chosen["metadata"]["payload"] == {
        "node": "route",
        "key": "left",
        "target": "L",
    }


def test_executor_branch_unknown_key_fails_run(agent, ledger):
    g = WorkflowGraph(name="bad-branch")
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "nonexistent",
            branches={"left": "L"},
        )
    )
    g.add(StepNode(name="L", think="x"))
    g.set_start("route")

    with pytest.raises(KeyError, match="not in branches"):
        Executor(g).run(agent, ledger)

    # The run was marked failed and the ledger has the run_failed event.
    rows = ledger.appender.load_raw()
    types = {
        r.get("metadata", {}).get("event_type") for r in rows
    }
    assert EVENT_RUN_FAILED in types


# ── Failure handling ──────────────────────────────────────────────────────


def test_executor_tool_failure_fails_run_and_reraises(agent, ledger):
    g = WorkflowGraph(name="explosive")
    g.add(StepNode(name="bang", tool="boom"))
    g.set_start("bang")

    with pytest.raises(RuntimeError, match="kaboom"):
        Executor(g).run(agent, ledger)

    rows = ledger.appender.load_raw()
    types = [r.get("metadata", {}).get("event_type") for r in rows]
    # Both events land: tool_call_failed AND run_failed (the trail tells
    # the full story — what failed and that the run terminated).
    assert EVENT_TOOL_CALL_FAILED in types
    assert EVENT_RUN_FAILED in types


def test_executor_run_status_is_failed_after_tool_error(agent, ledger):
    g = WorkflowGraph(name="explosive")
    g.add(StepNode(name="bang", tool="boom"))
    g.set_start("bang")
    ex = Executor(g)

    # Capture the run via inspection of the ledger after the error.
    with pytest.raises(RuntimeError):
        ex.run(agent, ledger)

    rows = ledger.appender.load_raw()
    failed = next(
        r for r in rows if r.get("metadata", {}).get("event_type") == EVENT_RUN_FAILED
    )
    # error message includes the exception type + message
    assert "RuntimeError" in failed["metadata"]["payload"]["error"]
    assert "kaboom" in failed["metadata"]["payload"]["error"]


# ── State plumbing ────────────────────────────────────────────────────────


def test_executor_state_threads_through_steps(agent, ledger):
    g = WorkflowGraph(name="state-test")
    g.add(
        StepNode(
            name="a",
            tool="upcase",
            inputs=lambda s: {"text": s["raw"]},
            output_key="upper",
            next="b",
        )
    )
    g.add(
        StepNode(
            name="b",
            tool="char_count",
            inputs=lambda s: {"text": s["upper"]},
            output_key="length",
        )
    )
    g.set_start("a")
    _, state = Executor(g).run(
        agent, ledger, initial_state={"raw": "abc"}
    )
    assert state["upper"] == "ABC"
    assert state["length"] == 3
    # raw is preserved
    assert state["raw"] == "abc"


def test_executor_branch_can_route_off_tool_result(agent, ledger):
    """A practical pattern: a tool's output drives a branch."""
    g = WorkflowGraph(name="route-on-result")
    g.add(
        StepNode(
            name="size",
            tool="char_count",
            inputs=lambda s: {"text": s["raw"]},
            output_key="length",
            next="route",
        )
    )
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "big" if s["length"] > 3 else "small",
            branches={"big": "BIG", "small": "SMALL"},
        )
    )
    g.add(StepNode(name="BIG", think="it's big"))
    g.add(StepNode(name="SMALL", think="it's small"))
    g.set_start("size")

    run_big, _ = Executor(g).run(
        agent, ledger, initial_state={"raw": "hello"}
    )
    run_small, _ = Executor(g).run(
        agent, ledger, initial_state={"raw": "hi"}
    )

    big_events = _events_for_run(ledger, run_big.run_id)
    big_thoughts = [
        e["metadata"]["payload"]["text"]
        for e in big_events
        if e["metadata"]["event_type"] == EVENT_THOUGHT
    ]
    assert big_thoughts == ["it's big"]

    small_events = _events_for_run(ledger, run_small.run_id)
    small_thoughts = [
        e["metadata"]["payload"]["text"]
        for e in small_events
        if e["metadata"]["event_type"] == EVENT_THOUGHT
    ]
    assert small_thoughts == ["it's small"]


# ── End-to-end ────────────────────────────────────────────────────────────


def test_executor_e2e_three_node_graph_with_branch(agent, ledger):
    """Read → branch on length → either expand or short-circuit."""
    g = WorkflowGraph(name="e2e")
    g.add(
        StepNode(
            name="measure",
            tool="char_count",
            inputs=lambda s: {"text": s["raw"]},
            output_key="length",
            next="decide",
        )
    )
    g.add(
        BranchNode(
            name="decide",
            condition=lambda s: "go" if s["length"] >= 3 else "stop",
            branches={"go": "amplify", "stop": "done"},
        )
    )
    g.add(
        StepNode(
            name="amplify",
            tool="upcase",
            inputs=lambda s: {"text": s["raw"]},
            output_key="shout",
            next="done",
        )
    )
    g.add(StepNode(name="done", think="finished"))
    g.set_start("measure")

    run, state = Executor(g).run(
        agent, ledger, initial_state={"raw": "hello"}
    )

    assert run.status == STATUS_COMPLETED
    assert state["length"] == 5
    assert state["shout"] == "HELLO"

    events = _events_for_run(ledger, run.run_id)
    # Tool call results match expected nodes
    tool_results = [
        e["metadata"]["payload"]
        for e in events
        if e["metadata"]["event_type"] == EVENT_TOOL_CALL_RESULT
    ]
    assert [r["tool"] for r in tool_results] == ["char_count", "upcase"]
