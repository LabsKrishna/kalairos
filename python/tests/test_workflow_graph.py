"""Tests for WorkflowGraph + StepNode + BranchNode — Phase 2.3."""

import dataclasses

import pytest

from kalairos import BranchNode, StepNode, WorkflowGraph


# ── StepNode ───────────────────────────────────────────────────────────────


def test_step_node_with_tool():
    n = StepNode(
        name="read",
        tool="read_file",
        inputs=lambda s: {"path": s["path"]},
        output_key="data",
        next="next",
    )
    assert n.name == "read"
    assert n.tool == "read_file"
    assert n.output_key == "data"


def test_step_node_with_think():
    n = StepNode(name="reason", think="thinking out loud")
    assert n.think == "thinking out loud"
    assert n.tool is None


def test_step_node_requires_tool_xor_think():
    with pytest.raises(ValueError, match="exactly one"):
        StepNode(name="x")
    with pytest.raises(ValueError, match="exactly one"):
        StepNode(name="x", tool="t", think="th")


def test_step_node_think_cannot_have_inputs_or_output_key():
    with pytest.raises(ValueError, match="can't have"):
        StepNode(name="x", think="t", inputs=lambda s: {})
    with pytest.raises(ValueError, match="can't have"):
        StepNode(name="x", think="t", output_key="x")


def test_step_node_is_frozen():
    n = StepNode(name="x", tool="t")
    with pytest.raises(dataclasses.FrozenInstanceError):
        n.name = "y"  # type: ignore[misc]


# ── BranchNode ─────────────────────────────────────────────────────────────


def test_branch_node_basic():
    n = BranchNode(
        name="route",
        condition=lambda s: "left" if s.get("x") else "right",
        branches={"left": "L", "right": "R"},
    )
    assert n.name == "route"
    assert n.branches["left"] == "L"


def test_branch_node_requires_at_least_one_branch():
    with pytest.raises(ValueError, match="at least one branch"):
        BranchNode(name="x", condition=lambda s: "k", branches={})


def test_branch_node_is_frozen():
    n = BranchNode(name="x", condition=lambda s: "k", branches={"k": "n"})
    with pytest.raises(dataclasses.FrozenInstanceError):
        n.name = "y"  # type: ignore[misc]


# ── WorkflowGraph ──────────────────────────────────────────────────────────


def test_graph_construction_requires_name():
    with pytest.raises(ValueError, match="name is required"):
        WorkflowGraph(name="")


def test_graph_empty_when_constructed():
    g = WorkflowGraph(name="g")
    assert g.name == "g"
    assert len(g) == 0


def test_graph_add_and_contains():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    assert "a" in g
    assert "b" not in g
    assert len(g) == 1


def test_graph_duplicate_add_raises():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    with pytest.raises(ValueError, match="already added"):
        g.add(StepNode(name="a", think="y"))


def test_graph_get_unknown_raises():
    g = WorkflowGraph(name="g")
    with pytest.raises(KeyError, match="no node"):
        g.get("nope")


def test_graph_set_start_requires_existing_node():
    g = WorkflowGraph(name="g")
    with pytest.raises(ValueError, match="no node 'a'"):
        g.set_start("a")


def test_graph_start_node_unset_raises():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    with pytest.raises(RuntimeError, match="no start node"):
        g.start_node()


def test_graph_start_node_returns_set_node():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    g.set_start("a")
    assert g.start_node().name == "a"


def test_graph_iteration_yields_nodes_in_add_order():
    g = WorkflowGraph(name="g")
    a = StepNode(name="a", think="x")
    b = StepNode(name="b", think="y")
    g.add(a)
    g.add(b)
    assert list(g) == [a, b]
    assert g.names() == ["a", "b"]


# ── validate() ─────────────────────────────────────────────────────────────


def test_validate_requires_start():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    with pytest.raises(ValueError, match="no start node"):
        g.validate()


def test_validate_passes_on_well_formed_linear_graph():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x", next="b"))
    g.add(StepNode(name="b", think="y"))
    g.set_start("a")
    g.validate()  # no raise


def test_validate_passes_with_unset_next_as_terminal():
    """next=None means the step is terminal — perfectly legal."""
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x"))
    g.set_start("a")
    g.validate()


def test_validate_rejects_dangling_next_pointer():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x", next="missing"))
    g.set_start("a")
    with pytest.raises(ValueError, match="unknown next"):
        g.validate()


def test_validate_rejects_dangling_branch_target():
    g = WorkflowGraph(name="g")
    g.add(StepNode(name="a", think="x", next="b"))
    g.add(
        BranchNode(
            name="b",
            condition=lambda s: "left",
            branches={"left": "missing", "right": "a"},
        )
    )
    g.set_start("a")
    with pytest.raises(ValueError, match="unknown node 'missing'"):
        g.validate()
