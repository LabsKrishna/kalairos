"""Ledger — unified read/write API over the JSONL + SQLite pipeline.

`append()` goes to the JSONL appender (canonical write).
`query()` and `tail()` read from the SQLite streamer (derived read index).

Phase 1 wires the two halves together and adds the Python-side MCP/HTTP
endpoint Node services hit to emit append events.
"""

from pathlib import Path

from .jsonl import JsonlAppender
from .sqlite_index import SqliteStreamer


class Ledger:
    def __init__(self, jsonl_path: Path | str, sqlite_path: Path | str):
        self.appender = JsonlAppender(jsonl_path)
        self.streamer = SqliteStreamer(sqlite_path)

    def open(self) -> None:
        raise NotImplementedError("Phase 1: Ledger.open")

    def append(self, record: dict) -> int:
        raise NotImplementedError("Phase 1: Ledger.append")

    def query(self, **filters) -> list[dict]:
        raise NotImplementedError("Phase 1: Ledger.query")

    def tail(self, callback) -> None:
        raise NotImplementedError("Phase 1: Ledger.tail")

    def close(self) -> None:
        self.appender.shutdown()
        self.streamer.close()
