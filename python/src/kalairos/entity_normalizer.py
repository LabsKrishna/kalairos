"""Entity shape normalization — port of store/entity-normalizer.js.

Pure functions extracted so the SQLite rebuild path (Phase 1.2.3) can
apply the same legacy-data defaulting and version-chain backfill that
the in-memory hot cache uses. Single source of truth across runtimes is
what guarantees "rebuild from JSONL" produces the same entity shape that
ingest produces — no SQLite-vs-Map drift.

No I/O, no module state. Inputs are mutated in place where the original
JS did so (e.g. normalize_raw); pure helpers return new values.
"""

from __future__ import annotations

import math
from typing import Any

from .versioning import synthesize_action

# Default trust scores by provenance type. Explicit annotations override
# these. Hierarchy reflects information quality: users and verified tools
# score higher than automated agents; raw files and system-generated
# content score lowest. Mirrors _SOURCE_TRUST_DEFAULTS in
# store/entity-normalizer.js.
_SOURCE_TRUST_DEFAULTS = {
    "user":   0.90,
    "agent":  0.75,
    "tool":   0.80,
    "file":   0.70,
    "system": 0.60,
}


def default_trust_score(source_type: str | None) -> float:
    """Default trust score for a given source type. Unknown types fall
    back to 0.70 — the same as `file` (treat unknown like external)."""
    return _SOURCE_TRUST_DEFAULTS.get(source_type or "", 0.70)


def normalize_classification(value: Any) -> str:
    """Canonicalize sensitivity label; caller-defined strings pass through
    unchanged (lower-cased)."""
    if not value:
        return "internal"
    s = str(value).strip().lower()
    return s if s else "internal"


def normalize_retention(value: Any) -> dict:
    """Canonicalize retention policy. Defaults to
    `{policy: "keep", expiresAt: None}`."""
    if not isinstance(value, dict):
        return {"policy": "keep", "expiresAt": None}
    expires_at = value.get("expiresAt")
    return {
        "policy": str(value.get("policy") or "keep").strip().lower(),
        "expiresAt": expires_at if _is_finite(expires_at) else None,
    }


_VALID_MEMORY_TYPES = frozenset({"short-term", "long-term", "working"})


def normalize_memory_type(value: Any) -> str:
    """Canonicalize memory type. Defaults to `long-term`."""
    if not value:
        return "long-term"
    v = str(value).strip().lower()
    return v if v in _VALID_MEMORY_TYPES else "long-term"


def normalize_workspace_id(value: Any) -> str:
    """Canonicalize workspace id. Defaults to `default`."""
    if not value:
        return "default"
    s = str(value).strip()
    return s if s else "default"


def make_version_id(entity_id: str, ordinal: int) -> str:
    """Deterministic versionId derived from entity id + chain length.
    Cheap, stable across reloads, and sortable when paired with the
    entity id."""
    return f"{entity_id}:{ordinal}"


