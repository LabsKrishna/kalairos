# Kalairos — System Design

One page, three runtimes, one spine. This is the map: what each part is,
how they talk, and the one rule that keeps them honest.

> **The spine:** a single append-only **JSONL ledger** is the source of
> truth. **SQLite** is a fast index *derived* from it. Everything below
> writes to, or reads from, that spine. (CLAUDE.md §11.9)

---

## 1. The three runtimes

| # | Runtime | Lives in | Job |
|---|---------|----------|-----|
| 1 | **Memory engine** | root: `index.js`, `trust.js`, … | Stores & recalls facts with time + trust |
| 2 | **Agent platform (Python)** | `python/src/kalairos/` | Agent, workflow, control-plane primitives |
| 3 | **Node services** | `services/` | Cross-runtime workers (e.g. dep-graph builder) |

### 1. Memory engine (Node, the foundation)
The original library + servers. Stores entities as versioned facts, each
carrying time, provenance, and a trust score.

- `index.js` — public API: `init`, `ingest`, `query`, `remember`, `getHistory`
- `trust.js` — trust scoring & provenance
- `versioning.js` — every mutation makes a version record
- `kernel.js` / `worker.js` / `worker-pool.js` — query/ingest execution
- `embedder.js` — embeddings for retrieval
- `mcp.js` / `server.js` / `remote.js` — MCP + REST surfaces
- `auth.js`, `errors.js` — token auth, error types

### 2. Agent platform (Python, the headline)
The runtime that *runs agents* and the control plane that *shows what they
did*. It owns the canonical ledger.

- `agent.py`, `executor.py`, `run.py` — the agent run loop
- `workflow_graph.py` — `StepNode` / `BranchNode` / `HandoffNode` graphs
- `ledger.py` — **the unified write API** (JSONL first, then SQLite index)
- `jsonl.py`, `sqlite_index.py` — the canonical store + derived index
- `versioning.py`, `schema.py`, `entity_normalizer.py` — the data model
- `control_plane.py` + `server.py` — the visual ledger (timeline, graph, SSE)
- `agents/pr_risk.py` — example agent that hands work off to a Node service

### 3. Node services (the cross-runtime arm)
Stateless workers that do work Python delegates out. **Read-only on the
JSONL; they write back over HTTP.**

- `services/dep-graph-builder/` — tails the ledger, parses imports of changed
  files, POSTs the dep graph back. Counterpart to Python's `HandoffNode`.

---

## 2. How they fit together

```
                 ┌──────────────────────────────────────────────┐
                 │            CONTROL PLANE (Python)             │
                 │   control_plane.py + server.py — timeline,    │
                 │   workflow graph, live SSE updates            │
                 └───────────────────────▲──────────────────────┘
                                         │ reads
        writes  ┌────────────────────────┴───────────────────────┐
   ┌────────────┤              THE SPINE                          │
   │            │   ledger.py  →  JSONL (truth)  →  SQLite (index)│
   │            └───────▲────────────────────────────────┬───────┘
   │                    │ HTTP write-back                 │ read-only tail
   │ Python = sole      │                                 │
   │ writer             │                                 ▼
┌──┴───────────────┐  ┌─┴──────────────────┐   ┌──────────────────────────┐
│ Agent runtime    │  │ LedgerServer       │   │ Node services            │
│ (executor,       │  │ /append endpoint   │   │ services/dep-graph-builder│
│  workflow_graph) │  │                    │   │ tail.js → parser.js      │
└──────────────────┘  └────────────────────┘   └──────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Memory engine (Node, root) — MCP / REST surface over the same         │
│ JSONL→SQLite model. Public API: init/ingest/query/remember/getHistory │
└──────────────────────────────────────────────────────────────────────┘
```

### The one rule (the invariant)
**Python is the sole writer to the JSONL ledger. Everyone else reads it,
or writes back through the LedgerServer HTTP endpoint.** SQLite, the
control-plane timeline, and workflow graphs are all *projections* rebuilt
from JSONL. CI asserts: *every row in SQLite was first in JSONL.*

### The cross-runtime handoff (one concrete flow)
This is the whole system working as one:

1. A Python agent hits a `HandoffNode` → emits a `handoff_requested` event
   into the ledger (tagged `kalairos-dep-graph-builder`).
2. The Node service is tailing the JSONL, sees the event, parses the
   imports/requires of the changed files.
3. It `POST`s a `handoff_result` back to the Python `LedgerServer`.
4. The Python executor unblocks and feeds the dep graph into its next step.
5. Every step above is one ledger event — so the control plane renders the
   whole handoff, across both runtimes, as one traceable timeline.

---

## 3. Design choices & trade-offs

- **JSONL canonical, SQLite derived.** Human-readable, git-friendly,
  crash-recoverable truth; fast indexed reads. Cost: writes go two places,
  index can drift → ledger self-heals (marks dirty, rebuilds on boot).
- **Single writer (Python).** No write contention, no two-master conflicts;
  one append path to reason about. Cost: Node can't write directly — must
  round-trip through HTTP. Accepted: keeps the invariant trivially true.
- **Node services are stateless & read-only.** Easy to add, restart, scale
  out; resume from a byte offset. Cost: a down service stalls its handoff
  (mitigated by timeouts that fail the run rather than hang).
- **Two languages on one spine.** Python for the agent/control-plane work,
  Node for the memory library + JS-native workers (e.g. import parsing),
  joined only by the ledger + HTTP — not by shared in-process state.

## 4. What I'd revisit as it grows
- **Polling tail (500ms).** Fine now; swap for tail-follow or a notify
  channel if handoff latency matters.
- **HTTP write-back.** A single `LedgerServer` is a write funnel; revisit if
  many services write concurrently.
- **Two JSONL→SQLite implementations** (Node root + Python). Converging them
  on one schema contract avoids silent drift between runtimes.
- **Enterprise store.** Postgres + pgvector replaces JSONL/SQLite behind the
  same adapter contract — the spine rule must survive that swap.
