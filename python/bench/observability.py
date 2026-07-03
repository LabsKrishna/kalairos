"""Observability benchmark — the platform half of §17's eval discipline.

CLAUDE.md §17 names two *platform* benchmarks that must run on every PR,
alongside the memory benchmarks:

  - **Observability completeness** — the fraction of agent actions that
    are visible in the control plane. §11.7 promises "No silent
    execution": every tool call, node transition, branch decision, and
    handoff the runtime takes must surface as a ledger event the control
    plane can read back.
  - **Cross-agent trace coverage** — the fraction of handoffs that are
    reconstructible end-to-end from the ledger alone. §11.8 spells out
    what "end-to-end" means: caller, callee, payload, outcome.

Until now neither number existed, even though §17's regression gate and
§25's success criteria both reference floors for them. This file makes
them real, reproducible, and CI-gateable — the same shape as
`bench/latency.js`: drive a deterministic workload, measure, print a
table, persist JSON, and (with --check) assert the published floor.

Determinism: no real LLM, no network. The reference workload is an
Executor walking a fixed WorkflowGraph (the same shape as the Phase 3
PR-risk analyzer) plus a hand-driven failing run. The cross-runtime
handoff is answered by an in-process auto-reply thread that mimics what
a Node service POSTing to LedgerServer would do — so the handoff path,
including its end-to-end trace, is exercised for real.

How completeness is computed honestly (not circularly): the *expected*
set of observable actions is derived from the workflow graph topology
plus a declared execution path — i.e. from the workload's definition,
NOT from the run-event records. The *present* set is derived from what
the control plane (`events_for_run`) actually surfaces. Completeness is
|present ∩ expected| / |expected|. A healthy platform scores 1.0; drop
any event and the score falls below the floor (see the sensitivity
check in test_observability_bench.py).

Run it yourself:

    python bench/observability.py
    python bench/observability.py --check     # assert floors, exit 1 on miss
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable

# Allow `python bench/observability.py` from the python/ dir without an
# install — mirror the pythonpath=["src"] pytest config.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from kalairos import (  # noqa: E402
    Agent,
    BranchNode,
    Executor,
    HandoffNode,
    Ledger,
    StepNode,
    WorkflowGraph,
    tool,
)
from kalairos.control_plane import events_for_run  # noqa: E402
from kalairos.executor import (  # noqa: E402
    EVENT_HANDOFF_REQUESTED,
    EVENT_HANDOFF_RESULT,
)

# ── Published floors (referenced by §17's regression gate) ──────────────────
#
# On the reference workload the platform emits every action it takes, so
# the floor is 1.0 — anything below it is a silent-execution bug, not a
# tuning knob. §25's "observability completeness ≥ 95%" is a *customer
# workload* target (the customer's own agent code may do un-instrumented
# work the platform never sees); our own reference fixture must be exact.
FLOOR_COMPLETENESS = 1.0
FLOOR_TRACE_COVERAGE = 1.0


# ── Canonical action accounting ─────────────────────────────────────────────
#
# An "observable action" is keyed by a stable string so the expected set
# (derived from the graph) and the present set (derived from the ledger)
# are directly comparable.


def present_actions(events: list[dict]) -> set[str]:
    """Derive the set of observable actions the control plane actually
    surfaces for one run, from its event list (`events_for_run`)."""
    actions: set[str] = set()
    tool_requested: set[str] = set()
    tool_terminal: set[str] = set()
    handoff_requested: dict[str, str] = {}   # handoff_id -> service
    handoff_terminal: set[str] = set()       # handoff_ids with completed|failed

    for ev in events:
        et = ev.get("event_type")
        p = ev.get("payload") or {}
        if et == "run_started":
            actions.add("lifecycle:start")
        elif et in ("run_completed", "run_failed"):
            actions.add("lifecycle:end")
        elif et == "graph_defined":
            actions.add("graph_defined")
        elif et == "node_entered":
            actions.add(f"node_entered:{p.get('node')}")
        elif et == "node_completed":
            actions.add(f"node_completed:{p.get('node')}")
        elif et == "branch_chosen":
            actions.add(f"branch:{p.get('node')}")
        elif et == "tool_call_requested":
            tool_requested.add(p.get("tool"))
        elif et in ("tool_call_result", "tool_call_failed"):
            tool_terminal.add(p.get("tool"))
        elif et == "handoff_requested":
            handoff_requested[p.get("handoff_id")] = p.get("service")
        elif et in ("handoff_completed", "handoff_failed"):
            handoff_terminal.add(p.get("handoff_id"))

    # A tool call is observable only if BOTH its request and its outcome
    # surfaced — a request with no result is a silent gap.
    for t in tool_requested & tool_terminal:
        actions.add(f"tool:{t}")
    # A handoff is observable only if request + outcome both surfaced.
    for hid, service in handoff_requested.items():
        if hid in handoff_terminal:
            actions.add(f"handoff:{service}")
    return actions


def expected_actions_from_graph(
    graph: WorkflowGraph, path: list[str], *, terminal: str = "completed"
) -> set[str]:
    """Compute the observable actions an Executor run *should* surface,
    from the graph topology + the declared execution path. Independent
    of the ledger — this is the honest denominator."""
    expected = {"lifecycle:start", "graph_defined", "lifecycle:end"}
    for name in path:
        node = graph.get(name)
        expected.add(f"node_entered:{name}")
        expected.add(f"node_completed:{name}")
        if isinstance(node, StepNode) and node.tool is not None:
            expected.add(f"tool:{node.tool}")
        elif isinstance(node, BranchNode):
            expected.add(f"branch:{name}")
        elif isinstance(node, HandoffNode):
            expected.add(f"handoff:{node.service}")
    return expected


# ── Cross-agent trace coverage ──────────────────────────────────────────────


def trace_coverage(events: list[dict]) -> tuple[int, int]:
    """Return (covered_handoffs, total_handoffs) for one run.

    A handoff is "covered" iff the ledger alone reconstructs all four of
    §11.8's fields:
      - caller   — the run/agent that emitted handoff_requested
      - callee   — payload.service
      - payload  — payload.input present
      - outcome  — a matching handoff_completed (result) or
                   handoff_failed (error)
    """
    requested: dict[str, dict] = {}
    terminal: dict[str, dict] = {}
    for ev in events:
        et = ev.get("event_type")
        p = ev.get("payload") or {}
        hid = p.get("handoff_id")
        if et == "handoff_requested":
            requested[hid] = p
        elif et in ("handoff_completed", "handoff_failed"):
            terminal[hid] = {"event": et, "payload": p}

    total = len(requested)
    covered = 0
    for hid, req in requested.items():
        has_callee = bool(req.get("service"))
        has_payload = "input" in req
        term = terminal.get(hid)
        has_outcome = term is not None and (
            "result" in term["payload"] or "error" in term["payload"]
        )
        if has_callee and has_payload and has_outcome:
            covered += 1
    return covered, total


# ── Reference workloads ─────────────────────────────────────────────────────


def _auto_reply(
    ledger: Ledger, *, result: Any = None, error: str | None = None
) -> Callable[[], None]:
    """In-process stand-in for a Node service: on each handoff_requested,
    append the matching handoff_result from a background thread (the same
    shape a real service POSTing to LedgerServer produces). The thread is
    required — appending synchronously inside the subscriber would re-enter
    the write path on the thread the executor is blocked on."""

    def listener(record: dict) -> None:
        md = record.get("metadata") or {}
        if md.get("event_type") != EVENT_HANDOFF_REQUESTED:
            return
        handoff_id = md["payload"]["handoff_id"]

        def reply() -> None:
            ts = int(time.time() * 1000)
            payload = {"handoff_id": handoff_id, "result": result, "error": error}
            ledger.append(
                {
                    "id": f"handoff/{handoff_id}/result",
                    "text": json.dumps(payload, separators=(",", ":")),
                    "type": "handoff-event",
                    "memoryType": "long-term",
                    "workspaceId": "agent-runs",
                    "tags": ["handoff-event", EVENT_HANDOFF_RESULT, f"handoff:{handoff_id}"],
                    "versions": [{"timestamp": ts, "text": payload["handoff_id"], "ingestAt": ts}],
                    "metadata": {"event_type": EVENT_HANDOFF_RESULT, "payload": payload},
                }
            )

        threading.Thread(target=reply, daemon=True).start()

    return ledger.subscribe(listener)


def _pr_risk_graph() -> WorkflowGraph:
    """The same shape as the Phase 3 PR-risk analyzer: fetch → assess →
    route → (deep: handoff to the Node dep-graph builder) → summarize.
    The branch condition routes deterministically to the deep path so the
    handoff (and its trace) is exercised every run."""
    g = WorkflowGraph("pr-risk-analyzer")
    g.add(StepNode(name="fetch", tool="fetch_pr",
                   inputs=lambda s: {"pr_id": s["pr_id"]},
                   output_key="pr", next="assess"))
    g.add(StepNode(name="assess", think="evaluating change size", next="route"))
    g.add(BranchNode(name="route", condition=lambda s: "deep",
                     branches={"deep": "depgraph", "shallow": "summarize"}))
    g.add(HandoffNode(name="depgraph", service="node-dep-graph",
                      inputs=lambda s: {"files": s["pr"]["files"]},
                      output_key="deps", timeout=5.0, next="summarize"))
    g.add(StepNode(name="summarize", tool="write_summary",
                   inputs=lambda s: {"pr": s["pr"]}, next=None))
    g.set_start("fetch")
    g.validate()
    return g


# Declared execution path for the deterministic branch above.
_PR_RISK_PATH = ["fetch", "assess", "route", "depgraph", "summarize"]


def _pr_risk_agent() -> Agent:
    @tool(description="Fetch PR metadata",
          parameters={"type": "object",
                      "properties": {"pr_id": {"type": "integer"}},
                      "required": ["pr_id"]})
    def fetch_pr(pr_id: int) -> dict:
        return {"files": 3, "pr_id": pr_id}

    @tool(description="Write a risk summary",
          parameters={"type": "object",
                      "properties": {"pr": {"type": "object"}},
                      "required": ["pr"]})
    def write_summary(pr: dict) -> str:
        return f"summary for PR {pr.get('pr_id')}"

    return Agent(name="pr-risk-analyzer", instructions="assess PR risk",
                 tools=[fetch_pr, write_summary])


def _run_executor_workload(ledger: Ledger) -> tuple[str, set[str]]:
    """Drive the PR-risk graph end to end and return (run_id, expected)."""
    graph = _pr_risk_graph()
    agent = _pr_risk_agent()
    unsub = _auto_reply(ledger, result={"depth": 2, "cycles": 0})
    try:
        run, _state = Executor(graph).run(agent, ledger, initial_state={"pr_id": 28})
    finally:
        unsub()
    expected = expected_actions_from_graph(graph, _PR_RISK_PATH)
    return run.run_id, expected


def _run_failure_workload(ledger: Ledger) -> tuple[str, set[str]]:
    """A hand-driven run whose tool raises — proves failures aren't silent:
    the request, the failure, and the failed lifecycle all surface."""
    from kalairos.run import Run

    @tool(description="Always fails",
          parameters={"type": "object", "properties": {}, "required": []})
    def boom() -> str:
        raise RuntimeError("kaboom")

    agent = Agent(name="flaky-agent", instructions="break", tools=[boom])
    run = Run(agent, ledger, goal="trigger a failure")
    run.start()
    try:
        run.call_tool("boom")
    except Exception:
        pass
    run.fail("tool boom failed")
    expected = {"lifecycle:start", "lifecycle:end", "tool:boom"}
    return run.run_id, expected


# ── Benchmark driver ────────────────────────────────────────────────────────


@dataclass
class Result:
    expected_total: int = 0
    present_total: int = 0
    missing: list[str] = field(default_factory=list)
    handoffs_total: int = 0
    handoffs_covered: int = 0
    per_run: list[dict] = field(default_factory=list)

    @property
    def completeness(self) -> float:
        return 1.0 if self.expected_total == 0 else self.present_total / self.expected_total

    @property
    def coverage(self) -> float:
        return 1.0 if self.handoffs_total == 0 else self.handoffs_covered / self.handoffs_total


def run_benchmark(workdir: Path) -> Result:
    """Run the reference workloads against a fresh ledger and measure."""
    ledger = Ledger(workdir / "ledger.jsonl", workdir / "index.sqlite")
    ledger.open()
    res = Result()
    try:
        workloads = [
            ("executor:pr-risk", _run_executor_workload(ledger)),
            ("agent:tool-failure", _run_failure_workload(ledger)),
        ]
        for label, (run_id, expected) in workloads:
            events = events_for_run(ledger, run_id)
            present = present_actions(events)
            matched = expected & present
            missing = sorted(expected - present)
            covered, total = trace_coverage(events)

            res.expected_total += len(expected)
            res.present_total += len(matched)
            res.missing.extend(f"{label}: {m}" for m in missing)
            res.handoffs_total += total
            res.handoffs_covered += covered
            res.per_run.append({
                "workload": label,
                "run_id": run_id,
                "expected": len(expected),
                "present": len(matched),
                "missing": missing,
                "handoffs_total": total,
                "handoffs_covered": covered,
            })
    finally:
        ledger.close()
    return res


def _print_table(res: Result) -> None:
    print("\nKalairos — Observability Benchmark")
    print("=" * 60)
    print(f"{'workload':<22}{'actions':>12}{'handoffs':>14}")
    print("-" * 60)
    for r in res.per_run:
        acts = f"{r['present']}/{r['expected']}"
        hos = f"{r['handoffs_covered']}/{r['handoffs_total']}" if r["handoffs_total"] else "—"
        print(f"{r['workload']:<22}{acts:>12}{hos:>14}")
    print("-" * 60)
    total_acts = f"{res.present_total}/{res.expected_total}"
    total_hos = f"{res.handoffs_covered}/{res.handoffs_total}"
    print(f"{'TOTAL':<22}{total_acts:>12}{total_hos:>14}")
    print()
    print(f"  observability completeness : {res.completeness:.3f}  "
          f"(floor {FLOOR_COMPLETENESS:.2f})")
    print(f"  cross-agent trace coverage : {res.coverage:.3f}  "
          f"(floor {FLOOR_TRACE_COVERAGE:.2f})")
    if res.missing:
        print("\n  missing (silent) actions:")
        for m in res.missing:
            print(f"    - {m}")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="Kalairos observability benchmark")
    ap.add_argument("--check", action="store_true",
                    help="assert published floors; exit 1 on a miss (CI gate)")
    ap.add_argument("--json", type=Path, default=None,
                    help="also write results JSON to this path")
    args = ap.parse_args()

    with TemporaryDirectory() as td:
        res = run_benchmark(Path(td))

    _print_table(res)

    out = {
        "completeness": res.completeness,
        "trace_coverage": res.coverage,
        "floor_completeness": FLOOR_COMPLETENESS,
        "floor_trace_coverage": FLOOR_TRACE_COVERAGE,
        "expected_total": res.expected_total,
        "present_total": res.present_total,
        "handoffs_total": res.handoffs_total,
        "handoffs_covered": res.handoffs_covered,
        "per_run": res.per_run,
    }
    default_json = Path(__file__).resolve().parent / "observability-results.json"
    (args.json or default_json).write_text(json.dumps(out, indent=2) + "\n")

    if args.check:
        ok = True
        if res.completeness < FLOOR_COMPLETENESS:
            print(f"FAIL: completeness {res.completeness:.3f} < floor {FLOOR_COMPLETENESS:.2f}")
            ok = False
        if res.coverage < FLOOR_TRACE_COVERAGE:
            print(f"FAIL: trace coverage {res.coverage:.3f} < floor {FLOOR_TRACE_COVERAGE:.2f}")
            ok = False
        if not ok:
            return 1
        print("PASS: observability floors met.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
