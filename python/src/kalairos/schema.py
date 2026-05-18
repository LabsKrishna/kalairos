"""v1.7 storage schema constants.

JS is the source of truth (`store/sqlite-index.js`). This module mirrors the
constants the Python kernel needs to read/write the same JSONL format and
construct equivalent SQLite indexes. `tests/test_smoke.py` asserts these
constants match the JS source — drift fails CI.
"""

SCHEMA_VERSION = "1"

META_KEY_SCHEMA_VERSION = "schema_version"
META_KEY_JSONL_PATH = "jsonl_path"
META_KEY_JSONL_SIZE_BYTES = "jsonl_size_bytes"
META_KEY_JSONL_SHA256_FIRST_4KB = "jsonl_sha256_first_4kb"
META_KEY_LAST_JSONL_OFFSET = "last_jsonl_offset"
META_KEY_DIRTY = "dirty"
META_KEY_KALAIROS_VERSION = "kalairos_version"
META_KEY_INDEX_BUILT_AT = "index_built_at"