def normalize_raw(raw: dict) -> dict:
    """Normalize a raw entity object (from JSONL or DB row) into a live
    entity. Mutates `raw` in place and returns it.

    Mirrors store/entity-normalizer.js `normalizeRaw` step-for-step so the
    Python and JS runtimes produce equivalent entity shapes when fed the
    same JSONL. Drift on this function breaks the v1.7 invariant ("every
    SQLite row was first in JSONL"): same input must yield same SQLite
    rows on either runtime.
    """
    raw["links"] = list(raw.get("links") or [])
    raw["versions"] = raw.get("versions") or []
    raw["type"] = raw.get("type") or "text"
    raw["metadata"] = raw.get("metadata") or {}
    raw["tags"] = raw.get("tags") or []

    version_source = _first_truthy(
        v.get("source") for v in raw["versions"] if isinstance(v, dict)
    )
    version_classification = _first_truthy(
        v.get("classification") for v in raw["versions"] if isinstance(v, dict)
    )
    raw["source"] = raw.get("source") or version_source or {"type": "user"}
    raw["classification"] = normalize_classification(
        raw.get("classification") or version_classification
    )
    raw["retention"] = normalize_retention(raw.get("retention"))

    # Soft-delete fields — default to not-deleted.
    deleted_at = raw.get("deletedAt")
    if deleted_at is not None:
        raw["deletedAt"] = int(deleted_at)
        raw["deletedBy"] = raw.get("deletedBy") or None
    else:
        raw["deletedAt"] = None
        raw["deletedBy"] = None

    # Backfill fields added in later schema versions.
    raw["memoryType"] = normalize_memory_type(raw.get("memoryType"))
    raw["workspaceId"] = normalize_workspace_id(raw.get("workspaceId"))
    if not isinstance(raw.get("llmKeywords"), list):
        raw["llmKeywords"] = (
            (raw.get("metadata") or {}).get("llm", {}).get("keywords") or []
        )
    if "importance" not in raw:
        raw["importance"] = None
    if "trustScore" not in raw:
        source_type = (raw.get("source") or {}).get("type") or "user"
        raw["trustScore"] = default_trust_score(source_type)

    # Per-version metadata backfill.
    for v in raw["versions"]:
        if not v.get("source"):
            v["source"] = raw["source"]
    for v in raw["versions"]:
        v["classification"] = normalize_classification(
            v.get("classification") or raw["classification"]
        )
        if not isinstance(v.get("linkIds"), list):
            v["linkIds"] = []

    # Migrate old data: if versions are oldest-first, reverse to newest-first.
    if (
        len(raw["versions"]) > 1
        and raw["versions"][0].get("timestamp", 0)
        < raw["versions"][-1].get("timestamp", 0)
    ):
        raw["versions"].reverse()

    # Lazy back-compat: synthesise audit fields on legacy version records
    # written before the trail shape existed. Walk oldest-first so
    # previousVersionId chains correctly. New writes already carry these;
    # we only fill what's missing.
    if raw["versions"]:
        oldest_first = list(reversed(raw["versions"]))
        prev_version_id = None
        for i, v in enumerate(oldest_first):
            if not v.get("versionId"):
                v["versionId"] = make_version_id(raw["id"], i + 1)
            if v.get("ingestAt") is None:
                v["ingestAt"] = v.get("timestamp")
            if v.get("effectiveAt") is None:
                v["effectiveAt"] = v.get("timestamp")
            if v.get("validFrom") is None:
                v["validFrom"] = v["effectiveAt"]
            if "validTo" not in v:
                # Closed by the next version; the latest stays open until
                # forgotten or soft-deleted.
                if i < len(oldest_first) - 1:
                    nxt = oldest_first[i + 1]
                    v["validTo"] = nxt.get("effectiveAt") or nxt.get("timestamp")
                else:
                    v["validTo"] = None
            if not v.get("previousVersionId"):
                v["previousVersionId"] = prev_version_id
            if "who" not in v:
                v["who"] = None
            if "why" not in v:
                v["why"] = None
            if not v.get("action"):
                v["action"] = synthesize_action(i, v.get("delta"))
            prev_version_id = v["versionId"]

        # If soft-deleted, close the latest version's validTo at deletedAt.
        if raw["deletedAt"] and raw["versions"][0].get("validTo") is None:
            raw["versions"][0]["validTo"] = raw["deletedAt"]

    if not isinstance(raw.get("trailEvents"), list):
        raw["trailEvents"] = []

    return raw


def _first_truthy(it):
    for v in it:
        if v:
            return v
    return None


def _is_finite(x: Any) -> bool:
    """Mirror JS `Number.isFinite`: True only for finite numeric values.
    Python bools subclass int — JS keeps them separate, so reject bools
    explicitly."""
    if isinstance(x, bool):
        return False
    if isinstance(x, (int, float)):
        return not (math.isnan(x) or math.isinf(x))
    return False
