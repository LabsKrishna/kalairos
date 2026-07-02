# Full Test & Benchmark Run — 2026-07-02

Snapshot of a complete run of every test suite and benchmark in the repo. Canonical latency/observability documentation (method, floors, CI gates) lives in [BENCH.md](../BENCH.md); this file records what a full sweep looked like on a given date so results are auditable over time.

**Environment:** macOS (darwin arm64, M-series), Node.js v23.7.0, Python 3 via pytest. Deterministic bag-of-words embedder everywhere — no network, no API keys. Machine-readable outputs: `bench/latency-results.json`, `bench/poisoning/results.json`, `bench/longmemeval/results.json`, `bench/agent-memory/bench-results.json`, `python/bench/observability-results.json`.

## Test suites

| Suite | Command | Result |
|---|---|---|
| Core (basic, versioning, temporal, supersession, agent-sim, scope, sqlite index + integration) | `npm test` | **all passing** (88 + 40 + 11 + 7 + 34 + 12 + agent-sim + scope) |
| Node services (dep-graph-builder) | `npm run test:services` | **18/18** |
| Python kernel (agent, control plane, executor, handoff, ledger, …) | `pytest` in `python/` | **407 passed, 1 skipped** |

Note: `npm test` initially failed on a stale `node_modules` (missing `better-sqlite3`); a clean `npm install` resolved it. Not a code issue.

## Benchmarks

### Agent-memory suite (`npm run bench`)

**75/75 assertions, 10/10 constitution goals passing (100%).**

| Goal | Score |
|---|---|
| Time-Aware Recall (asOf + recency) | 12/12 |
| Provenance & Audit Trail | 11/11 |
| Contradiction Detection & Visibility | 11/11 |
| Classification & Compliance | 3/3 |
| Agent-Friendly Durable Memory | 15/15 |
| Cross-Session Recall | 3/3 |
| Workspace / Tenant Isolation | 1/1 |
| Soft Delete & GDPR Purge | 4/4 |
| Error → Signal → Learning Loop | 3/3 |
| Metadata & Tag Evolution | 8/8 |

One bench expectation was updated in this run: `bench-eval.js` still asserted that time-separated value changes on a `metric` entity raise a contradiction. Since the series-supersession contract landed (`tests/test-series-supersession.js`), legitimate metric drift is recorded as supersession with **no** contradiction signal; the bench now asserts that contract (supersession present, zero contradictions on drift).

### Memory poisoning (`npm run bench:poisoning`)

**5/5 attack fixtures defended** — including drip-poison and trust-override. Every attack was contradiction-flagged, trust-penalized, history-preserved, and recoverable via `asOf`. Details in `bench/poisoning/results.json`.

### LongMemEval sample (`npm run bench:longmemeval`)

Bundled 6-question sample, substring scoring:

| Metric | Score |
|---|---|
| top1 | 50% |
| top5 (headline) | **100%** |
| route (right session retrieved) | **100%** |

This establishes the runner is wired correctly, **not** competitive standing — the full ~500-question dataset with a neural embedder and judge scoring has not been run (see gaps below).

### Query latency (`npm run bench:latency`)

| Scale | p50 | p95 | p99 | Budget (p95 < 50 ms) |
|---|---|---|---|---|
| 1k entities | 4.9 ms | **5.2 ms** | 5.4 ms | **PASS** |
| 10k entities | 54.7 ms | **64.8 ms** | 69.4 ms | **MISS — ~1.3× over** |

Big move since the last recorded measurement: the v1.7 SQLite hybrid index cut 10k p95 from 321 ms to 64.8 ms (~5×) and eliminated the >1 s tail (max: 2,202 ms → 70.6 ms). The 10k budget is now a near-miss, not a structural gap. See BENCH.md for the queued candidate-pruning work expected to close it.

### Observability (platform) (`python bench/observability.py`)

| Metric | Floor | Result |
|---|---|---|
| Observability completeness | 1.000 | **1.000 — PASS** (20/20 actions) |
| Cross-agent trace coverage | 1.000 | **1.000 — PASS** (1/1 handoffs) |

## What we measure — and what we don't yet

Honest scope of the current eval surface. Covered: factual recall (recall@k, precision@k, MRR), temporal reasoning (asOf, time-travel, drift), conflict resolution (contradiction + supersession), cross-session and multi-agent recall, knowledge updates, poisoning defense, latency to 10k, observability completeness, trace coverage.

Not yet measured:

1. **End-to-end agent performance** — no benchmark puts an LLM in the loop and scores task success with-memory vs. without. This is the number buyers ask for first.
2. **Full LongMemEval** — only the 6-question bundled sample runs routinely; no full-dataset, neural-embedder, judge-scored result exists yet.
3. **Real-embedding recall** — `npm run bench:real` exists but requires `OPENAI_API_KEY`; not part of this run. All numbers above use the deterministic bag-of-words embedder.
4. **Cost per operation** — no published tokens-per-query / API-calls-per-op number, despite the zero-LLM-calls-per-op design being a story Kalairos wins.
5. **Scale beyond 10k** — no 100k+ latency tier, no index construction-time metric.
6. **Forgetting quality** — delete/retention lifecycle is tested, but nothing evaluates whether stale facts stop surfacing after decay/eviction (Stage 4 territory).
7. **Replay determinism** — named in CLAUDE.md §17, not yet built (Phase 4.4).
