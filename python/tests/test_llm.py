"""Tests for LLMLoop — Phase 2.4.

The LLMLoop drives a Run autonomously via Anthropic's messages API.
These tests use a FakeAnthropicClient that scripts a sequence of
responses; the real `anthropic.Anthropic` is only constructed when the
loop is built without an explicit client (and we don't exercise that
path here, since it'd need an API key + network).
"""

import pytest

from kalairos import Agent, LLMLoop, Ledger, tool
from kalairos.llm import (
    DEFAULT_MAX_ITERATIONS,
    EVENT_LLM_REQUEST,
    EVENT_LLM_RESPONSE,
    EVENT_LLM_TEXT,
)
from kalairos.run import (
    EVENT_RUN_COMPLETED,
    EVENT_RUN_FAILED,
    EVENT_RUN_STARTED,
    EVENT_TOOL_CALL_FAILED,
    EVENT_TOOL_CALL_REQUESTED,
    EVENT_TOOL_CALL_RESULT,
    STATUS_COMPLETED,
    STATUS_FAILED,
)


# ── Fake Anthropic client ──────────────────────────────────────────────────


class _Block:
    """Mimics an Anthropic content block. type is either 'text' or
    'tool_use'; relevant fields are set as attributes."""

    def __init__(self, type: str, **kwargs):
        self.type = type
        for k, v in kwargs.items():
            setattr(self, k, v)


class _Usage:
    def __init__(
        self,
        input_tokens: int = 10,
        output_tokens: int = 5,
        cache_creation_input_tokens: int = 0,
        cache_read_input_tokens: int = 0,
    ):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens
        self.cache_read_input_tokens = cache_read_input_tokens


class _Response:
    def __init__(
        self,
        content: list,
        stop_reason: str,
        usage: _Usage | None = None,
    ):
        self.content = content
        self.stop_reason = stop_reason
        self.usage = usage or _Usage()


class _FakeMessages:
    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []
        self.next_id = 0

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self._responses:
            raise RuntimeError(
                "FakeAnthropicClient: no more scripted responses"
            )
        return self._responses.pop(0)


class FakeAnthropicClient:
    """A minimal stand-in for `anthropic.Anthropic`. Tests script the
    sequence of responses; the loop pops them in order."""

    def __init__(self, responses: list):
        self.messages = _FakeMessages(responses)


def text_response(text: str) -> _Response:
    """Shortcut: an end_turn response with a single text block."""
    return _Response(
        content=[_Block(type="text", text=text)],
        stop_reason="end_turn",
    )


def tool_use_response(
    name: str, input: dict, use_id: str = "tu_1", text_before: str | None = None
) -> _Response:
    """Shortcut: a tool_use response, optionally with text first."""
    blocks: list = []
    if text_before:
        blocks.append(_Block(type="text", text=text_before))
    blocks.append(
        _Block(type="tool_use", id=use_id, name=name, input=input)
    )
    return _Response(content=blocks, stop_reason="tool_use")


# ── helpers for reading the trail ─────────────────────────────────────────


def _events_for_run(ledger: Ledger, run_id: str) -> list[dict]:
    rows = ledger.appender.load_raw()
    return sorted(
        (r for r in rows if r.get("id", "").startswith(f"{run_id}/")),
        key=lambda r: r.get("metadata", {}).get("seq", 0),
    )


def _event_types(events: list[dict]) -> list[str]:
    return [e["metadata"]["event_type"] for e in events]


# ── fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


@pytest.fixture
def echo_tool():
    @tool(
        description="Echo back a message",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    )
    def echo(text: str) -> str:
        return f"echo:{text}"

    return echo


@pytest.fixture
def add_tool():
    @tool(
        description="Add two integers",
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

    return add


@pytest.fixture
def boom_tool():
    @tool(description="Always raises", parameters={})
    def boom() -> None:
        raise RuntimeError("kaboom")

    return boom


@pytest.fixture
def agent(echo_tool, add_tool, boom_tool):
    return Agent(
        name="llm-tester",
        instructions="You are a helpful test agent.",
        tools=[echo_tool, add_tool, boom_tool],
    )


# ── End-turn (no tool use) ─────────────────────────────────────────────────


def test_single_turn_end_turn_completes_run(agent, ledger):
    client = FakeAnthropicClient([text_response("All done!")])
    loop = LLMLoop(client=client, model="test-model")
    run = loop.run(agent, ledger, user_message="hi")
    assert run.status == STATUS_COMPLETED
    assert run.result == "All done!"


def test_user_message_becomes_first_user_message(agent, ledger):
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client).run(
        agent, ledger, user_message="what's up?"
    )
    call = client.messages.calls[0]
    assert call["messages"][0]["role"] == "user"
    assert call["messages"][0]["content"] == "what's up?"


def test_model_parameter_flows_through(agent, ledger):
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client, model="custom-model").run(
        agent, ledger, user_message="hi"
    )
    assert client.messages.calls[0]["model"] == "custom-model"


# ── Tool use round trip ────────────────────────────────────────────────────


