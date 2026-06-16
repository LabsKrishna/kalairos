"""Kalairos Python kernel + agent runtime.

Python is the sole writer to the canonical `ledger.jsonl`. Node services
emit append events over local MCP/HTTP and never touch the file directly.
See project_agent_platform.md.
"""

from .__about__ import __version__
from .agent import Agent
from .executor import Executor
from .jsonl import JsonlAppender
from .ledger import Ledger
from .llm import LLMLoop
from .replay import ReplayResult, replay
from .run import Run
from .schema import SCHEMA_VERSION
from .server import LedgerServer
from .sqlite_index import SqliteStreamer
from .tool import Tool, ToolRegistry, tool
from .workflow_graph import BranchNode, HandoffNode, StepNode, WorkflowGraph

__all__ = [
    "Agent",
    "BranchNode",
    "Executor",
    "HandoffNode",
    "JsonlAppender",
    "LLMLoop",
    "Ledger",
    "LedgerServer",
    "ReplayResult",
    "Run",
    "SCHEMA_VERSION",
    "SqliteStreamer",
    "StepNode",
    "Tool",
    "ToolRegistry",
    "WorkflowGraph",
    "replay",
    "tool",
    "__version__",
]
