# Changelog

All notable changes to Kalairos. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Series supersession** for `metric`/`series` entities: a value with a
  strictly later `effectiveAt` retires the prior reading into a closed valid
  interval instead of flagging a contradiction (no trust penalty for
  legitimate drift). Same- or earlier-time value flips still contradict.
  `effectiveAt` is now accepted by the MCP `kalairos_remember` tool.

### Changed

- **Node.js >= 20 required** (`engines` was `>=18`). Node 18 is EOL
  (April 2025) and better-sqlite3 v12 — the hybrid-index engine since
  1.7.0 — supports Node 20+ only, so 1.7.0 already failed to install on
  Node 18 wherever a source build wasn't possible (e.g. Windows). CI now
  tests Node 20/22/24.

## [1.7.0] — 2026-05-11

Headline: **hybrid storage v1** — a SQLite index derived from the canonical
JSONL store, shipped behind `KALAIROS_INDEX_SQLITE=1`. Default behaviour is
unchanged; the index stays shadow-only until KAL-110 fuzz testing greenlights
flipping the default. JSONL remains the source of truth — if SQLite
disappears or diverges, the boot decision tree rebuilds or replays it
deterministically.

### Added

**Hybrid storage (opt-in via `KALAIROS_INDEX_SQLITE=1`):**
- `better-sqlite3` runtime dependency. Multi-platform CI exercises the native
  build on Linux, macOS, and Windows across Node 18 / 20 / 22 before any code
  uses it (KAL-100, KAL-101).
- `store/sqlite-index.js`: connection lifecycle, schema v1 (`facts`,
  `fact_versions`, `links`, `meta`) with FTS5 sync triggers, WAL +
  `synchronous=NORMAL` PRAGMAs (KAL-102, KAL-103).
- `rebuildFrom(jsonlPath)` — single-pass `readline` stream-rebuild with
  atomic `.rebuild → rename → fsync` for crash safety and orphan-tmp reaping
  on entry (KAL-104).
- Determinism test: rebuilds a 1000-row deterministic fixture twice and
  byte-compares the dumped contents — catches future UPSERT-order or hash
  drift at PR time (KAL-105).
- `decideOnBoot({ jsonlPath, sqlitePath })` — the §6.2 8-branch boot
  decision tree returning READY / REPLAY / REBUILD. Pure: read-only on
  SQLite, leaves both files byte-identical, returns a parseable log line
  (KAL-106).
- `replayForward({ jsonlPath, sqlitePath })` — applies only the JSONL bytes
  beyond `meta.last_jsonl_offset` in one `BEGIN IMMEDIATE` transaction
  (KAL-107).
- Live write-path under flag: `init()` runs `decideOnBoot` then auto-executes
  REBUILD / REPLAY / READY before serving writes. `_appendEntity` mirrors
  each row into SQLite via `applyEntity(row, lineStart, sizeAfter)`. JSONL
  remains canonical: if the SQLite txn throws, the write is still
  acknowledged, `meta.dirty=1` is set best-effort, and an
  `ERR_INDEX_WRITE_FAILED` signal fires (KAL-108).
- Same-session consistency on rewrites: `SqliteIndex.truncateAndReplay()`
  wipes + re-derives in one transaction so `forget`, `annotate`, `restore`,
  `ingestBatch`, and `consolidate` leave SQLite consistent without waiting
  for the next restart (KAL-109).
- `ERR_INDEX_WRITE_FAILED` error code with a "JSONL is canonical and the
  write is durable" suggestion message — guides users away from panic when
  the signal fires.

**Quality & CI:**
- Coverage reporting via `c8` (`npm run test:coverage`); Codecov upload on
  the Node 22 CI leg with a token for protected-branch pushes.
- Codecov and CI status badges in the README.
- `funding` field in `package.json` (GitHub Sponsors).

**Carried over from before the 1.5.0 / 1.6.0 changelog gap:**
- `LICENSE` file at repo root (MIT, matches `package.json`).
- `SECURITY.md` with vulnerability disclosure process.
- `CHANGELOG.md` (this file).
- Memory-poisoning benchmark wired into CI as a pass/fail gate.
- Latency-budget assertion in `bench/latency.js`; CI fails if p95 query
  latency at 10k entities exceeds the documented Stage-1 budget.
- `test-scope.js` now runs as part of `npm test`.
- HTTPS warning in `remote.connect()` when a non-loopback `http://` URL is
  used with a bearer token.

### Changed
- `engines.node` simplified to `>=18`.
- Entity normalization extracted to `store/entity-normalizer.js` so the
  SQLite rebuild path and the in-memory hot cache share the same
  legacy-data defaulting and version-backfill logic. Pure refactor — no
  behaviour change; full test suite passes byte-for-byte at the same
  counts as before.
- `store/file-store.js`: writes and appends now `fsync` before returning,
  honouring CLAUDE.md §18 durability claims.
- `store/file-store.js`: orphaned `.tmp` files left by a crash mid-rename are
  reaped on next load (canonical file is the source of truth).
- `_persistAll()` / `_appendEntity()` in `index.js` now re-throw on I/O
  failure instead of swallowing the error. Callers (typically `ingest()`)
  reject with the underlying error, surfacing the failure to the user instead
  of leaving in-memory state silently divergent from disk.
- `server.js`: `_validateText()` now defers to the core's `KALAIROS_MAX_TEXT_LEN`
  default (5 KB) instead of its own 50 KB cap. A request the server accepts is
  guaranteed to also pass core validation.

## [1.4.2] — 2026-04-23

### Added
- Audit trail: every change now leaves a breadcrumb; named checkpoints
  capture significant moments (`trail`, `checkpoint`, `getCheckpoint`,
  `listCheckpoints`).

## [1.4.1] — 2026-04-17

### Added
- LongMemEval benchmark runner with in-repo sample.
- Memory-poisoning benchmark suite (5/5 attacks defended at release).
- Latency-budget runner and published measurement (`BENCH.md`).

### Changed
- README rewritten around the 3-call flat API.
- Examples migrated off `createAgent()` to flat API + `scope()`.

## [1.4.0] — 2026-03

### Added
- `kalairos.scope()` as the canonical scoped-memory helper.
- `ERR_TEXT_TOO_LONG` validation on the ingest path.
- `forceNew` ingest option to bypass version-merge detection.

### Deprecated
- `createAgent()` — use `scope()` instead. Will be removed in 2.0.

## [1.3.0]

### Added
- Multi-signal trust scoring with provenance breakdown surfaced in query
  results.
- Hardening against source-spoofing and repetition attacks on trust.

## [1.2.0]

### Added
- Token-budgeted retrieval.
- Eval benchmark suite.
- MCP server (`kalairos-mcp` binary).
- Dual CJS/ESM exports for ESM-first runtimes (e.g. OpenClaw).

## [1.1.0]

### Added
- Auth and workspace ACL (token-based).
- `AgentMemory` class (later superseded by `scope()`).

## [1.0.0]

Initial public release of the Kalairos free edition: JSONL store, versioning,
graph linking, contradiction detection, and the core memory API.