def test_tool_use_dispatches_and_continues(agent, ledger):
    """LLM asks for echo("hi") → loop runs the tool → result fed back →
    LLM produces final text → run completes."""
    client = FakeAnthropicClient(
        [
            tool_use_response("echo", {"text": "hi"}, use_id="tu_1"),
            text_response("Done: echo:hi"),
        ]
    )
    loop = LLMLoop(client=client)
    run = loop.run(agent, ledger, user_message="say hi")

    assert run.status == STATUS_COMPLETED
    assert run.result == "Done: echo:hi"


def test_tool_result_message_carries_use_id_and_content(agent, ledger):
    client = FakeAnthropicClient(
        [
            tool_use_response("add", {"a": 2, "b": 3}, use_id="tu_42"),
            text_response("5"),
        ]
    )
    LLMLoop(client=client).run(agent, ledger, user_message="2 + 3")

    # The second call to messages.create should have the tool_result
    # block referencing tu_42 with content "5" (add returns 5).
    second_call = client.messages.calls[1]
    tool_result_msg = second_call["messages"][-1]
    assert tool_result_msg["role"] == "user"
    tool_result_block = tool_result_msg["content"][0]
    assert tool_result_block["type"] == "tool_result"
    assert tool_result_block["tool_use_id"] == "tu_42"
    assert tool_result_block["content"] == "5"
    assert "is_error" not in tool_result_block


def test_tool_error_feeds_back_as_is_error_result(agent, ledger):
    """Tool exceptions become is_error tool_results — the model can
    choose to retry, try a different tool, or give up."""
    client = FakeAnthropicClient(
        [
            tool_use_response("boom", {}, use_id="tu_99"),
            text_response("Tool failed; giving up."),
        ]
    )
    run = LLMLoop(client=client).run(
        agent, ledger, user_message="run boom"
    )

    # Run still completes — a tool error is the model's problem, not
    # the loop's.
    assert run.status == STATUS_COMPLETED

    second_call = client.messages.calls[1]
    tool_result_block = second_call["messages"][-1]["content"][0]
    assert tool_result_block["is_error"] is True
    assert "kaboom" in tool_result_block["content"]
    assert "RuntimeError" in tool_result_block["content"]


def test_assistant_message_appended_with_full_content(agent, ledger):
    client = FakeAnthropicClient(
        [
            tool_use_response(
                "echo",
                {"text": "x"},
                use_id="tu_1",
                text_before="Calling echo now",
            ),
            text_response("done"),
        ]
    )
    LLMLoop(client=client).run(agent, ledger, user_message="hi")

    second_call = client.messages.calls[1]
    assistant_msg = second_call["messages"][1]
    assert assistant_msg["role"] == "assistant"
    # Full content array preserved, both text and tool_use blocks
    assert len(assistant_msg["content"]) == 2


# ── Multiple iterations ────────────────────────────────────────────────────


def test_multi_iteration_tool_chain(agent, ledger):
    """LLM calls echo, then add, then finishes."""
    client = FakeAnthropicClient(
        [
            tool_use_response("echo", {"text": "first"}, use_id="t1"),
            tool_use_response("add", {"a": 1, "b": 2}, use_id="t2"),
            text_response("All three calls done"),
        ]
    )
    run = LLMLoop(client=client).run(
        agent, ledger, user_message="chain stuff"
    )
    assert run.status == STATUS_COMPLETED
    # 3 LLM calls happened
    assert len(client.messages.calls) == 3


def test_max_iterations_exhausted_fails_run(agent, ledger):
    """If the LLM keeps asking for tools forever, max_iterations
    triggers a run.fail with a clear reason."""
    client = FakeAnthropicClient(
        [tool_use_response("echo", {"text": "x"}, use_id=f"t{i}") for i in range(5)]
    )
    loop = LLMLoop(client=client, max_iterations=3)
    run = loop.run(agent, ledger, user_message="loop forever")
    assert run.status == STATUS_FAILED
    assert "max iterations" in run.error


def test_unexpected_stop_reason_fails_run(agent, ledger):
    client = FakeAnthropicClient(
        [
            _Response(
                content=[_Block(type="text", text="cut off")],
                stop_reason="max_tokens",
            )
        ]
    )
    run = LLMLoop(client=client).run(
        agent, ledger, user_message="hi"
    )
    assert run.status == STATUS_FAILED
    assert "max_tokens" in run.error


# ── Ledger trail ───────────────────────────────────────────────────────────


def test_emits_llm_request_response_text_events(agent, ledger):
    client = FakeAnthropicClient(
        [
            tool_use_response(
                "echo", {"text": "x"}, use_id="t1", text_before="thinking..."
            ),
            text_response("final answer"),
        ]
    )
    run = LLMLoop(client=client).run(agent, ledger, user_message="hi")
    events = _events_for_run(ledger, run.run_id)
    types = _event_types(events)

    # Each LLM call emits request + response (+ text if any).
    assert types.count(EVENT_LLM_REQUEST) == 2
    assert types.count(EVENT_LLM_RESPONSE) == 2
    # First response had text-before-tool-use; second was just text.
    # Both should produce llm_text events.
    assert types.count(EVENT_LLM_TEXT) == 2


