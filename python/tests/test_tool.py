"""Tests for Tool / @tool / ToolRegistry — Phase 2.1.

The Tool primitive is the leaf-level building block of agent
capabilities. These tests pin its surface so the Agent/Run/WorkflowGraph
layers built on top can rely on the contract.
"""

import dataclasses

import pytest

from kalairos import Tool, ToolRegistry, tool


_PATH_SCHEMA = {
    "type": "object",
    "properties": {"path": {"type": "string"}},
    "required": ["path"],
}


# ── Tool dataclass ─────────────────────────────────────────────────────────


def test_tool_constructed_directly():
    def handler(path):
        return f"read:{path}"

    t = Tool(
        name="read_file",
        description="Read a file from disk",
        parameters=_PATH_SCHEMA,
        handler=handler,
    )
    assert t.name == "read_file"
    assert t.description == "Read a file from disk"
    assert t.parameters == _PATH_SCHEMA
    assert t.handler is handler


def test_tool_call_invokes_handler_with_kwargs():
    def handler(path):
        return f"read:{path}"

    t = Tool(name="r", description="", parameters=_PATH_SCHEMA, handler=handler)
    assert t.call(path="/tmp/x") == "read:/tmp/x"


def test_tool_is_frozen_dataclass():
    """Tool definitions are part of the LLM contract — mutating them
    after registration would invalidate in-flight tool calls."""
    t = Tool(name="x", description="", parameters={}, handler=lambda: None)
    with pytest.raises(dataclasses.FrozenInstanceError):
        t.name = "y"  # type: ignore[misc]


def test_tool_to_anthropic_schema():
    t = Tool(
        name="read_file",
        description="Read",
        parameters=_PATH_SCHEMA,
        handler=lambda path: path,
    )
    assert t.to_anthropic_schema() == {
        "name": "read_file",
        "description": "Read",
        "input_schema": _PATH_SCHEMA,
    }


# ── @tool decorator ────────────────────────────────────────────────────────


def test_decorator_creates_tool_instance():
    @tool(description="Read a file", parameters=_PATH_SCHEMA)
    def read_file(path):
        return f"contents of {path}"

    assert isinstance(read_file, Tool)


def test_decorator_name_defaults_to_function_name():
    @tool(description="x", parameters=_PATH_SCHEMA)
    def read_file(path):
        return path

    assert read_file.name == "read_file"


def test_decorator_name_override():
    @tool(name="reader", description="x", parameters={})
    def read_file():
        pass

    assert read_file.name == "reader"


def test_decorator_description_from_docstring():
    """If no description is passed, the function's docstring is used —
    the docstring is what the LLM would naturally read about the tool."""

    @tool(parameters={})
    def my_tool():
        """This is what the LLM reads."""
        return None

    assert my_tool.description == "This is what the LLM reads."


def test_decorator_description_override_wins_over_docstring():
    @tool(description="explicit override", parameters={})
    def my_tool():
        """should be ignored"""
        return None

    assert my_tool.description == "explicit override"


def test_decorator_empty_description_when_neither_provided():
    @tool(parameters={})
    def my_tool():
        return None

    assert my_tool.description == ""


def test_decorator_parameters_default_to_empty_object_schema():
    @tool(description="x")
    def my_tool():
        return "ok"

    assert my_tool.parameters == {
        "type": "object",
        "properties": {},
        "required": [],
    }
    # And the zero-arg call works without kwargs.
    assert my_tool.call() == "ok"


def test_decorator_call_invokes_underlying_function():
    @tool(description="x", parameters=_PATH_SCHEMA)
    def read_file(path):
        return path.upper()

    assert read_file.call(path="hello") == "HELLO"


# ── ToolRegistry ───────────────────────────────────────────────────────────


@pytest.fixture
def two_tools():
    @tool(description="A", parameters=_PATH_SCHEMA)
    def a(path):
        return f"a:{path}"

    @tool(description="B", parameters={})
    def b():
        return "b"

    return a, b


def test_registry_register_and_get(two_tools):
    a, _ = two_tools
    reg = ToolRegistry()
    reg.register(a)
    assert reg.get("a") is a


def test_registry_register_returns_tool_for_chaining(two_tools):
    a, _ = two_tools
    reg = ToolRegistry()
    assert reg.register(a) is a


def test_registry_duplicate_register_raises(two_tools):
    a, _ = two_tools
    reg = ToolRegistry()
    reg.register(a)
    with pytest.raises(ValueError, match="already registered"):
        reg.register(a)


def test_registry_get_missing_raises():
    reg = ToolRegistry()
    with pytest.raises(KeyError, match="no tool"):
        reg.get("nope")


def test_registry_contains_operator(two_tools):
    a, _ = two_tools
    reg = ToolRegistry()
    reg.register(a)
    assert "a" in reg
    assert "nope" not in reg


def test_registry_len(two_tools):
    a, b = two_tools
    reg = ToolRegistry()
    assert len(reg) == 0
    reg.register(a)
    reg.register(b)
    assert len(reg) == 2


def test_registry_iter_yields_tools_in_registration_order(two_tools):
    a, b = two_tools
    reg = ToolRegistry()
    reg.register(a)
    reg.register(b)
    assert list(reg) == [a, b]


def test_registry_list_and_names(two_tools):
    a, b = two_tools
    reg = ToolRegistry()
    reg.register(a)
    reg.register(b)
    assert reg.names() == ["a", "b"]
    assert reg.list() == [a, b]


def test_registry_to_anthropic_schema(two_tools):
    a, b = two_tools
    reg = ToolRegistry()
    reg.register(a)
    reg.register(b)
    schemas = reg.to_anthropic_schema()
    assert [s["name"] for s in schemas] == ["a", "b"]
    a_schema = schemas[0]
    assert a_schema == {
        "name": "a",
        "description": "A",
        "input_schema": _PATH_SCHEMA,
    }


def test_registry_end_to_end_dispatch(two_tools):
    """A realistic flow: LLM picks a tool by name, registry returns it,
    we call it with the LLM-provided kwargs and get the result back."""
    a, _ = two_tools
    reg = ToolRegistry()
    reg.register(a)

    # Simulate an LLM response: { tool: "a", input: { path: "x" } }
    chosen = reg.get("a")
    result = chosen.call(path="x")
    assert result == "a:x"
