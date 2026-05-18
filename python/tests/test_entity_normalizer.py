"""Tests for entity_normalizer — port of store/entity-normalizer.js.

Covers each normalize_* helper plus normalize_raw against minimal,
legacy-shaped, and fully-populated inputs.
"""

from kalairos.entity_normalizer import (
    _SOURCE_TRUST_DEFAULTS,
    _VALID_MEMORY_TYPES,
    default_trust_score,
    make_version_id,
    normalize_classification,
    normalize_memory_type,
    normalize_raw,
    normalize_retention,
    normalize_workspace_id,
)
from kalairos.versioning import ACTIONS, is_valid_action, synthesize_action


# ── default_trust_score ────────────────────────────────────────────────────


def test_default_trust_score_known_types():
    assert default_trust_score("user") == 0.90
    assert default_trust_score("agent") == 0.75
    assert default_trust_score("tool") == 0.80
    assert default_trust_score("file") == 0.70
    assert default_trust_score("system") == 0.60


def test_default_trust_score_unknown_falls_back():
    assert default_trust_score("unknown") == 0.70
    assert default_trust_score("") == 0.70
    assert default_trust_score(None) == 0.70


# ── normalize_classification ───────────────────────────────────────────────


def test_normalize_classification_defaults_to_internal():
    assert normalize_classification(None) == "internal"
    assert normalize_classification("") == "internal"
    assert normalize_classification("   ") == "internal"


def test_normalize_classification_canonicalizes():
    assert normalize_classification("Public") == "public"
    assert normalize_classification("  Confidential  ") == "confidential"


def test_normalize_classification_preserves_custom_strings():
    """Caller-defined policy labels survive normalization (lowercased)."""
    assert normalize_classification("hr-only") == "hr-only"
    assert normalize_classification("PII-Locked") == "pii-locked"


# ── normalize_retention ────────────────────────────────────────────────────


def test_normalize_retention_defaults():
    assert normalize_retention(None) == {"policy": "keep", "expiresAt": None}
    assert normalize_retention({}) == {"policy": "keep", "expiresAt": None}
    assert normalize_retention("not a dict") == {"policy": "keep", "expiresAt": None}


def test_normalize_retention_keeps_finite_expires_at():
    r = normalize_retention({"policy": "delete", "expiresAt": 1234567890})
    assert r == {"policy": "delete", "expiresAt": 1234567890}


def test_normalize_retention_drops_non_finite_expires_at():
    assert normalize_retention({"policy": "x", "expiresAt": float("inf")})["expiresAt"] is None
    assert normalize_retention({"policy": "x", "expiresAt": float("nan")})["expiresAt"] is None
    assert normalize_retention({"policy": "x", "expiresAt": "1234"})["expiresAt"] is None


def test_normalize_retention_rejects_bool_expires_at():
    """Python bools subclass int — JS Number.isFinite rejects bools, so
    we should too."""
    assert normalize_retention({"policy": "x", "expiresAt": True})["expiresAt"] is None


# ── normalize_memory_type ──────────────────────────────────────────────────


def test_normalize_memory_type_valid_values():
    for v in ("short-term", "long-term", "working"):
        assert normalize_memory_type(v) == v


def test_normalize_memory_type_invalid_falls_back_to_long_term():
    assert normalize_memory_type("episodic") == "long-term"


def test_normalize_memory_type_defaults_and_canonicalizes():
    assert normalize_memory_type(None) == "long-term"
    assert normalize_memory_type("") == "long-term"
    assert normalize_memory_type("  Working  ") == "working"


# ── normalize_workspace_id ─────────────────────────────────────────────────


def test_normalize_workspace_id_defaults():
    assert normalize_workspace_id(None) == "default"
    assert normalize_workspace_id("") == "default"
    assert normalize_workspace_id("   ") == "default"


