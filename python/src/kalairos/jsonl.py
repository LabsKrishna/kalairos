"""JsonlAppender — sole writer to the canonical JSONL ledger.

Mirrors the durability contract of `store/file-store.js`:
  - append → fsync before return
  - rewrite → tmp file + atomic rename, fsync of parent dir
  - single-process only

Implementation lands in Phase 1.
"""

from pathlib import Path


class JsonlAppender:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    def append(self, record: dict) -> int:
        """Append one record. Returns the byte offset of the appended line."""
        raise NotImplementedError("Phase 1: JsonlAppender.append")

    def load_raw(self) -> list[dict]:
        """Load all records from the ledger. Skips malformed lines with a
        warning and reaps orphaned `.tmp` on entry."""
        raise NotImplementedError("Phase 1: JsonlAppender.load_raw")

    def persist_all(self, records: list[dict]) -> None:
        """Atomic rewrite via tmp + rename, fsync'd."""
        raise NotImplementedError("Phase 1: JsonlAppender.persist_all")

    def shutdown(self) -> None:
        pass
