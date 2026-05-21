"""Tests for the Agent class — Phase 2.2."""

import pytest

from kalairos import Agent, tool


def _make_path_tool():
    @tool(
        description="Read a file",
        parameters={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )
    def read_file(path: str) -> str:
        return f"contents:{path}"

    return read_file


def test_agent_minimal():
    a = Agent(name="researcher")
    assert a.name == "researcher"
    assert a.instructions == ""
    assert len(a.tools) == 0


def test_agent_with_instructions():
    a = Agent(name="x", instructions="be helpful")
    assert a.instructions == "be helpful"


def test_agent_with_tools():
    t = _make_path_tool()
    a = Agent(name="x", tools=[t])
    assert len(a.tools) == 1
    assert "read_file" in a.tools


def test_agent_tools_are_callable_via_registry():
    t = _make_path_tool()
    a = Agent(name="x", tools=[t])
    assert a.tools.get("read_file").call(path="/tmp/x") == "contents:/tmp/x"


def test_agent_requires_non_empty_name():
    with pytest.raises(ValueError, match="name is required"):
        Agent(name="")


def test_agent_duplicate_tool_names_raise():
    t = _make_path_tool()
    with pytest.raises(ValueError, match="already registered"):
        Agent(name="x", tools=[t, t])


def test_agent_repr_includes_name_and_tool_names():
    a = Agent(name="researcher", tools=[_make_path_tool()])
    s = repr(a)
    assert "researcher" in s
    assert "read_file" in s


def test_multiple_agents_have_independent_tool_registries():
    """Two agents constructed from the same Tool list each get their
    own ToolRegistry — registering on one doesn't bleed into the other."""
    t = _make_path_tool()
    a1 = Agent(name="a1", tools=[t])
    a2 = Agent(name="a2")
    assert "read_file" in a1.tools
    assert "read_file" not in a2.tools
