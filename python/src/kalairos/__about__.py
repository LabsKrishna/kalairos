"""Single source of truth for the Python kalairos package version.

Both `__init__.py` and `sqlite_index.py` (which writes the version into
`meta.kalairos_version` on rebuild) read from here. Keep in sync with the
`version` field in `python/pyproject.toml` until we wire importlib.metadata
in a follow-up.
"""

__version__ = "0.0.1"
