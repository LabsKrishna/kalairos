"""Run — an execution instance of an Agent toward a goal.

Every step a Run takes — start, think, tool call, tool result, finish —
is persisted as a record in the Ledger. The Ledger is canonical; the
control plane (Phase 2.3+) will read it to replay or visualize the run.

Phase 2.2 is the spine: explicit step-by-step control (the caller drives
each step). Phase 2.4 will layer LLM-driven autonomous stepping on top
of exactly this contract — `Run.call_tool`, `Run.think`, `Run.finish`,
`Run.fail` are the same primitives the LLM loop will use.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from .agent import Agent
from .ledger import Ledger

# Closed set of event types. Consumers should switch on these.
EVENT_RUN_STARTED = "run_started"
EVENT_RUN_COMPLETED = "run_completed"
EVENT_RUN_FAILED = "run_failed"
EVENT_THOUGHT = "thought"
EVENT_TOOL_CALL_REQUESTED = "tool_call_requested"
EVENT_TOOL_CALL_RESULT = "tool_call_result"
EVENT_TOOL_CALL_FAILED = "tool_call_failed"

# Status states. Lifecycle: pending → running → (completed | failed).
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"

# Records are stored under the `long-term` memoryType (the only durable
# choice in `_VALID_MEMORY_TYPES`) and scoped via a dedicated workspace
# so control-plane queries can isolate "just agent traces" without
# pulling unrelated long-term memories. `type` is set to "run-event" to
# narrow further when querying the facts table directly.
RUN_NAMESPACE = "long-term"
RUN_WORKSPACE = "agent-runs"
RUN_RECORD_TYPE = "run-event"


class Run:
    """An execution instance of an Agent.

    Lifecycle:
        pending → running → completed
                          ↘ failed

    Every event is appended to the Ledger; the Ledger is the source of
    truth for the run's history. `Run` itself only tracks the
    in-process state (status, result, sequence counter) needed to
    enforce the lifecycle.
    """

    def __init__(
        self,
        agent: Agent,
        ledger: Ledger,
        *,
        run_id: str | None = None,
        goal: str | None = None,
    ):
        self.agent = agent
        self.ledger = ledger
        self.run_id = run_id or f"run-{uuid.uuid4().hex[:12]}"
        self.goal = goal
        self.status = STATUS_PENDING
        self.result: Any = None
        self.error: str | None = None
        self._seq = 0  # monotonic event counter

    # ── Lifecycle ──────────────────────────────────────────────────────

    def start(self) -> None:
        """Transition pending → running and emit a run_started event."""
        if self.status != STATUS_PENDING:
            raise RuntimeError(
                f"Run.start: cannot start from status {self.status!r}"
            )
        self.status = STATUS_RUNNING
        self.emit(
            EVENT_RUN_STARTED,
            {
                "agent": self.agent.name,
                "goal": self.goal,
                "instructions": self.agent.instructions,
            },
        )

    def finish(self, result: Any = None) -> None:
        """Transition running → completed with an optional final result."""
        self._require_running("finish")
        self.status = STATUS_COMPLETED
        self.result = result
        self.emit(EVENT_RUN_COMPLETED, {"result": result})

    def fail(self, error: str) -> None:
        """Transition running → failed with an error message."""
        self._require_running("fail")
        self.status = STATUS_FAILED
        self.error = error
        self.emit(EVENT_RUN_FAILED, {"error": error})

    # ── Stepping ───────────────────────────────────────────────────────

    def think(self, text: str) -> None:
        """Record a reasoning step without invoking a tool."""
        self._require_running("think")
        self.emit(EVENT_THOUGHT, {"text": text})

    def call_tool(self, tool_name: str, **kwargs: Any) -> Any:
        """Invoke a tool by name. Emits tool_call_requested before, then
        tool_call_result on success or tool_call_failed on exception.

        Exceptions are re-raised so the caller can decide what to do
        (retry, fail the run, etc.) — both pre and post events land in
        the ledger either way, so the control plane sees the attempt
        even when it errors.
        """
        self._require_running("call_tool")
        t = self.agent.tools.get(tool_name)  # KeyError if missing
        self.emit(
            EVENT_TOOL_CALL_REQUESTED,
            {"tool": tool_name, "input": kwargs},
        )
        try:
            result = t.call(**kwargs)
        except Exception as e:
            self.emit(
                EVENT_TOOL_CALL_FAILED,
                {
                    "tool": tool_name,
                    "error": str(e),
                    "error_type": type(e).__name__,
                },
            )
            raise
        self.emit(
            EVENT_TOOL_CALL_RESULT,
            {"tool": tool_name, "result": result},
        )
        return result

    # ── Internal ───────────────────────────────────────────────────────

    def _require_running(self, op: str) -> None:
        if self.status != STATUS_RUNNING:
            raise RuntimeError(
                f"Run.{op}: not running (status={self.status!r})"
            )

    def emit(self, event_type: str, payload: dict) -> str:
        """Append one event to the ledger as an entity record. Returns
        the event id so callers/tests can reference it.

        Public because higher-level components (the Executor in 2.3,
        the LLM loop in 2.4) need to record their own events into the
        same trail. The standard Run events (start/finish/fail/think/
        call_tool) call this internally; outside callers pick their own
        `event_type` strings.

        Event records share a schema with v1.7 entities so they index
        cleanly: text is the JSON-encoded payload (the JSONL line stays
        self-describing without consulting parsed metadata), memoryType
        is the run namespace, workspace scopes to agent-runs, and tags
        include the run id, agent name, and event type for control-
        plane queries.
        """
        seq = self._seq
        self._seq += 1
        ts = int(time.time() * 1000)
        event_id = f"{self.run_id}/{seq:04d}/{event_type}"
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        record = {
            "id": event_id,
            "text": text,
            "type": RUN_RECORD_TYPE,
            "memoryType": RUN_NAMESPACE,
            "workspaceId": RUN_WORKSPACE,
            "tags": [
                "run-event",
                event_type,
                f"run:{self.run_id}",
                f"agent:{self.agent.name}",
            ],
            "versions": [{"timestamp": ts, "text": text, "ingestAt": ts}],
            "metadata": {
                "run_id": self.run_id,
                "agent_name": self.agent.name,
                "event_type": event_type,
                "seq": seq,
                "payload": payload,
            },
        }
        self.ledger.append(record)
        return event_id

    def __repr__(self) -> str:
        return (
            f"Run(id={self.run_id!r}, agent={self.agent.name!r}, "
            f"status={self.status!r})"
        )