def test_llm_response_event_carries_usage_and_stop_reason(agent, ledger):
    client = FakeAnthropicClient(
        [
            _Response(
                content=[_Block(type="text", text="hi")],
                stop_reason="end_turn",
                usage=_Usage(
                    input_tokens=100,
                    output_tokens=5,
                    cache_read_input_tokens=80,
                ),
            )
        ]
    )
    run = LLMLoop(client=client).run(agent, ledger, user_message="x")
    events = _events_for_run(ledger, run.run_id)
    resp_event = next(
        e for e in events if e["metadata"]["event_type"] == EVENT_LLM_RESPONSE
    )
    payload = resp_event["metadata"]["payload"]
    assert payload["stop_reason"] == "end_turn"
    assert payload["usage"]["input_tokens"] == 100
    assert payload["usage"]["cache_read_input_tokens"] == 80


def test_tool_calls_also_produce_standard_run_events(agent, ledger):
    """LLM-dispatched tool calls go through Run.call_tool, so they emit
    tool_call_requested + tool_call_result in the same trail."""
    client = FakeAnthropicClient(
        [
            tool_use_response("echo", {"text": "x"}, use_id="t1"),
            text_response("done"),
        ]
    )
    run = LLMLoop(client=client).run(agent, ledger, user_message="hi")
    types = _event_types(_events_for_run(ledger, run.run_id))
    assert EVENT_TOOL_CALL_REQUESTED in types
    assert EVENT_TOOL_CALL_RESULT in types


def test_tool_error_produces_tool_call_failed_event(agent, ledger):
    client = FakeAnthropicClient(
        [
            tool_use_response("boom", {}, use_id="t1"),
            text_response("gave up"),
        ]
    )
    run = LLMLoop(client=client).run(agent, ledger, user_message="hi")
    types = _event_types(_events_for_run(ledger, run.run_id))
    assert EVENT_TOOL_CALL_FAILED in types


# ── Prompt caching ─────────────────────────────────────────────────────────


def test_system_prompt_has_cache_control(agent, ledger):
    """The system prompt block should carry cache_control so repeated
    runs of the same agent hit the prompt cache."""
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client).run(agent, ledger, user_message="hi")
    call = client.messages.calls[0]
    assert "system" in call
    system_block = call["system"][0]
    assert system_block["text"] == agent.instructions
    assert system_block["cache_control"] == {"type": "ephemeral"}


def test_last_tool_has_cache_control(agent, ledger):
    """Cache breakpoint on the LAST tool covers the whole tools array
    per Anthropic API semantics."""
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client).run(agent, ledger, user_message="hi")
    call = client.messages.calls[0]
    tools = call["tools"]
    # All tools shipped
    tool_names = {t["name"] for t in tools}
    assert tool_names == {"echo", "add", "boom"}
    # Only the last carries cache_control
    cached = [t for t in tools if "cache_control" in t]
    assert len(cached) == 1
    assert cached[0] is tools[-1]
    assert cached[0]["cache_control"] == {"type": "ephemeral"}


def test_cache_control_doesnt_mutate_agent_registry(agent, ledger):
    """The tool definitions returned to_anthropic_schema() must not get
    cache_control set on them — that would leak across runs."""
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client).run(agent, ledger, user_message="hi")
    # Check the registry's schemas are clean
    schemas = agent.tools.to_anthropic_schema()
    for s in schemas:
        assert "cache_control" not in s


def test_no_system_block_when_instructions_empty(ledger):
    """Empty instructions → no system field, no wasted cache slot."""
    empty_agent = Agent(name="bare")
    client = FakeAnthropicClient([text_response("ok")])
    LLMLoop(client=client).run(empty_agent, ledger, user_message="hi")
    call = client.messages.calls[0]
    assert "system" not in call
    assert "tools" not in call  # no tools either


# ── E2E with realistic shape ──────────────────────────────────────────────


def test_e2e_two_tool_chain_with_final_summary(agent, ledger):
    """A realistic flow: ask the agent to do something, it calls a tool,
    looks at the result, calls another tool, then summarizes."""
    client = FakeAnthropicClient(
        [
            tool_use_response(
                "add",
                {"a": 5, "b": 7},
                use_id="t1",
                text_before="Let me add those.",
            ),
            tool_use_response(
                "echo",
                {"text": "answer is 12"},
                use_id="t2",
                text_before="Now I'll echo the result.",
            ),
            text_response("5 + 7 = 12, and echo confirmed it."),
        ]
    )
    run = LLMLoop(client=client).run(
        agent, ledger, user_message="add 5 and 7, then echo the answer"
    )
    assert run.status == STATUS_COMPLETED
    assert "12" in run.result

    # Three LLM calls + two tool dispatches.
    assert len(client.messages.calls) == 3
    types = _event_types(_events_for_run(ledger, run.run_id))
    assert types.count(EVENT_TOOL_CALL_RESULT) == 2
    assert types[0] == EVENT_RUN_STARTED
    assert types[-1] == EVENT_RUN_COMPLETED
