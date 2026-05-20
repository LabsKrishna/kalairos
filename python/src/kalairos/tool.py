"""Tool primitive — the building block of agent capabilities.

A `Tool` wraps a Python callable with the structured metadata an LLM
needs to call it: name, natural-language description, and a JSON Schema
describing the arguments. Tools register into a `ToolRegistry`, which
the agent runtime exposes to the LLM as the available action surface.

The Anthropic SDK consumes tool definitions in `{name, description,
input_schema}` form; `Tool.to_anthropic_schema()` renders that shape
without coupling the primitive to the SDK itself (Phase 2.4 wires the
SDK; staging the renderer here so we don't have to refactor `Tool`
when we get there).

Phase 2.1 scope: bare Tool + decorator + registry. JSON Schema
validation, async tool handlers, and structured error responses come
in later sub-PRs once we have concrete needs to design against.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class Tool:
    """A callable agent tool with LLM-facing metadata.

    Frozen because tool definitions are part of the agent's contract
    with the LLM — mutating them after registration would invalidate
    in-flight tool calls.
    """

    name: str
    description: str
    parameters: dict
    handler: Callable[..., Any]

    def call(self, **kwargs: Any) -> Any:
        """Invoke the underlying handler. kwargs flow straight through;
        argument validation is the handler's responsibility (or the
        LLM's, against the `parameters` schema)."""
        return self.handler(**kwargs)

    def to_anthropic_schema(self) -> dict:
        """Render as an Anthropic tool definition for the messages API."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        }


# Default schema for tools whose handlers take no arguments. JSON Schema
# requires an explicit object type for tool input_schema; this keeps the
# zero-arg case clean.
_EMPTY_SCHEMA: dict = {"type": "object", "properties": {}, "required": []}


def tool(
    *,
    name: str | None = None,
    description: str | None = None,
    parameters: dict | None = None,
) -> Callable[[Callable[..., Any]], Tool]:
    """Decorator turning a function into a `Tool`.

    Defaults:
      - `name`        → the function's `__name__`
      - `description` → the function's docstring (first paragraph)
      - `parameters`  → empty-object schema (no args)

    Example:
        @tool(description="Read a file from disk", parameters=SCHEMA)
        def read_file(path: str) -> str:
            return Path(path).read_text()
    """

    def _wrap(fn: Callable[..., Any]) -> Tool:
        tool_name = name or fn.__name__
        tool_description = description if description is not None else (
            inspect.getdoc(fn) or ""
        )
        tool_parameters = parameters if parameters is not None else _EMPTY_SCHEMA
        return Tool(
            name=tool_name,
            description=tool_description,
            parameters=tool_parameters,
            handler=fn,
        )

    return _wrap


class ToolRegistry:
    """A name → Tool mapping the agent runtime exposes to the LLM.

    Registration is one-shot per name: registering a duplicate raises.
    This is the simplest way to catch accidental conflicts in a system
    where agents inherit tools from multiple sources (e.g. a base
    toolset + agent-specific additions).
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, t: Tool) -> Tool:
        """Register a tool. Returns the tool for chaining. Raises
        `ValueError` if a tool with the same name is already registered."""
        if t.name in self._tools:
            raise ValueError(
                f"ToolRegistry: tool {t.name!r} is already registered"
            )
        self._tools[t.name] = t
        return t

    def get(self, name: str) -> Tool:
        """Get a tool by name. Raises `KeyError` if missing."""
        if name not in self._tools:
            raise KeyError(f"ToolRegistry: no tool named {name!r}")
        return self._tools[name]

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def to_anthropic_schema(self) -> list[dict]:
        """All tools rendered as Anthropic tool definitions, ready to
        pass to the messages API in the `tools` field."""
        return [t.to_anthropic_schema() for t in self._tools.values()]

    def __contains__(self, name: str) -> bool:
        return name in self._tools

    def __len__(self) -> int:
        return len(self._tools)

    def __iter__(self):
        return iter(self._tools.values())
