# Changelog

All notable changes to Kalairos. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `LICENSE` file at repo root (MIT, matches `package.json`).
- `SECURITY.md` with vulnerability disclosure process.
- `CHANGELOG.md` (this file).
- Memory-poisoning benchmark wired into CI as a pass/fail gate.
- Latency-budget assertion in `bench/latency.js`; CI fails if p95 query
  latency at 10k entities exceeds the documented Stage-1 budget.
- `test-scope.js` now runs as part of `npm test`.
- HTTPS warning in `remote.connect()` when a non-loopback `http://` URL is
  used with a bearer token.
- `better-sqlite3` runtime dependency, ahead of the v1.7 hybrid storage
  index (KAL-101). The full feature ships behind `KALAIROS_INDEX_SQLITE=1`
  in a later release; set `KALAIROS_INDEX=off` to disable the index entirely
  if a later version enables it by default and you need the legacy code path.

### Changed
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
