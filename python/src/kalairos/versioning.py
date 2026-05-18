"""Audit-trail action vocabulary — minimal port of versioning.js.

Only the bits needed by entity_normalizer (the rebuild_from path) for
now. Full versioning logic (buildDelta, classifyContradiction, etc.)
lives in JS and ports later when the Python live-write path needs it.
"""

from __future__ import annotations

import types

# Closed enum of trail-event actions. Every version record and every
# metadata-only trail event records exactly one of these. Keeping this
# set small and closed is what makes the trail auditable — readers can
# switch on it without guessing.
ACTIONS = types.MappingProxyType(
    {
        "remembered": "remembered",
        "superseded": "superseded",
        "corrected":  "corrected",
        "contested":  "contested",
        "reaffirmed": "reaffirmed",
        "forgotten":  "forgotten",
        "restored":   "restored",
        "imported":   "imported",
        "annotated":  "annotated",
    }
)

ACTION_SET = frozenset(ACTIONS.values())


def is_valid_action(action) -> bool:
    return isinstance(action, str) and action in ACTION_SET


def synthesize_action(version_idx: int, delta) -> str:
    """Synthesize an action for a legacy version record predating the
    `action` field. Driven entirely by position in the version chain and
    delta type so the result is deterministic across reloads.
    """
    if version_idx == 0:
        return ACTIONS["remembered"]
    t = delta.get("type") if isinstance(delta, dict) else None
    if t == "correction":
        return ACTIONS["corrected"]
    if t == "consolidation":
        return ACTIONS["superseded"]
    return ACTIONS["superseded"]
