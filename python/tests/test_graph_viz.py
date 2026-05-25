"""Tests for the workflow-graph visualization additions — Phase 4.2.

Covers:
- `WorkflowGraph.to_dict()` shape (every node kind serializes correctly).
- Executor emits `graph_defined` with the topology.
- Control plane HTML renders the graph panel (smoke-level — full UI
  testing would need a browser).
- EVENT_BUCKETS covers the new event type.
"""

import json

import pytest

from kalairos import (
    Agent,
    BranchNode,
    Executor,
    HandoffNode,
    Ledger,
    StepNode,
    WorkflowGraph,
    tool,
)
from kalairos.control_plane import EVENT_BUCKETS, HTML_PAGE
from kalairos.executor import EVENT_GRAPH_DEFINED


# ── WorkflowGraph.to_dict ─────────────────────────────────────────────────


def test_to_dict_serializes_step_node_with_tool():
    g = WorkflowGraph(name="g")
    g.add(
        StepNode(
            name="run_tool",
            tool="my_tool",
            inputs=lambda s: {},
            output_key="result",
            next="end",
        )
    )
    g.add(StepNode(name="end", think="done"))
    g.set_start("run_tool")
    d = g.to_dict()
    nodes_by_name = {n["name"]: n for n in d["nodes"]}
    assert nodes_by_name["run_tool"] == {
        "name": "run_tool",
        "kind": "step",
        "tool": "my_tool",
        "next": "end",
        "output_key": "result",
    }


def test_to_dict_serializes_step_node_with_think():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="ponder", think="hmm"))
    g.set_start("ponder")
    d = g.to_dict()
    node = d["nodes"][0]
    assert node["kind"] == "step"
    assert node["think"] == "hmm"
    assert node["next"] is None
    # Think nodes have no tool / output_key keys.
    assert "tool" not in node
    assert "output_key" not in node


def test_to_dict_serializes_branch_node():
    g = WorkflowGraph(name="g")
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "x",
            branches={"x": "a", "y": "b"},
        )
    )
    g.add(StepNode(name="a", think="a"))
    g.add(StepNode(name="b", think="b"))
    g.set_start("route")
    d = g.to_dict()
    node = next(n for n in d["nodes"] if n["name"] == "route")
    assert node["kind"] == "branch"
    assert node["branches"] == {"x": "a", "y": "b"}


def test_to_dict_serializes_handoff_node():
    g = WorkflowGraph(name="g")
    g.add(
        HandoffNode(
            name="delegate",
            service="my-service",
            inputs=lambda s: {},
            output_key="result",
            timeout=10.0,
            next="done",
        )
    )
    g.add(StepNode(name="done", think="finished"))
    g.set_start("delegate")
    d = g.to_dict()
    node = next(n for n in d["nodes"] if n["name"] == "delegate")
    assert node == {
        "name": "delegate",
        "kind": "handoff",
        "next": "done",
        "service": "my-service",
        "timeout": 10.0,
        "output_key": "result",
    }


def test_to_dict_top_level_shape():
    g = WorkflowGraph(name="my-graph")
    g.add(StepNode(name="only", think="x"))
    g.set_start("only")
    d = g.to_dict()
    assert d["name"] == "my-graph"
    assert d["start"] == "only"
    assert isinstance(d["nodes"], list)
    assert len(d["nodes"]) == 1


def test_to_dict_is_json_serializable():
    """The whole point of to_dict() is that the Executor can emit it as
    a ledger event payload. JSON-encoding must not raise."""
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", tool="t", inputs=lambda s: {}, next="b"))
    g.add(BranchNode(name="b", condition=lambda s: "k", branches={"k": "c"}))
    g.add(HandoffNode(name="c", service="svc"))
    g.set_start("a")
    json.dumps(g.to_dict())  # no raise


# ── Executor emits graph_defined ──────────────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


def test_executor_emits_graph_defined_right_after_run_started(ledger):
    @tool(description="x", parameters={})
    def noop():
        return "ok"

    agent = Agent(name="ga", tools=[noop])
    g = WorkflowGraph(name="solo")
    g.add(StepNode(name="t", tool="noop", inputs=lambda s: {}))
    g.set_start("t")

    run, _ = Executor(g).run(agent, ledger)

    rows = ledger.appender.load_raw()
    events = sorted(
        (r for r in rows if r.get("id", "").startswith(f"{run.run_id}/")),
        key=lambda r: r.get("metadata", {}).get("seq", 0),
    )
    types = [(e.get("metadata") or {}).get("event_type") for e in events]
    # graph_defined is emitted right after run_started (seq=1).
    assert types[0] == "run_started"
    assert types[1] == "graph_defined"

    # Payload carries the topology.
    payload = (events[1].get("metadata") or {}).get("payload") or {}
    graph = payload["graph"]
    assert graph["name"] == "solo"
    assert graph["start"] == "t"
    assert [n["name"] for n in graph["nodes"]] == ["t"]


def test_executor_graph_defined_with_branching_topology(ledger):
    @tool(description="x", parameters={})
    def noop():
        return "ok"

    agent = Agent(name="ga", tools=[noop])
    g = WorkflowGraph(name="branching")
    g.add(StepNode(name="start", tool="noop", inputs=lambda s: {}, next="route"))
    g.add(
        BranchNode(
            name="route",
            condition=lambda s: "left",
            branches={"left": "L", "right": "R"},
        )
    )
    g.add(StepNode(name="L", think="left"))
    g.add(StepNode(name="R", think="right"))
    g.set_start("start")

    run, _ = Executor(g).run(agent, ledger)

    rows = ledger.appender.load_raw()
    defined = next(
        r for r in rows
        if (r.get("metadata") or {}).get("event_type") == EVENT_GRAPH_DEFINED
        and r.get("id", "").startswith(f"{run.run_id}/")
    )
    graph = defined["metadata"]["payload"]["graph"]
    branches = next(n for n in graph["nodes"] if n["name"] == "route")
    assert branches["kind"] == "branch"
    assert branches["branches"] == {"left": "L", "right": "R"}


# ── Control plane HTML / buckets ──────────────────────────────────────────


def test_event_buckets_includes_graph_defined():
    """The new event type must have a bucket so the UI renders it
    consistently with the rest of the trail (and the smoke test in
    test_control_plane.test_event_buckets_cover_all_known_event_types
    will start to require it)."""
    assert EVENT_BUCKETS["graph_defined"] == "node"


def test_html_page_renders_graph_panel():
    """The HTML must contain the graph-rendering machinery so runs with
    a graph_defined event get the visualization."""
    assert "graph-panel" in HTML_PAGE
    assert "graph-svg" in HTML_PAGE
    assert "layoutAndRenderGraph" in HTML_PAGE
    assert "renderGraphPanel" in HTML_PAGE


def test_html_page_highlights_traversed_nodes():
    """Traversed nodes must visibly differ from un-traversed ones; the
    CSS class `traversed` is what the JS toggles. Lock its presence so
    a refactor doesn't silently break the visualization contract."""
    assert ".node.traversed" in HTML_PAGE
    assert ".edge.traversed" in HTML_PAGE


def test_html_page_styles_handoff_differently():
    """Handoff nodes/edges are differentiated visually (dashed + color)
    so cross-runtime boundaries are obvious. Same lock-pattern: the
    selectors must remain in the stylesheet."""
    assert ".node.handoff" in HTML_PAGE
    assert ".edge.handoff" in HTML_PAGE