def test_normalize_workspace_id_passes_through():
    assert normalize_workspace_id("alpha") == "alpha"
    assert normalize_workspace_id("  alpha-1  ") == "alpha-1"


# ── make_version_id ────────────────────────────────────────────────────────


def test_make_version_id_format():
    assert make_version_id("ent-42", 1) == "ent-42:1"
    assert make_version_id("ent-42", 7) == "ent-42:7"


# ── synthesize_action / is_valid_action ────────────────────────────────────


def test_synthesize_action_first_is_remembered():
    assert synthesize_action(0, None) == ACTIONS["remembered"]
    assert synthesize_action(0, {"type": "correction"}) == ACTIONS["remembered"]


def test_synthesize_action_correction():
    assert synthesize_action(1, {"type": "correction"}) == ACTIONS["corrected"]


def test_synthesize_action_consolidation_and_default():
    assert synthesize_action(1, {"type": "consolidation"}) == ACTIONS["superseded"]
    assert synthesize_action(1, None) == ACTIONS["superseded"]
    assert synthesize_action(1, {"type": "other"}) == ACTIONS["superseded"]


def test_is_valid_action():
    for v in ACTIONS.values():
        assert is_valid_action(v)
    assert not is_valid_action("nope")
    assert not is_valid_action(None)
    assert not is_valid_action(42)


# ── normalize_raw ──────────────────────────────────────────────────────────


def test_normalize_raw_fills_minimal_entity():
    """An entity with only id + text comes out with all defaults populated."""
    raw = {"id": "ent-1", "text": "hello"}
    out = normalize_raw(raw)
    assert out is raw  # mutated in place
    assert out["links"] == []
    assert out["versions"] == []
    assert out["type"] == "text"
    assert out["metadata"] == {}
    assert out["tags"] == []
    assert out["classification"] == "internal"
    assert out["retention"] == {"policy": "keep", "expiresAt": None}
    assert out["memoryType"] == "long-term"
    assert out["workspaceId"] == "default"
    assert out["importance"] is None
    assert out["trustScore"] == 0.90  # default for source {"type": "user"}
    assert out["deletedAt"] is None
    assert out["deletedBy"] is None
    assert out["llmKeywords"] == []
    assert out["trailEvents"] == []


def test_normalize_raw_preserves_explicit_fields():
    raw = {
        "id": "ent-2",
        "text": "x",
        "memoryType": "working",
        "workspaceId": "alpha",
        "trustScore": 0.42,
        "importance": 5,
        "tags": ["a", "b"],
    }
    out = normalize_raw(raw)
    assert out["memoryType"] == "working"
    assert out["workspaceId"] == "alpha"
    assert out["trustScore"] == 0.42
    assert out["importance"] == 5
    assert out["tags"] == ["a", "b"]


def test_normalize_raw_links_become_list():
    raw = {"id": "x", "text": "x", "links": ["a", "b", "c"]}
    out = normalize_raw(raw)
    assert out["links"] == ["a", "b", "c"]


def test_normalize_raw_soft_delete_fields():
    raw = {"id": "x", "text": "x", "deletedAt": 1234, "deletedBy": "user-1"}
    out = normalize_raw(raw)
    assert out["deletedAt"] == 1234
    assert out["deletedBy"] == "user-1"


def test_normalize_raw_default_trust_from_source():
    """trustScore default depends on source.type."""
    raw = {"id": "x", "text": "x", "source": {"type": "agent"}}
    out = normalize_raw(raw)
    assert out["trustScore"] == 0.75


def test_normalize_raw_legacy_versions_oldest_first_get_reversed():
    """JSONL with versions sorted oldest→newest must be flipped to
    newest-first to match the in-memory invariant."""
    raw = {
        "id": "ent",
        "text": "v3",
        "versions": [
            {"timestamp": 100, "text": "v1"},
            {"timestamp": 200, "text": "v2"},
            {"timestamp": 300, "text": "v3"},
        ],
    }
    out = normalize_raw(raw)
    assert [v["timestamp"] for v in out["versions"]] == [300, 200, 100]


