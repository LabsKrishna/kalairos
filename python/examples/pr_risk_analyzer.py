"""PR risk analyzer demo — reads a real GitHub PR and prints a risk
summary plus the full event trail.

Run it:

    cd python
    pip install -e ".[llm]"
    export ANTHROPIC_API_KEY=sk-ant-...
    gh auth login                       # if not already
    python examples/pr_risk_analyzer.py 24

The agent uses the `gh` CLI to fetch the PR's file list, classifies the
files (critical / doc / test), deep-scans the critical ones, and prints
a verdict. Every step lands in the Ledger so the analysis is
replayable — Phase 4's control plane will visualize this trail.

Dogfood: run it on Kalairos's own PRs.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from kalairos import Ledger, LLMLoop
from kalairos.agents.pr_risk import build_pr_risk_agent


def main(pr_number: int, *, model: str = "claude-sonnet-4-5") -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. Export it and re-run.",
            file=sys.stderr,
        )
        sys.exit(1)

    workdir = Path(tempfile.mkdtemp(prefix="kalairos-pr-risk-"))
    jsonl = workdir / "ledger.jsonl"
    sqlite = workdir / "index.sqlite"
    print(f"PR:      #{pr_number}")
    print(f"ledger:  {jsonl}")
    print(f"sqlite:  {sqlite}")
    print(f"model:   {model}\n")

    agent = build_pr_risk_agent()
    with Ledger(jsonl, sqlite) as ledger:
        loop = LLMLoop(model=model, max_iterations=12)
        run = loop.run(
            agent, ledger, user_message=f"Review PR #{pr_number}."
        )

        if run.status != "completed":
            print(f"Run failed: {run.error}", file=sys.stderr)
            sys.exit(1)

        print("─" * 72)
        print(run.result)
        print("─" * 72)
        print("\ntrail:")
        for rec in ledger.appender.load_raw():
            md = rec.get("metadata") or {}
            event_type = md.get("event_type")
            if not event_type:
                continue
            seq = md.get("seq")
            payload = md.get("payload") or {}
            print(f"  [{seq:>3}] {event_type:<24} {_summary(event_type, payload)}")


def _summary(event_type: str, payload: dict) -> str:
    if event_type == "tool_call_requested":
        return f"{payload.get('tool')}({_kwargs_str(payload.get('input', {}))})"
    if event_type == "tool_call_result":
        result = payload.get("result")
        text = str(result)
        return f"{payload.get('tool')} -> {text[:80]}{'...' if len(text) > 80 else ''}"
    if event_type == "tool_call_failed":
        return f"{payload.get('tool')} !! {payload.get('error')}"
    if event_type == "llm_response":
        usage = payload.get("usage") or {}
        parts = [
            f"stop={payload.get('stop_reason')}",
            f"in:{usage.get('input_tokens')}",
            f"out:{usage.get('output_tokens')}",
        ]
        if usage.get("cache_read_input_tokens"):
            parts.append(f"cached:{usage.get('cache_read_input_tokens')}")
        return " ".join(parts)
    if event_type == "llm_text":
        text = payload.get("text", "")
        return repr(text if len(text) <= 80 else text[:77] + "...")
    if event_type == "run_failed":
        return f"!! {payload.get('error')}"
    return json.dumps(payload, separators=(",", ":"))[:120]


def _kwargs_str(kwargs: dict) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in kwargs.items())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: pr_risk_analyzer.py <pr_number>", file=sys.stderr)
        sys.exit(2)
    main(int(sys.argv[1]))
