# Kalairos — Benchmarks (Latency & Observability)

This document records **reproducible** platform measurements and the floors CI gates against. Two families live here:

- **Latency** (this first section) — query latency against the JSONL store, backing the Stage 1 budget in `CLAUDE.md §5`.
- **Observability** ([jump](#observability-completeness--cross-agent-trace-coverage)) — observability completeness and cross-agent trace coverage, the platform benchmarks named in `CLAUDE.md §17`.

## Latency budget

> **Latency budget: p95 `query` under 50ms on JSONL with ≤ 10k entities.**

## Method

- Corpus seeded with a deterministic PRNG (`mulberry32(1234)`) so the same sentences are generated on every run.
- Embedder: deterministic bag-of-words, dim 64 — no network, no API key.
- Store: in-memory equivalent (`dataFile: ":memory:"`) — disk I/O excluded so these are pure engine-time numbers. Disk-backed numbers are bounded from below by these.
- 20 warm-up queries discarded; then N queries timed with `process.hrtime.bigint()`.
- Query shape: 4-word random sentence, `limit: 10`, no `asOf`, no filter.

Run it yourself:

```bash
node bench/latency.js
# or
npm run bench:latency
```

Output is printed as a table and persisted to `bench/latency-results.json`.

## Current measurements

Captured 2026-07-02 on an M-series macOS laptop (arm64), Node.js v23.7.0.

| Scale              | Queries | p50      | p95       | p99       | Mean     | Max       |
| ------------------ | ------- | -------- | --------- | --------- | -------- | --------- |
| 1,000 entities     | 500     | **4.9 ms** | **5.2 ms** | 5.4 ms   | 4.3 ms   | 5.7 ms    |
| 10,000 entities    | 300     | 54.7 ms  | 64.8 ms   | 69.4 ms  | 49.8 ms  | 70.6 ms   |

Ingest throughput (for context, not budgeted):

- 1k entities: 0.15 ms/entity (145 ms total)
- 10k entities: 0.96 ms/entity (9.6 s total)

Previous measurement (pre-SQLite-index, kept for the delta per the rule below): 1k p95 25 ms; 10k p95 321 ms with a p99 above 1 s. The hybrid SQLite index (v1.7) cut p95 at 10k by ~5× and collapsed the GC-driven long tail (max fell from 2,202 ms to 71 ms).

## Budget status

| Scale             | Target  | Current | Status |
| ----------------- | ------- | ------- | ------ |
| p95 at 1k         | < 50 ms | 5.2 ms  | **PASS** |
| p95 at 10k        | < 50 ms | 64.8 ms | **MISS — ~1.3× over** (was 6.4× pre-v1.7) |

### CI enforcement

The CI workflow runs `bench/latency.js` with the budget assertion enabled:

```bash
KALAIROS_LATENCY_BUDGET_ENFORCE=1 \
KALAIROS_LATENCY_BUDGET_P95_MS_AT_1K=150 \
node bench/latency.js
```

The CI threshold (150 ms at 1k) is intentionally slacker than the published
target (50 ms) because shared GitHub runners are noisier and slower than the
M-series laptop the headline numbers were captured on. The job exists to catch
*regressions*, not to re-litigate the laptop number on every PR. If the budget
needs to change, amend `.github/workflows/ci.yml` and document the new number
in this table.

The 10k row is **not** gated — it's a known unmet aspiration tracked in the
"Work queued against this budget" section below.

### Interpretation

- **At Persona-A scale (1k entities)**, Kalairos meets the target with an order of magnitude to spare. This is the scale that covers most indie / OSS-dev use cases today — a single agent accumulating memory across days or weeks.
- **At 10k**, latency still scales with corpus size — the hybrid scorer (semantic + graph + keyword + recency) ranks every alive candidate the index returns — but the SQLite index removed the pathological tail: p99 is now within 7% of p50 instead of 25× above it.
- **The 50ms-at-10k budget remains a near-miss (64.8 ms), not a regression.** Tracking it here makes the gap visible and prevents silent drift; the candidate-pruning work below is what's expected to close the last ~15 ms.

## Work queued against this budget

These are engineering directions; none are promised in Stage 1 unless the budget becomes a customer blocker.

1. **Vector-index shortcut for the top-k candidate set.** An HNSW / IVF index limits the hybrid scorer to ~200 candidates instead of all 10k. Expected p95 → ~20–40 ms at 10k.
2. **Cheaper keyword boost.** Current keyword overlap scans tokens per-entity per-query. Pre-computed inverted index would make this near-free.
3. **Lazy graph boost.** Graph-neighborhood boost is computed inside the hot path; it can be deferred until after candidate pruning.
4. **Embedding cache for hot queries.** Voice-agent territory (Stage 5), but the plumbing is the same.

Before shipping any of the above, we measure the **delta against this file** and amend the table. No "improves retrieval latency" claim ships without a new row here.

## Observability completeness & cross-agent trace coverage

The platform half of `CLAUDE.md §17`. Memory benchmarks ask "did we recall the right fact?"; these ask "could you *see* what the agent did, and trace a handoff end-to-end?" — the headline promises of §11.7 ("No silent execution") and §11.8 (cross-agent handoffs are first-class).

> **Observability completeness** — the fraction of agent actions (lifecycle, node transitions, tool calls, branch decisions, handoffs) that surface as ledger events the control plane can read back.
>
> **Cross-agent trace coverage** — the fraction of handoffs reconstructible end-to-end from the ledger alone: **caller, callee, payload, outcome** (§11.8).

### Method

- Runner: `python/bench/observability.py`. No real LLM, no network — fully deterministic.
- Reference workload: an `Executor` walking a fixed `WorkflowGraph` (the same shape as the Phase 3 PR-risk analyzer — fetch → assess → route → handoff to the Node dep-graph service → summarize) plus a hand-driven run whose tool raises, so the failure path is measured too.
- The cross-runtime handoff is answered by an in-process auto-reply thread that mimics a Node service POSTing a `handoff_result` to `LedgerServer` — so the handoff and its trace are exercised for real, not stubbed past.
- **Completeness is not computed circularly.** The *expected* action set is derived from the graph topology + the declared execution path (the workload's definition); the *present* set is derived from what `control_plane.events_for_run` actually surfaces. Completeness = `|present ∩ expected| / |expected|`.

Run it yourself:

```bash
cd python
python bench/observability.py          # print the table
python bench/observability.py --check   # assert floors, exit 1 on a miss
```

Output is printed as a table and persisted to `python/bench/observability-results.json`.

### Current measurements & floors

| Metric | Floor | Current |
| ------ | ----- | ------- |
| Observability completeness | 1.000 | **1.000 — PASS** |
| Cross-agent trace coverage | 1.000 | **1.000 — PASS** |

### Why the floor is 1.0 (and how it relates to §25's 95%)

On our **own reference fixture** the platform emits every action it takes — so the floor is exactly `1.0`. Anything below it is a silent-execution *bug*, not a tuning knob; the benchmark's sensitivity check (drop one event → score falls below the floor) proves the metric can actually catch that.

`CLAUDE.md §25`'s *"observability completeness ≥ 95%"* is a different, looser target measured against a **customer's** workload, where the customer's own agent code may do work the platform never instruments and therefore can't see. Our reference fixture must be exact; the 95% is the bar for a real design-partner deployment.

### CI enforcement

The `python` job in `.github/workflows/ci.yml` enforces this two ways: `pytest` runs `tests/test_observability_bench.py` (which asserts both floors plus the sensitivity checks), and a named `python bench/observability.py --check` step prints the table and fails the build on a miss. Per §17, a merge that drops either metric below its floor requires written justification on the PR.

## What this is **not**

- Not a *quality* benchmark. Recall / precision / contradiction numbers live in `bench/agent-memory/` and are run via `npm run bench`.
- Not a claim about neural embedders. With real embeddings, ingest time is dominated by API round-trips; query time depends on whether embeddings are precomputed.
- Not a competitor comparison. Kalairos benchmarks report Kalairos's own numbers on reproducible workloads (`bench/poisoning/`, `bench/longmemeval/`); we position by differentiation, not "vs. X" scorecards.
