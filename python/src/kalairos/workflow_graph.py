"""WorkflowGraph — declarative graph of agent reasoning steps.

A workflow graph is a directed graph of named nodes. An Agent walks
through it via an `Executor` (executor.py): one node at a time, from
`start` to a terminal node. Each step is a record in the Ledger so the
control plane can replay or visualize the whole flow.

Phase 2.3 scope (this file):
- StepNode: either invoke a tool OR record a thought; optional output_key
  stores the tool result back into the shared state dict.
- BranchNode: a condition function returns a key picking the next node
  from a fan-out map.
- WorkflowGraph: container + start + validate.

Phase 2.5 will add Handoff/Join nodes with cross-runtime wait-state
(handoff = ledger event to a Node service; join unblocks when the reply
event lands). Designing the executor (executor.py) to dispatch on node
type makes those additive — no refactor of Step/Branch when they land.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Union


@dataclass(frozen=True)
class StepNode:
    """One step of work: invoke a tool OR record a thought.

    Fields:
      name: graph-unique identifier.
      tool: tool name to invoke (mutually exclusive with `think`).
      inputs(state) -> dict: called to produce the tool's kwargs.
      output_key: optional; if set, the tool result is stored at
        state[output_key] for downstream nodes to read.
      think: a thought to record (mutually exclusive with `tool`).
      next: the name of the next node, or None for a terminal step.
    """

    name: str
    tool: str | None = None
    inputs: Callable[[dict], dict] | None = None
    output_key: str | None = None
    think: str | None = None
    next: str | None = None

    def __post_init__(self) -> None:
        if (self.tool is None) == (self.think is None):
            raise ValueError(
                f"StepNode {self.name!r}: exactly one of `tool` or `think` "
                f"must be set"
            )
        if self.think is not None and (self.inputs or self.output_key):
            raise ValueError(
                f"StepNode {self.name!r}: think-only nodes can't have "
                f"`inputs` or `output_key`"
            )


@dataclass(frozen=True)
class BranchNode:
    """Conditional fan-out.

    `condition(state)` returns a key; `branches[key]` is the next node.
    A key the condition returns that isn't in `branches` is a runtime
    error — the executor will surface it.
    """

    name: str
    condition: Callable[[dict], str]
    branches: dict[str, str]

    def __post_init__(self) -> None:
        if not self.branches:
            raise ValueError(
                f"BranchNode {self.name!r}: at least one branch is required"
            )


@dataclass(frozen=True)
class HandoffNode:
    """Cross-runtime handoff: delegate work to a Node service and wait
    for the reply event to land in the Ledger.

    Phase 2.5 wait-state — the Executor emits a handoff_requested event
    (the Node service is expected to be subscribed via LedgerServer or
    a poller), then blocks on a `threading.Event` until a matching
    handoff_result event arrives. The reply's `result` value is stored
    at `output_key` (if set) and execution continues to `next`.

    Fields:
      name: graph-unique identifier.
      service: informational identifier for the target Node service
        (carried in the handoff_requested payload so consumers can route).
      inputs(state) -> dict: produces the payload sent to the service.
      output_key: where to store the service's result in state.
      timeout: seconds to wait for the reply event; `None` = wait
        forever. Defaults to 30s so authoring mistakes don't hang runs.
      next: name of the next node, or None for terminal.
    """

    name: str
    service: str
    inputs: Callable[[dict], dict] | None = None
    output_key: str | None = None
    timeout: float | None = 30.0
    next: str | None = None

    def __post_init__(self) -> None:
        if not self.service:
            raise ValueError(
                f"HandoffNode {self.name!r}: `service` is required"
            )


Node = Union[StepNode, BranchNode, HandoffNode]


class WorkflowGraph:
    """Container for named nodes + a designated start node.

    Each node knows its own successor(s); topology lives in the nodes
    rather than as separate edge declarations — that's one place to read
    when reasoning about flow.
    """

    def __init__(self, name: str):
        if not name:
            raise ValueError("WorkflowGraph: name is required")
        self.name = name
        self._nodes: dict[str, Node] = {}
        self._start: str | None = None

    def add(self, node: Node) -> Node:
        if node.name in self._nodes:
            raise ValueError(
                f"WorkflowGraph {self.name!r}: node {node.name!r} already added"
            )
        self._nodes[node.name] = node
        return node

    def set_start(self, name: str) -> None:
        if name not in self._nodes:
            raise ValueError(
                f"WorkflowGraph {self.name!r}: no node {name!r} to set as start"
            )
        self._start = name

    def start_node(self) -> Node:
        if self._start is None:
            raise RuntimeError(
                f"WorkflowGraph {self.name!r}: no start node set"
            )
        return self._nodes[self._start]

    def get(self, name: str) -> Node:
        if name not in self._nodes:
            raise KeyError(
                f"WorkflowGraph {self.name!r}: no node {name!r}"
            )
        return self._nodes[name]

    def names(self) -> list[str]:
        return list(self._nodes.keys())

    def __contains__(self, name: str) -> bool:
        return name in self._nodes

    def __len__(self) -> int:
        return len(self._nodes)

    def __iter__(self):
        return iter(self._nodes.values())

    def validate(self) -> None:
        """Check graph integrity: start is set; every node referenced
        by a `next` pointer or branch target exists.

        Catches the common authoring mistakes before execution starts,
        so failures show up at graph construction rather than mid-run.
        """
        if self._start is None:
            raise ValueError(
                f"WorkflowGraph {self.name!r}: no start node set"
            )
        for n in self._nodes.values():
            if isinstance(n, (StepNode, HandoffNode)):
                if n.next is not None and n.next not in self._nodes:
                    raise ValueError(
                        f"WorkflowGraph {self.name!r}: node {n.name!r} "
                        f"references unknown next {n.next!r}"
                    )
            elif isinstance(n, BranchNode):
                for key, target in n.branches.items():
                    if target not in self._nodes:
                        raise ValueError(
                            f"WorkflowGraph {self.name!r}: branch "
                            f"{n.name!r}.{key!r} references unknown "
                            f"node {target!r}"
                        )
