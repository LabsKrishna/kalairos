# Kalairos — Latency Budget & Measurements

This document records **reproducible** query-latency measurements against the JSONL file store. It exists to back the Stage 1 latency budget in `CLAUDE.md §5`:

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

Captured on an M-series macOS laptop, Node.js v23.

| Scale              | Queries | p50      | p95       | p99       | Mean     | Max       |
| ------------------ | ------- | -------- | --------- | --------- | -------- | --------- |
| 1,000 entities     | 500     | **10 ms**  | **25 ms**   | 35 ms    | 11 ms    | 54 ms     |
| 10,000 entities    | 300     | 117 ms   | 321 ms    | 1,378 ms | 153 ms   | 2,202 ms  |

Ingest throughput (for context, not budgeted):

- 1k entities: 0.39 ms/entity (389 ms total)
- 10k entities: 2.37 ms/entity (23.7 s total)

## Budget status

| Scale             | Target  | Current | Status |
| ----------------- | ------- | ------- | ------ |
| p95 at 1k         | < 50 ms | 25 ms   | **PASS** |
| p95 at 10k        | < 50 ms | 321 ms  | **MISS — ~6.4× over** |

### Interpretation

- **At Persona-A scale (1k entities)**, Kalairos comfortably meets the target. This is the scale that covers most indie / OSS-dev use cases today — a single agent accumulating memory across days or weeks.
- **At 10k**, query latency scales approximately linearly with corpus size — consistent with the current full-scan hybrid scorer (semantic + graph + keyword + recency) over every alive entity. The long tail (p99 > 1 s) is dominated by V8 JIT re-optimization and garbage collection on large candidate sets.
- **The 50ms-at-10k budget is therefore an unmet goal, not a regression.** Tracking it here makes the gap visible and prevents silent drift.

## Work queued against this budget

These are engineering directions; none are promised in Stage 1 unless the budget becomes a customer blocker.

1. **Vector-index shortcut for the top-k candidate set.** An HNSW / IVF index limits the hybrid scorer to ~200 candidates instead of all 10k. Expected p95 → ~20–40 ms at 10k.
2. **Cheaper keyword boost.** Current keyword overlap scans tokens per-entity per-query. Pre-computed inverted index would make this near-free.
3. **Lazy graph boost.** Graph-neighborhood boost is computed inside the hot path; it can be deferred until after candidate pruning.
4. **Embedding cache for hot queries.** Voice-agent territory (Stage 5), but the plumbing is the same.

Before shipping any of the above, we measure the **delta against this file** and amend the table. No "improves retrieval latency" claim ships without a new row here.

## What this is **not**

- Not a *quality* benchmark. Recall / precision / contradiction numbers live in `bench/agent-memory/` and are run via `npm run bench`.
- Not a claim about neural embedders. With real embeddings, ingest time is dominated by API round-trips; query time depends on whether embeddings are precomputed.
- Not a comparison to Mem0 / Zep / Letta. That lives in `bench/poisoning/` and `bench/longmemeval/`.