def test_normalize_raw_synthesises_audit_fields():
    """Legacy versions missing audit fields get them filled deterministically."""
    raw = {
        "id": "ent",
        "text": "v2",
        "versions": [
            {"timestamp": 200, "text": "v2"},  # newest-first
            {"timestamp": 100, "text": "v1"},
        ],
    }
    out = normalize_raw(raw)
    v_new, v_old = out["versions"][0], out["versions"][1]
    assert v_old["versionId"] == "ent:1"
    assert v_new["versionId"] == "ent:2"
    assert v_old["ingestAt"] == 100
    assert v_old["effectiveAt"] == 100
    assert v_old["validFrom"] == 100
    # validTo: oldest closes at next version's effectiveAt; newest is open.
    assert v_old["validTo"] == 200
    assert v_new["validTo"] is None
    assert v_old["previousVersionId"] is None
    assert v_new["previousVersionId"] == "ent:1"
    assert v_old["who"] is None and v_old["why"] is None
    assert v_old["action"] == ACTIONS["remembered"]
    assert v_new["action"] == ACTIONS["superseded"]


def test_normalize_raw_soft_delete_closes_latest_version():
    raw = {
        "id": "ent",
        "text": "v1",
        "deletedAt": 999,
        "versions": [{"timestamp": 100, "text": "v1"}],
    }
    out = normalize_raw(raw)
    assert out["versions"][0]["validTo"] == 999


def test_normalize_raw_per_version_classification_inherits():
    raw = {
        "id": "ent",
        "text": "x",
        "classification": "Confidential",
        "versions": [{"timestamp": 1, "text": "x"}],
    }
    out = normalize_raw(raw)
    assert out["classification"] == "confidential"
    assert out["versions"][0]["classification"] == "confidential"


def test_normalize_raw_llm_keywords_from_metadata():
    raw = {
        "id": "ent",
        "text": "x",
        "metadata": {"llm": {"keywords": ["alpha", "beta"]}},
    }
    out = normalize_raw(raw)
    assert out["llmKeywords"] == ["alpha", "beta"]


def test_normalize_raw_preserves_existing_audit_fields():
    """If a version already carries audit fields, normalize must not
    overwrite them."""
    raw = {
        "id": "ent",
        "text": "v1",
        "versions": [
            {
                "timestamp": 100,
                "text": "v1",
                "versionId": "custom-id",
                "action": "imported",
                "who": "alice",
                "why": "bulk import",
                "ingestAt": 50,
                "effectiveAt": 75,
                "validFrom": 75,
                "validTo": 200,
                "previousVersionId": "prev",
            }
        ],
    }
    out = normalize_raw(raw)
    v = out["versions"][0]
    assert v["versionId"] == "custom-id"
    assert v["action"] == "imported"
    assert v["who"] == "alice"
    assert v["why"] == "bulk import"
    assert v["ingestAt"] == 50
    assert v["effectiveAt"] == 75
    assert v["validFrom"] == 75
    assert v["validTo"] == 200
    assert v["previousVersionId"] == "prev"


def test_normalize_raw_idempotent():
    """Running normalize_raw twice on the same dict must produce the same
    result — important when the same JSONL row is replayed during a
    rebuild or replay-forward."""
    raw = {"id": "ent", "text": "x", "versions": [{"timestamp": 1, "text": "x"}]}
    once = normalize_raw(raw)
    snapshot = dict(once)
    snapshot["versions"] = [dict(v) for v in once["versions"]]
    twice = normalize_raw(once)
    assert twice["versions"][0]["versionId"] == snapshot["versions"][0]["versionId"]
    assert twice["versions"][0]["action"] == snapshot["versions"][0]["action"]
    assert twice["trustScore"] == snapshot["trustScore"]
