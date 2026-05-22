"""Integration smoke test against the real Anthropic API — Phase 2.6.

Skipped automatically unless `ANTHROPIC_API_KEY` is set in the
environment, so CI without a secret (the current state) doesn't spend
tokens or break on missing creds. Run locally with:

    cd python
    export ANTHROPIC_API_KEY=sk-ant-...
    pytest tests/test_integration.py -v

The test exercises the full spine — `LLMLoop` against real Anthropic
calls, with `Tool` / `Agent` / `Run` / `Ledger` underneath. A failure
here means the wiring drifted in a way no unit test caught.
"""

import os

import pytest

from kalairos import Agent, Ledger, LLMLoop, tool


pytestmark = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set — opt-in integration test",
)


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


def test_real_anthropic_add_tool_round_trip(ledger):
    """LLM is asked a math question whose answer requires the add tool.
    We assert the run completed, the add tool was actually invoked, and
    the final result mentions the correct sum. The model's exact
    phrasing isn't pinned — we just check it produced something coherent.
    """

    @tool(
        description="Add two integers and return their sum.",
        parameters={
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
            "required": ["a", "b"],
        },
    )
    def add(a: int, b: int) -> int:
        return a + b

    agent = Agent(
        name="math-helper",
        instructions=(
            "You are a precise math assistant. Use the add tool when "
            "asked to add integers. Answer in one short sentence."
        ),
        tools=[add],
    )

    loop = LLMLoop(model="claude-sonnet-4-5", max_iterations=4)
    run = loop.run(
        agent, ledger, user_message="What is 137 plus 248?"
    )

    assert run.status == "completed", f"run failed: {run.error!r}"
    # The model is expected to invoke the add tool at least once.
    rows = ledger.appender.load_raw()
    tool_calls = [
        r
        for r in rows
        if (r.get("metadata") or {}).get("event_type") == "tool_call_result"
    ]
    assert tool_calls, "model never called the add tool"
    # Correct sum (385) should appear somewhere in the result text.
    assert "385" in (run.result or ""), (
        f"final result missing the sum: {run.result!r}"
    )
