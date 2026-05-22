"""LLMLoop — drives a Run autonomously via Anthropic's messages API.

The LLM picks tools off the Agent's ToolRegistry, produces tool_use
blocks, and this loop dispatches them via `Run.call_tool` — the same
path the Executor uses for declarative graphs. Tool results feed back
as the next user message; the loop continues until the model emits
`end_turn`, an unexpected `stop_reason`, or `max_iterations` is reached.

Prompt caching is on by default for system prompt + tool definitions
(5-min ephemeral TTL). Repeated runs of the same agent within the
window hit the cache and pay roughly 10% of input-token cost for the
cached prefix — meaningful for agents whose tool schemas stabilize
across many runs.

Phase 2.4 is sync. Async/streaming come later when concurrent or
long-running agents need them.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .agent import Agent
from .ledger import Ledger
from .run import Run

log = logging.getLogger(__name__)

# LLM-specific event types beyond Run's standard set. Land in the same
# trail as run/tool events so the control plane sees the whole flow.
EVENT_LLM_REQUEST = "llm_request"
EVENT_LLM_RESPONSE = "llm_response"
EVENT_LLM_TEXT = "llm_text"

# Anthropic stop_reason values we handle. Anything else fails the run
# with the unexpected stop_reason in the run_failed event.
STOP_END_TURN = "end_turn"
STOP_TOOL_USE = "tool_use"

# Defaults. Model name is a parameter so callers can pin a specific
# version or use a faster/cheaper tier per agent.
DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_MAX_ITERATIONS = 10


class LLMLoop:
    """Drives a Run autonomously using Anthropic's messages API.

    Construct with a client (or let the default construct an
    `anthropic.Anthropic()` reading the API key from env). Tests inject
    a fake client implementing `client.messages.create(**kwargs)`.
    """

    def __init__(
        self,
        client: Any = None,
        *,
        model: str = DEFAULT_MODEL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
    ):
        if client is None:
            import anthropic

            client = anthropic.Anthropic()
        self.client = client
        self.model = model
        self.max_tokens = max_tokens
        self.max_iterations = max_iterations

    def run(
        self,
        agent: Agent,
        ledger: Ledger,
        *,
        user_message: str,
        run_id: str | None = None,
        goal: str | None = None,
    ) -> Run:
        """Execute one LLM-driven run.

        Returns the completed Run. Lifecycle outcomes:
          * `end_turn` → `run.finish(result=<assistant text>)`
          * `max_iterations` exhausted → `run.fail(...)`
          * unexpected `stop_reason` → `run.fail(...)`
          * exception during the loop → `run.fail(...)` + re-raise so
            the caller sees the underlying error
        """
        r = Run(agent, ledger, run_id=run_id, goal=goal)
        r.start()

        try:
            messages: list[dict] = [
                {"role": "user", "content": user_message}
            ]
            for iteration in range(self.max_iterations):
                response = self._call_llm(r, agent, messages, iteration)
                stop = getattr(response, "stop_reason", None)

                if stop == STOP_END_TURN:
                    r.finish(result=_extract_text(response.content))
                    return r

                if stop != STOP_TOOL_USE:
                    r.fail(f"unexpected stop_reason: {stop!r}")
                    return r

                assistant_blocks = list(response.content)
                tool_results = self._dispatch_tool_blocks(r, assistant_blocks)
                messages.append(
                    {"role": "assistant", "content": assistant_blocks}
                )
                messages.append({"role": "user", "content": tool_results})

            r.fail(f"max iterations ({self.max_iterations}) exceeded")
            return r
        except Exception as e:
            if r.status not in ("completed", "failed"):
                r.fail(f"{type(e).__name__}: {e}")
            raise

    # ── Internals ──────────────────────────────────────────────────────

    def _call_llm(
        self,
        run: Run,
        agent: Agent,
        messages: list[dict],
        iteration: int,
    ) -> Any:
        """One round trip to `messages.create`. Emits an llm_request
        event before and an llm_response (with token usage) after."""
        system_blocks = self._build_system(agent)
        tool_blocks = self._build_tools(agent)

        run.emit(
            EVENT_LLM_REQUEST,
            {
                "iteration": iteration,
                "model": self.model,
                "message_count": len(messages),
            },
        )

        # Build kwargs incrementally so we don't pass empty system/tools
        # arrays — the Anthropic API accepts them either way, but
        # omitting cleans up the request payload.
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }
        if system_blocks:
            kwargs["system"] = system_blocks
        if tool_blocks:
            kwargs["tools"] = tool_blocks

        response = self.client.messages.create(**kwargs)

        run.emit(
            EVENT_LLM_RESPONSE,
            {
                "iteration": iteration,
                "stop_reason": getattr(response, "stop_reason", None),
                "usage": _serialize_usage(getattr(response, "usage", None)),
            },
        )

        # Surface any pre-tool-use assistant text into the trail. The
        # model often reasons before invoking tools; recording it makes
        # the control plane's reconstruction match what the user saw.
        text = _extract_text(response.content)
        if text:
            run.emit(EVENT_LLM_TEXT, {"text": text})

        return response

    def _build_system(self, agent: Agent) -> list[dict]:
        """System prompt as a single text block with cache_control.

        Caching the system prompt is high-leverage: it stays stable
        across runs of the same agent, so repeated invocations within
        the 5-min TTL skip re-tokenizing the same instructions.
        """
        if not agent.instructions:
            return []
        return [
            {
                "type": "text",
                "text": agent.instructions,
                "cache_control": {"type": "ephemeral"},
            }
        ]

    def _build_tools(self, agent: Agent) -> list[dict]:
        """Tool definitions. `cache_control` on the LAST tool sets the
        cache breakpoint covering the entire `tools` array — that's how
        the Anthropic API treats it. Mutating a copy so the registry's
        own dicts aren't touched across runs.
        """
        schemas = agent.tools.to_anthropic_schema()
        if schemas:
            schemas[-1] = dict(schemas[-1])
            schemas[-1]["cache_control"] = {"type": "ephemeral"}
        return schemas

    def _dispatch_tool_blocks(
        self, run: Run, blocks: list[Any]
    ) -> list[dict]:
        """Execute each tool_use block; build the matching tool_result
        blocks for the next turn.

        Tool exceptions become `is_error=True` results that go back to
        the model — it can choose to retry, try a different tool, or
        give up. We don't fail the whole run on a single tool error.
        """
        results: list[dict] = []
        for block in blocks:
            if getattr(block, "type", None) != "tool_use":
                continue
            tool_use_id = block.id
            name = block.name
            input_dict = block.input or {}
            try:
                result = run.call_tool(name, **input_dict)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": _stringify_tool_result(result),
                    }
                )
            except Exception as e:
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": (
                            f"Error: {type(e).__name__}: {e}"
                        ),
                        "is_error": True,
                    }
                )
        return results


# ── One-shot helper for tools that wrap LLM reasoning ──────────────────────


def llm_text_call(
    client: Any,
    *,
    model: str = DEFAULT_MODEL,
    system: str,
    user_message: str,
    max_tokens: int = 1024,
) -> str:
    """One-shot LLM call returning just the assistant text.

    For tools that need quick LLM reasoning without the full LLMLoop
    overhead — no message history, no tool dispatch, no event emission.
    The system block carries cache_control so repeated calls from the
    same tool (same system prompt) hit the cache.

    Used by the Phase 3.2 WorkflowGraph PR analyzer: the
    `summarize_pr_risk` tool wraps this so a deterministic graph
    (StepNode + BranchNode) can still call into the LLM for the steps
    that need it.
    """
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[
            {
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )
    return _extract_text(response.content)


# ── Helpers ────────────────────────────────────────────────────────────


def _extract_text(blocks: list[Any]) -> str:
    """Concatenate all text content blocks. Tool_use blocks are skipped
    — text and tool_use can be interleaved in a single response."""
    parts: list[str] = []
    for b in blocks:
        if getattr(b, "type", None) == "text":
            parts.append(getattr(b, "text", ""))
    return "".join(parts)


def _stringify_tool_result(result: Any) -> str:
    """Render a tool result as a string for the messages API. JSON
    serializable structures round-trip; primitives stringify directly;
    anything weird falls back to repr() so the loop doesn't crash on
    bad return values."""
    if isinstance(result, str):
        return result
    if isinstance(result, (int, float, bool)):
        return str(result)
    try:
        return json.dumps(result, ensure_ascii=False)
    except (TypeError, ValueError):
        return repr(result)


def _serialize_usage(usage: Any) -> dict:
    """Pull token-count fields off Anthropic's `Usage` object. Robust to
    missing fields so old SDK versions still report something."""
    if usage is None:
        return {}
    fields = (
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    )
    return {f: getattr(usage, f, None) for f in fields if hasattr(usage, f)}
