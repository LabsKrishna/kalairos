"""Executor — drives a Run through a WorkflowGraph.

The executor walks nodes from the graph's start to a terminal node,
emitting events at every step via the Run. State (a mutable dict) flows
through the nodes: StepNodes read from it via their `inputs` callable
and write back via `output_key`; BranchNodes pick the next node from a
fan-out keyed off `condition(state)`.

Phase 2.3 is sync + linear: one node at a time, single thread. Phase
2.5 will introduce async semantics for Handoff/Join nodes (cross-
runtime wait-states); the dispatch table in `_execute_node` makes that
additive — adding a new node type only touches one place.

Events emitted (in addition to the standard Run events from run.py):
  - node_entered    — before the node's work runs
  - node_completed  — after the node's work succeeds
  - branch_chosen   — emitted by BranchNode dispatch with {key, target}
"""

from __future__ import annotations

import threading
import uuid
from typing import Any

from .agent import Agent
from .ledger import Ledger
from .run import Run
from .workflow_graph import BranchNode, HandoffNode, Node, StepNode, WorkflowGraph

# Workflow-graph event types. Live alongside Run's event types so the
# trail shows the full nested flow (graph nodes + tool calls + thoughts).
EVENT_GRAPH_DEFINED = "graph_defined"
EVENT_NODE_ENTERED = "node_entered"
EVENT_NODE_COMPLETED = "node_completed"
EVENT_BRANCH_CHOSEN = "branch_chosen"
EVENT_HANDOFF_REQUESTED = "handoff_requested"
EVENT_HANDOFF_COMPLETED = "handoff_completed"
EVENT_HANDOFF_FAILED = "handoff_failed"

# Event type Node services emit when their work is done. The executor
# subscribes to the Ledger before emitting handoff_requested and waits
# for a matching one to arrive.
EVENT_HANDOFF_RESULT = "handoff_result"


