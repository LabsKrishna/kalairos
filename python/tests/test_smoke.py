"""Phase 0 smoke test: package imports and schema stays in sync with JS."""

import re
from pathlib import Path

import kalairos
from kalairos import schema

REPO_ROOT = Path(__file__).resolve().parents[2]
JS_SQLITE_INDEX = REPO_ROOT / "store" / "sqlite-index.js"


def test_package_imports():
    assert kalairos.__version__ == "0.0.1"
    assert kalairos.SCHEMA_VERSION == "1"
    # Public surface — these names must exist as classes/values.
    assert kalairos.JsonlAppender is not None
    assert kalairos.SqliteStreamer is not None
    assert kalairos.Ledger is not None


def test_schema_version_matches_js_source_of_truth():
    """If JS bumps SCHEMA_VERSION, Python must follow. This test fails the
    moment they drift."""
    js_source = JS_SQLITE_INDEX.read_text()
    m = re.search(r'const SCHEMA_VERSION\s*=\s*"([^"]+)"', js_source)
    assert m, f"Could not find SCHEMA_VERSION in {JS_SQLITE_INDEX}"
    js_version = m.group(1)
    assert schema.SCHEMA_VERSION == js_version, (
        f"Python SCHEMA_VERSION={schema.SCHEMA_VERSION!r} but JS "
        f"SCHEMA_VERSION={js_version!r}. Update python/src/kalairos/schema.py."
    )


def test_meta_keys_referenced_in_js():
    """Every meta key Python declares must appear in the JS sqlite-index
    code. Catches Python referencing a key that doesn't exist on the JS side."""
    js_source = JS_SQLITE_INDEX.read_text()
    declared = [
        schema.META_KEY_SCHEMA_VERSION,
        schema.META_KEY_JSONL_PATH,
        schema.META_KEY_JSONL_SIZE_BYTES,
        schema.META_KEY_JSONL_SHA256_FIRST_4KB,
        schema.META_KEY_LAST_JSONL_OFFSET,
        schema.META_KEY_DIRTY,
        schema.META_KEY_KALAIROS_VERSION,
        schema.META_KEY_INDEX_BUILT_AT,
    ]
    missing = [k for k in declared if f'"{k}"' not in js_source]
    assert not missing, (
        f"Meta keys declared in Python but not found in {JS_SQLITE_INDEX}: "
        f"{missing}"
    )
