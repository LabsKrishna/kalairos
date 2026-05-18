"""SqliteStreamer — streams canonical JSONL appends into the derived SQLite
read index.

Mirrors `store/sqlite-index.js`: schema v1, WAL mode, READY/REPLAY/REBUILD
boot decision tree. Agents query this index; they never write to it.
Implementation lands in Phase 1.
"""

from pathlib import Path


class SqliteStreamer:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.db = None

    def open(self) -> None:
        raise NotImplementedError("Phase 1: SqliteStreamer.open")

    def apply_entity(
        self, record: dict, jsonl_offset: int, jsonl_size_after: int
    ) -> None:
        raise NotImplementedError("Phase 1: SqliteStreamer.apply_entity")

    def truncate_and_replay(self, jsonl_path: Path | str) -> None:
        raise NotImplementedError("Phase 1: SqliteStreamer.truncate_and_replay")

    def close(self) -> None:
        pass
