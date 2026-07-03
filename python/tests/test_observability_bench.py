"""CI gate for the observability benchmark (CLAUDE.md §17).

Two things must hold for the benchmark to be a real gate:

  1. On the reference workload the platform must score the published
     floors exactly (completeness == 1.0, trace coverage == 1.0). Any
     drop is a silent-execution regression (§11.7).

  2. The metric must be *sensitive* — it has to be able to fall below
     the floor. We prove that by dropping events from a healthy trail
     and confirming both metrics drop. A benchmark that always reads
     1.0 would gate nothing.

The benchmark also exercises the real cross-runtime handoff path (§11.8:
caller, callee, payload, outcome), so this doubles as an integration
test of the control plane's read functions over a populated ledger.
"""

import sys
from pathlib import Path

# Make `bench/observability.py` importable (it lives outside src/).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bench"))

from observability import (  # noqa: E402
    FLOOR_COMPLETENESS,
    FLOOR_TRACE_COVERAGE,
    present_actions,
    run_benchmark,
    trace_coverage,
)


def test_reference_workload_meets_floors(tmp_path):
    res = run_benchmark(tmp_path)
    assert res.completeness == FLOOR_COMPLETENESS, res.missing
    assert res.coverage == FLOOR_TRACE_COVERAGE
    # No action should be silently missing on a healthy run.
    assert res.missing == []


def test_handoff_path_is_exercised(tmp_path):
    """Guard against the trace-coverage metric being vacuously 1.0 because
    no handoff ever ran."""
    res = run_benchmark(tmp_path)
    assert res.handoffs_total >= 1
    assert res.handoffs_covered == res.handoffs_total


def test_completeness_is_sensitive_to_dropped_events():
    """A silent gap must lower completeness — model the gap by removing a
    tool's result event from a healthy trail and recomputing."""
    healthy = [
        {"event_type": "run_started", "payload": {}},
        {"event_type": "tool_call_requested", "payload": {"tool": "fetch_pr"}},
        {"event_type": "tool_call_result", "payload": {"tool": "fetch_pr"}},
        {"event_type": "run_completed", "payload": {}},
    ]
    expected = {"lifecycle:start", "lifecycle:end", "tool:fetch_pr"}

    full = present_actions(healthy)
    assert expected <= full
    assert len(expected & full) / len(expected) == 1.0

    # Drop the tool's result — the request landed but the outcome didn't.
    gapped = [e for e in healthy if e["event_type"] != "tool_call_result"]
    partial = present_actions(gapped)
    assert "tool:fetch_pr" not in partial
    assert len(expected & partial) / len(expected) < FLOOR_COMPLETENESS


def test_trace_coverage_is_sensitive_to_missing_outcome():
    """A handoff with a request but no completion/failure must NOT count as
    covered — that's exactly the silent-handoff case §11.8 guards against."""
    requested_only = [
        {"event_type": "handoff_requested",
         "payload": {"handoff_id": "ho_1", "service": "node-dep-graph", "input": {}}},
    ]
    covered, total = trace_coverage(requested_only)
    assert total == 1
    assert covered == 0

    completed = requested_only + [
        {"event_type": "handoff_completed",
         "payload": {"handoff_id": "ho_1", "service": "node-dep-graph", "result": {}}},
    ]
    covered, total = trace_coverage(completed)
    assert (covered, total) == (1, 1)


def test_trace_coverage_requires_payload_and_callee():
    """Missing callee or payload also breaks reconstruction (§11.8)."""
    no_callee = [
        {"event_type": "handoff_requested",
         "payload": {"handoff_id": "ho_2", "service": "", "input": {}}},
        {"event_type": "handoff_completed",
         "payload": {"handoff_id": "ho_2", "result": {}}},
    ]
    assert trace_coverage(no_callee) == (0, 1)

    no_payload = [
        {"event_type": "handoff_requested",
         "payload": {"handoff_id": "ho_3", "service": "node-dep-graph"}},
        {"event_type": "handoff_completed",
         "payload": {"handoff_id": "ho_3", "result": {}}},
    ]
    assert trace_coverage(no_payload) == (0, 1)
