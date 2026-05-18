"""JsonlAppender — sole writer to the canonical JSONL ledger.

Mirrors the durability contract of `store/file-store.js`:
  * Every append calls fsync before returning, so an acknowledged write
    survives a power loss on filesystems that honour fsync.
  * `persist_all` writes to `<path>.tmp`, fsyncs it, atomically renames into
    place, then fsyncs the parent directory so the rename is durable.
  * If the process crashes between tmp write and rename, `load_raw` reaps
    the orphaned `.tmp` on next start — JSONL is the source of truth.
  * Thread-safe within one process (single `threading.Lock` around append
    and persist_all). Multiple processes writing to the same file WILL
    corrupt it; agent platform plans for one Python kernel per store.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger(__name__)

# Errno values we tolerate from directory fsync. Windows can't open a
# directory for read at all (EACCES); some filesystems return ENOTSUP /
# EINVAL when fsyncing a directory fd. None of these block the rename
# from being atomic on POSIX, so swallow them and re-raise anything else.
_DIR_FSYNC_OK = frozenset({
    errno.EACCES,
    errno.EISDIR,
    errno.EINVAL,
    errno.ENOTSUP,
    errno.EPERM,
})


class JsonlAppender:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = threading.Lock()

    def append(self, record: dict) -> int:
        """Append one record. Returns the byte offset where the line starts.

        The offset is what the upcoming SqliteStreamer records as
        `jsonl_offset` so the boot decision tree can detect divergence
        (see `store/sqlite-index.js`).
        """
        line = (
            json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
        ).encode("utf-8")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            try:
                # With the lock held no other thread races between this seek
                # and the write, so the returned offset is where the line
                # actually lands.
                offset = os.lseek(fd, 0, os.SEEK_END)
                _write_all(fd, line)
                os.fsync(fd)
            finally:
                os.close(fd)
            return offset

    def load_raw(self) -> list[dict]:
        """Load all records from the ledger.

        Reaps any `<path>.tmp` left by a crashed `persist_all` on entry.
        Skips malformed lines with a warning. Returns `[]` if the ledger
        file does not exist yet.
        """
        tmp = self._tmp_path()
        if tmp.exists():
            try:
                tmp.unlink()
                log.warning(
                    "JsonlAppender: reaped orphaned %s from prior crash", tmp.name
                )
            except OSError as e:
                log.warning("JsonlAppender: failed to reap %s: %s", tmp, e)

        if not self.path.exists():
            return []

        rows: list[dict] = []
        with self.path.open("r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.rstrip("\n")
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    log.warning(
                        "JsonlAppender: skipping malformed line: %s", line[:80]
                    )
        return rows

    def persist_all(self, records: list[dict]) -> None:
        """Atomic rewrite of the ledger.

        Writes to `<path>.tmp` with fsync, atomically renames into place,
        then best-effort fsyncs the parent directory so the dirent is
        durable.
        """
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._tmp_path()
            data = (
                "\n".join(
                    json.dumps(r, separators=(",", ":"), ensure_ascii=False)
                    for r in records
                )
                + "\n"
            ).encode("utf-8") if records else b""

            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
            try:
                _write_all(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)

            os.replace(tmp, self.path)
            _fsync_dir(self.path.parent)

    def shutdown(self) -> None:
        # Symmetric with store/file-store.js — no persistent handle to close.
        pass

    def _tmp_path(self) -> Path:
        return self.path.parent / (self.path.name + ".tmp")


def _write_all(fd: int, data: bytes) -> None:
    """Loop until all bytes are written. Short writes are rare on local
    disks but legal; not retrying them silently truncates the write."""
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError(f"os.write returned {n}; refusing to spin")
        view = view[n:]


def _fsync_dir(dir_path: Path) -> None:
    """Best-effort fsync of a directory so a recent rename is durable.

    Windows can't open a directory for reading, and some filesystems
    refuse fsync on a directory fd. The rename is already atomic on
    POSIX — the dir fsync is the belt-and-suspenders pass. Swallow the
    documented platform errors, re-raise anything else.
    """
    try:
        fd = os.open(dir_path, os.O_RDONLY)
    except OSError as e:
        if e.errno in _DIR_FSYNC_OK:
            return
        raise
    try:
        try:
            os.fsync(fd)
        except OSError as e:
            if e.errno not in _DIR_FSYNC_OK:
                raise
    finally:
        os.close(fd)
