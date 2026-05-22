"""hello_agent — the canonical end-to-end wiring of the kalairos agent
spine, demonstrated on a trivial math agent.

Run it:

    cd python
    pip install -e ".[llm]"
    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/hello_agent.py

What it does:
- Defines two tools (`add`, `multiply`).
- Builds an `Agent` with those tools and a short instruction.
- Opens a `Ledger` on a fresh JSONL+SQLite pair in `/tmp`.
- Runs the `LLMLoop` against a user message that needs both tools.
- Prints the result and a per-event summary of the trail.

Every step the agent takes — LLM request, tool call, result, finish —
lands as a record in the ledger. The whole flow is replayable from the
JSONL alone, which is what the control plane (Phase 4) will eventually
visualize.

Phase 2.6 — proves the spine end-to-end before the PR risk analyzer
(Phase 3) layers a real job on top.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from kalairos import Agent, Ledger, LLMLoop, tool


# ── Tools ──────────────────────────────────────────────────────────────────


@tool(
    description="Add two integers and return their sum.",
    parameters={
        "type": "object",
        "properties": {
            "a": {"type": "integer", "description": "First addend"},
            "b": {"type": "integer", "description": "Second addend"},
        },
        "required": ["a", "b"],
    },
)
def add(a: int, b: int) -> int:
    return a + b


@tool(
    description="Multiply two integers and return their product.",
    parameters={
        "type": "object",
        "properties": {
            "a": {"type": "integer", "description": "First factor"},
            "b": {"type": "integer", "description": "Second factor"},
        },
        "required": ["a", "b"],
    },
)
def multiply(a: int, b: int) -> int:
    return a * b


# ── Run ────────────────────────────────────────────────────────────────────


def run_hello_agent(
    user_message: str = "Compute (3 + 4) * 5 step by step.",
    *,
    model: str = "claude-sonnet-4-5",
) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. Export it and re-run.\n"
            "  export ANTHROPIC_API_KEY=sk-ant-...",
            file=sys.stderr,
        )
        sys.exit(1)

    agent = Agent(
        name="hello-math",
        instructions=(
            "You are a precise math assistant. Use the provided tools "
            "to compute step by step. When done, answer in one sentence."
        ),
        tools=[add, multiply],
    )

    # Fresh paths so this script is self-contained and runnable from
    # anywhere without leaving state on the user's disk.
    workdir = Path(tempfile.mkdtemp(prefix="kalairos-hello-"))
    jsonl = workdir / "ledger.jsonl"
    sqlite = workdir / "index.sqlite"
    print(f"ledger:  {jsonl}")
    print(f"sqlite:  {sqlite}")
    print(f"model:   {model}")
    print(f"prompt:  {user_message}\n")

    with Ledger(jsonl, sqlite) as ledger:
        loop = LLMLoop(model=model, max_iterations=8)
        run = loop.run(agent, ledger, user_message=user_message)

        print(f"status:  {run.status}")
        print(f"result:  {run.result!r}\n")

        print("trail:")
        for rec in ledger.appender.load_raw():
            md = rec.get("metadata") or {}
            if not md.get("event_type"):
                continue
            seq = md.get("seq")
            event_type = md.get("event_type")
            payload = md.get("payload") or {}
            summary = _summarize(event_type, payload)
            print(f"  [{seq:>3}] {event_type:<24} {summary}")


def _summarize(event_type: str, payload: dict) -> str:
    """One-line render of a payload for the trail dump."""
    if event_type == "tool_call_requested":
        return f"{payload.get('tool')}({_kwargs_str(payload.get('input', {}))})"
    if event_type == "tool_call_result":
        return f"{payload.get('tool')} -> {payload.get('result')!r}"
    if event_type == "tool_call_failed":
        return f"{payload.get('tool')} !! {payload.get('error')}"
    if event_type == "thought":
        return repr(payload.get("text"))
    if event_type == "llm_text":
        text = payload.get("text", "")
        clipped = text if len(text) <= 80 else text[:77] + "..."
        return repr(clipped)
    if event_type == "llm_response":
        usage = payload.get("usage") or {}
        return (
            f"stop={payload.get('stop_reason')} "
            f"tokens=in:{usage.get('input_tokens')}/out:{usage.get('output_tokens')}"
            + (
                f"/cached:{usage.get('cache_read_input_tokens')}"
                if usage.get("cache_read_input_tokens")
                else ""
            )
        )
    if event_type == "run_completed":
        return f"-> {payload.get('result')!r}"
    if event_type == "run_failed":
        return f"!! {payload.get('error')}"
    return json.dumps(payload, separators=(",", ":"))


def _kwargs_str(kwargs: dict) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in kwargs.items())


if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else (
        "Compute (3 + 4) * 5 step by step."
    )
    run_hello_agent(user_message=msg)
