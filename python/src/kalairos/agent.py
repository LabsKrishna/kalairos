"""Agent — a persistent identity bundling instructions and tools.

An Agent is the static definition; a `Run` (run.py) is an execution
instance of an Agent toward a goal. Multiple Runs can share one Agent
(it's stateless besides its configuration).

Phase 2.2 scope: name + system-prompt-shaped `instructions` + a
ToolRegistry built from the iterable passed in. Inheritance from a base
agent, sub-agent delegation, and per-agent prompt-caching policies come
later.
"""

from __future__ import annotations

from typing import Iterable

from .tool import Tool, ToolRegistry


class Agent:
    """A reusable agent definition.

    Args:
      name: short identifier; flows into event tags and logs.
      instructions: system-prompt text the LLM will see (Phase 2.4 wires
        this into the messages API; carried here so callers can author
        agents fully today and not refactor later).
      tools: iterable of `Tool` instances the agent can call. Duplicate
        names raise (handled by `ToolRegistry`).
    """

    def __init__(
        self,
        name: str,
        instructions: str = "",
        tools: Iterable[Tool] = (),
    ):
        if not name:
            raise ValueError("Agent: name is required")
        self.name = name
        self.instructions = instructions
        self.tools = ToolRegistry()
        for t in tools:
            self.tools.register(t)

    def __repr__(self) -> str:
        return f"Agent(name={self.name!r}, tools={self.tools.names()})"
