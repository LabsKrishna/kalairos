"""Smoke + cross-language drift tests.

Package surface checks live here. Anything that asserts "Python is in sync
with JS source of truth" (SCHEMA_VERSION, meta keys, schema DDL, PRAGMA
ordering) also lives here so a single test run answers: did either side
drift?
"""

import re
from pathlib import Path

import kalairos
from kalairos import schema
from kalairos.entity_normalizer import _SOURCE_TRUST_DEFAULTS, _VALID_MEMORY_TYPES
from kalairos.sqlite_index import PRAGMAS, REBUILD_PRAGMAS, SCHEMA_V1_SQL
from kalairos.versioning import ACTIONS

REPO_ROOT = Path(__file__).resolve().parents[2]
JS_SQLITE_INDEX = REPO_ROOT / "store" / "sqlite-index.js"
JS_ENTITY_NORMALIZER = REPO_ROOT / "store" / "entity-normalizer.js"
JS_VERSIONING = REPO_ROOT / "versioning.js"


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


def test_schema_v1_sql_matches_js_source_of_truth():
    """The Python SCHEMA_V1_SQL must match the JS SCHEMA_V1_SQL template
    literal verbatim (after trimming). DDL drift fails CI immediately —
    same shape on both runtimes is the v1.7 storage invariant."""
    js_source = JS_SQLITE_INDEX.read_text()
    m = re.search(r"const SCHEMA_V1_SQL\s*=\s*`(.*?)`;", js_source, re.DOTALL)
    assert m, f"Could not find SCHEMA_V1_SQL template literal in {JS_SQLITE_INDEX}"
    js_sql = m.group(1).strip()
    py_sql = SCHEMA_V1_SQL.strip()
    assert py_sql == js_sql, (
        "Python SCHEMA_V1_SQL drifted from JS source.\n\n"
        f"--- JS ({JS_SQLITE_INDEX}) ---\n{js_sql}\n\n"
        f"--- Python ---\n{py_sql}"
    )


def test_pragmas_match_js_source_of_truth():
    """PRAGMA list (and ORDER) must match JS exactly. journal_mode must
    come first — WAL has to be active before any DDL runs."""
    js_source = JS_SQLITE_INDEX.read_text()
    m = re.search(r"const PRAGMAS\s*=\s*\[(.*?)\];", js_source, re.DOTALL)
    assert m, f"Could not find PRAGMAS array in {JS_SQLITE_INDEX}"
    js_pragmas = tuple(re.findall(r'"([^"]+)"', m.group(1)))
    assert PRAGMAS == js_pragmas, (
        f"Python PRAGMAS drifted from JS source.\n"
        f"  JS:     {js_pragmas}\n"
        f"  Python: {PRAGMAS}"
    )


def test_rebuild_pragmas_match_js_source_of_truth():
    """The rebuild-time PRAGMA set must match too. journal_mode=DELETE
    (not WAL) is deliberate for rebuild — WAL leaves `-wal` and `-shm`
    siblings that complicate the atomic rename swap."""
    js_source = JS_SQLITE_INDEX.read_text()
    m = re.search(r"const REBUILD_PRAGMAS\s*=\s*\[(.*?)\];", js_source, re.DOTALL)
    assert m, f"Could not find REBUILD_PRAGMAS array in {JS_SQLITE_INDEX}"
    js_pragmas = tuple(re.findall(r'"([^"]+)"', m.group(1)))
    assert REBUILD_PRAGMAS == js_pragmas, (
        f"Python REBUILD_PRAGMAS drifted from JS source.\n"
        f"  JS:     {js_pragmas}\n"
        f"  Python: {REBUILD_PRAGMAS}"
    )


def test_source_trust_defaults_match_js_source_of_truth():
    """Default trust scores by source type must match JS verbatim. These
    set the implicit trust floor on every entity, so drift changes which
    rows are considered trustworthy by recall — a behavioral break, not
    just a cosmetic one."""
    js_source = JS_ENTITY_NORMALIZER.read_text()
    m = re.search(
        r"_SOURCE_TRUST_DEFAULTS\s*=\s*\{([^}]+)\}", js_source, re.DOTALL
    )
    assert m, f"Could not find _SOURCE_TRUST_DEFAULTS in {JS_ENTITY_NORMALIZER}"
    js_defaults: dict[str, float] = {}
    for match in re.finditer(r"(\w+):\s*([0-9.]+)", m.group(1)):
        js_defaults[match.group(1)] = float(match.group(2))
    assert _SOURCE_TRUST_DEFAULTS == js_defaults, (
        f"Trust defaults drifted.\n  JS:     {js_defaults}\n"
        f"  Python: {_SOURCE_TRUST_DEFAULTS}"
    )


def test_valid_memory_types_match_js_source_of_truth():
    """The set of accepted memoryType values must match JS. A type valid
    in one runtime but invalid in the other would silently downgrade to
    'long-term' on the stricter side."""
    js_source = JS_ENTITY_NORMALIZER.read_text()
    m = re.search(
        r"_VALID_MEMORY_TYPES\s*=\s*new Set\(\[(.*?)\]\)", js_source, re.DOTALL
    )
    assert m, f"Could not find _VALID_MEMORY_TYPES in {JS_ENTITY_NORMALIZER}"
    js_types = set(re.findall(r'"([^"]+)"', m.group(1)))
    assert set(_VALID_MEMORY_TYPES) == js_types, (
        f"Valid memory types drifted.\n  JS:     {js_types}\n"
        f"  Python: {set(_VALID_MEMORY_TYPES)}"
    )


def test_actions_vocab_matches_js_source_of_truth():
    """Audit-trail action vocabulary must match. The trail is "auditable"
    only if readers can switch on a closed enum — drift means a switch
    statement on one runtime would silently miss actions written by the
    other."""
    js_source = JS_VERSIONING.read_text()
    m = re.search(
        r"const ACTIONS\s*=\s*Object\.freeze\(\{([^}]+)\}\)", js_source, re.DOTALL
    )
    assert m, f"Could not find ACTIONS object in {JS_VERSIONING}"
    js_actions: dict[str, str] = {}
    for match in re.finditer(r'(\w+):\s*"([^"]+)"', m.group(1)):
        js_actions[match.group(1)] = match.group(2)
    py_actions = dict(ACTIONS)
    assert py_actions == js_actions, (
        f"ACTIONS vocab drifted.\n  JS:     {js_actions}\n  Python: {py_actions}"
    )