class Executor:
    """Walks a WorkflowGraph step-by-step, driving a Run.

    Validates the graph eagerly at construction so dangling references
    (missing next, unknown branch target) surface before any work runs.
    """

    def __init__(self, graph: WorkflowGraph):
        graph.validate()
        self.graph = graph

    def run(
        self,
        agent: Agent,
        ledger: Ledger,
        *,
        initial_state: dict | None = None,
        run_id: str | None = None,
        goal: str | None = None,
    ) -> tuple[Run, dict]:
        """Execute the graph end to end.

        Returns `(Run, final_state)`. On exception:
          - tool failures: `Run.call_tool` already emitted
            tool_call_failed; the executor catches the exception,
            calls `Run.fail`, and re-raises so the caller sees it.
          - graph/branch errors: same — fail the run, re-raise.
        """
        state: dict = dict(initial_state or {})
        r = Run(agent, ledger, run_id=run_id, goal=goal)
        r.start()
        # Emit the graph topology so the control plane (Phase 4.2) can
        # render the node graph for this run without needing access to
        # the Python WorkflowGraph object — the JSONL is enough.
        r.emit(EVENT_GRAPH_DEFINED, {"graph": self.graph.to_dict()})

        try:
            current: Node | None = self.graph.start_node()
            while current is not None:
                self._emit_node_event(r, EVENT_NODE_ENTERED, current.name)
                next_name = self._execute_node(r, current, state)
                self._emit_node_event(r, EVENT_NODE_COMPLETED, current.name)
                current = self.graph.get(next_name) if next_name else None
        except Exception as e:
            r.fail(f"{type(e).__name__}: {e}")
            raise

        r.finish(result=state)
        return r, state

    # ── Node dispatch ──────────────────────────────────────────────────

    def _execute_node(
        self, run: Run, node: Node, state: dict
    ) -> str | None:
        if isinstance(node, StepNode):
            return self._execute_step(run, node, state)
        if isinstance(node, BranchNode):
            return self._execute_branch(run, node, state)
        if isinstance(node, HandoffNode):
            return self._execute_handoff(run, node, state)
        raise TypeError(
            f"Executor: unknown node type {type(node).__name__}"
        )

    def _execute_step(
        self, run: Run, node: StepNode, state: dict
    ) -> str | None:
        if node.think is not None:
            run.think(node.think)
            return node.next
        # tool branch — __post_init__ guarantees node.tool is set here
        kwargs = node.inputs(state) if node.inputs else {}
        result = run.call_tool(node.tool, **kwargs)  # type: ignore[arg-type]
        if node.output_key:
            state[node.output_key] = result
        return node.next

    def _execute_handoff(
        self, run: Run, node: HandoffNode, state: dict
    ) -> str | None:
        """Cross-runtime handoff.

        Subscribes to the Ledger BEFORE emitting handoff_requested
        (otherwise a fast Node service could reply before we'd have a
        chance to listen). The subscriber filters for handoff_result
        events matching our handoff_id, captures the payload, and
        signals a threading.Event. We then wait — blocking the
        executor thread — until the event fires or the timeout
        elapses. Node-service replies arrive on a different thread
        (the LedgerServer's HTTP worker, or whatever wrote them);
        threading.Event is the simplest cross-thread signal that
        works here.
        """
        handoff_id = f"ho_{uuid.uuid4().hex[:12]}"
        captured: dict[str, Any] = {}
        result_signal = threading.Event()

        def listener(record: dict) -> None:
            md = record.get("metadata") or {}
            if md.get("event_type") != EVENT_HANDOFF_RESULT:
                return
            payload = md.get("payload") or {}
            if payload.get("handoff_id") != handoff_id:
                return
            captured["result"] = payload.get("result")
            captured["error"] = payload.get("error")
            result_signal.set()

        unsubscribe = run.ledger.subscribe(listener)
        try:
            payload_input = node.inputs(state) if node.inputs else {}
            run.emit(
                EVENT_HANDOFF_REQUESTED,
                {
                    "handoff_id": handoff_id,
                    "service": node.service,
                    "input": payload_input,
                    "timeout": node.timeout,
                },
            )

            if not result_signal.wait(timeout=node.timeout):
                run.emit(
                    EVENT_HANDOFF_FAILED,
                    {
                        "handoff_id": handoff_id,
                        "service": node.service,
                        "error": "timeout",
                    },
                )
                raise TimeoutError(
                    f"Executor: handoff {handoff_id} to {node.service!r} "
                    f"timed out after {node.timeout}s"
                )

            if captured.get("error") is not None:
                run.emit(
                    EVENT_HANDOFF_FAILED,
                    {
                        "handoff_id": handoff_id,
                        "service": node.service,
                        "error": captured["error"],
                    },
                )
                raise RuntimeError(
                    f"Executor: handoff {handoff_id} to {node.service!r} "
                    f"failed: {captured['error']}"
                )

            result = captured.get("result")
            run.emit(
                EVENT_HANDOFF_COMPLETED,
                {
                    "handoff_id": handoff_id,
                    "service": node.service,
                    "result": result,
                },
            )
            if node.output_key:
                state[node.output_key] = result
            return node.next
        finally:
            unsubscribe()

    def _execute_branch(
        self, run: Run, node: BranchNode, state: dict
    ) -> str:
        key = node.condition(state)
        if key not in node.branches:
            raise KeyError(
                f"Executor: branch {node.name!r} condition returned "
                f"{key!r}, not in branches {list(node.branches.keys())}"
            )
        target = node.branches[key]
        self._emit_node_event(
            run,
            EVENT_BRANCH_CHOSEN,
            node.name,
            extra={"key": key, "target": target},
        )
        return target

    # ── Event emission ─────────────────────────────────────────────────

    def _emit_node_event(
        self,
        run: Run,
        event_type: str,
        node_name: str,
        *,
        extra: dict | None = None,
    ) -> None:
        """Emit a workflow-graph event via Run.emit so it lands in the
        same trail as run/tool events. Control plane reads one ledger."""
        payload: dict[str, Any] = {"node": node_name}
        if extra:
            payload.update(extra)
        run.emit(event_type, payload)
