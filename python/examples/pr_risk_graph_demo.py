"""Declarative WorkflowGraph version of the PR risk analyzer — Phase 3.2.

Same job as `pr_risk_analyzer.py` but driven by an explicit graph
(StepNode + BranchNode) rather than the autonomous LLMLoop. Useful when
you want deterministic, inspectable flow — e.g., the graph traversal
is identical for every PR with the same classification, and the trail
in the Ledger captures every node entry / exit.

Run it:

    cd python
    pip install -e ".[llm]"
    export ANTHROPIC_API_KEY=sk-ant-...
    gh auth login
    python examples/pr_risk_graph_demo.py 24
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from kalairos import Executor, Ledger
from kalairos.agents.pr_risk import (
    build_pr_risk_graph,
    build_pr_risk_graph_agent,
)


def main(pr_number: int, *, model: str = "claude-sonnet-4-5") -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. Export it and re-run.",
            file=sys.stderr,
        )
        sys.exit(1)

    workdir = Path(tempfile.mkdtemp(prefix="kalairos-pr-risk-graph-"))
    jsonl = workdir / "ledger.jsonl"
    sqlite = workdir / "index.sqlite"
    print(f"PR:      #{pr_number}")
    print(f"ledger:  {jsonl}")
    print(f"sqlite:  {sqlite}\n")

    agent = build_pr_risk_graph_agent(model=model)
    graph = build_pr_risk_graph()

    with Ledger(jsonl, sqlite) as ledger:
        run, state = Executor(graph).run(
            agent,
            ledger,
            initial_state={"pr_number": pr_number},
        )

        if run.status != "completed":
            print(f"Run failed: {run.error}", file=sys.stderr)
            sys.exit(1)

        print("─" * 72)
        print(state.get("verdict", "(no verdict produced)"))
        print("─" * 72)
        print("\ntrail:")
        for rec in ledger.appender.load_raw():
            md = rec.get("metadata") or {}
            event_type = md.get("event_type")
            if not event_type:
                continue
            seq = md.get("seq")
            payload = md.get("payload") or {}
            print(f"  [{seq:>3}] {event_type:<20} {_summary(event_type, payload)}")


def _summary(event_type: str, payload: dict) -> str:
    if event_type == "node_entered":
        return f"→ {payload.get('node')}"
    if event_type == "node_completed":
        return f"✓ {payload.get('node')}"
    if event_type == "branch_chosen":
        return f"{payload.get('node')}: {payload.get('key')!r} → {payload.get('target')}"
    if event_type == "tool_call_requested":
        return f"{payload.get('tool')}(…)"
    if event_type == "tool_call_result":
        result = str(payload.get("result"))
        return f"{payload.get('tool')} → {result[:60]}{'...' if len(result) > 60 else ''}"
    if event_type == "thought":
        return repr(payload.get("text"))
    return json.dumps(payload, separators=(",", ":"))[:80]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: pr_risk_graph_demo.py <pr_number>", file=sys.stderr)
        sys.exit(2)
    main(int(sys.argv[1]))
