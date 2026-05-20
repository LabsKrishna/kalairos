"""Kalairos Python kernel + agent runtime.

Python is the sole writer to the canonical `ledger.jsonl`. Node services
emit append events over local MCP/HTTP and never touch the file directly.
See project_agent_platform.md.
"""

from .__about__ import __version__
from .jsonl import JsonlAppender
from .ledger import Ledger
from .schema import SCHEMA_VERSION
from .server import LedgerServer
from .sqlite_index import SqliteStreamer
from .tool import Tool, ToolRegistry, tool

__all__ = [
    "JsonlAppender",
    "Ledger",
    "LedgerServer",
    "SCHEMA_VERSION",
    "SqliteStreamer",
    "Tool",
    "ToolRegistry",
    "tool",
    "__version__",
]
