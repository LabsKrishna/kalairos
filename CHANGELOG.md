# Changelog

All notable changes to Kalairos. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Lock-down for the HTTP server.** `KALAIROS_REQUIRE_AUTH=1` makes the
  server refuse to start unless auth is on with at least one owner, and
  makes `POST /auth/disable` return 403. Any value other than `1`, `0` or
  empty stops the boot instead of reading as off. `KALAIROS_ADMIN_TOKEN`
  bootstraps the first owner, so a container can come up locked with no
  manual step: on a store with no principals, the server creates `admin`,
  an owner of `default` and of every workspace already in the store, with
  that token, and enables auth. The token must be at least 32 characters
  with no whitespace, and is never logged or saved in plaintext. Once any
  principal exists the variable is ignored. `GET /auth/status` now reports
  `required`.
- **Auth state through the store.** A store with `loadAuth(config)` and
  `saveAuth(state, config)` keeps auth state itself, in place of
  `<data file>.auth`. `loadAuth` returns (or resolves to) what `saveAuth`
  was last given, or null. `saveAuth` must be synchronous, like
  `persistAll`: return once the state is durable, throw if it can't be. A
  `saveAuth` that returns a promise fails the change. `state` is plain JSON
  with token hashes only. `kalairos.auth.transaction(fn)` makes several auth
  changes one save, undone together if anything in it throws.
- **Prior-authorization replay benchmark** (`npm run bench:prior-auth`,
  CI-gated). Replays synthetic prior-authorization decisions after late
  records, reversals, corrections and policy revisions have landed, and
  checks that `queryAt` shows only what the reviewer had, `queryValidAt`
  shows what was true (including records that arrived late), the policy in
  force on the request date comes back, the decision-day checkpoint is
  intact, and authorship survives. Every floor is exact and met. A control
  run on current state proves the leakage metric can see a leak.
  `node bench/prior-auth/case.js` narrates the reference case. See
  `bench/prior-auth/README.md`.
- **Keys, fields and links.** `ingest()` and `remember()` take `key`,
  `fields` and `links`. A keyed write's identity is its workspace, `type` and
  `key`: it lands on that record however it is worded, never merges with
  another key, and neither unkeyed writes nor `consolidate()` land on it.
  `key` with `forceNew` is refused.
  `fields` holds structured facts beside the text. They version with it,
  carry forward when a write leaves them out, and a keyed write compares them
  exactly, recording `delta.fields` as `{ name: { from, to } }`. A field
  change from the key's holder is a revision when it takes effect later and a
  correction when it restates the same moment; neither is a contradiction.
  `links: [{ rel, to, one? }]` points a keyed thing at another by address
  (`"type:key"`). Each link is its own keyed record of type `link`, with
  versions, provenance and trust, written in one write with the thing, so
  the two land or roll back together;
  `one: true` keys it on the thing and `rel`, so pointing it elsewhere
  versions the same link. Link records stay out of search. Query results,
  `get()`, `getMany()` and `listEntities()` include `key` and `fields` (null
  when absent), and `getHistory()` versions include `fields`.
- **`describe(address, { asOf, validAt })`** returns one keyed thing and what
  it links to and from, read on both clocks at once: what was true at
  `validAt`, as known at `asOf`. Links resolve on the same clocks, so a link
  never pins a version. Also on `scope()`, which reads its own workspace.
- **Contested writes.** A change to a key from any source other than the one
  that last set it uncontested, or a source type trusted more, lands with
  `delta.contested`, a contradiction at severity 0.7, and a `contested` trail
  event naming both sources. It can lower the base trust but not raise it,
  whatever `trustScore` it names. Repeating what the key already says is
  corroboration, not a contest, and doesn't take the key over. The poisoning
  benchmark gains a `key-overwrite` attack: defended, 6/6, and compromised
  with the rule switched off.
- **Keys over MCP.** `kalairos_remember` and each `kalairos_batch_store`
  item take `key`, `fields` and `links` (batch items also take
  `effectiveAt`). The new `kalairos_describe` tool takes an `address`
  (`"type:key"`) with optional `asOf`, `validAt` (Unix ms or ISO-8601) and
  `workspaceId`, and returns what `describe()` returns. Unlike
  `kalairos_recall`, `asOf` and `validAt` combine.
- **Keys over HTTP.** The write routes (`POST /ingest`, `/remember`,
  `/ingest/batch` and a scope's `/agent/:id/remember`) take `key`, `fields`
  and `links`. `GET /describe?address=type:key` takes optional `asOf`,
  `validAt` (Unix ms or ISO-8601) and `workspaceId`, needs read access to that
  workspace, and answers `null` when the thing isn't there on those clocks.
  The remote client calls it as `describe(address, { asOf, validAt,
  workspaceId })`.
- **Keys through markdown.** `exportMarkdown()` writes a keyed thing's `Key`
  and `Fields` lines and `importMarkdown()` reads them back, so an import
  lands each section on its `type` and `key` with its fields. A link is a
  keyed record of type `link` whose fields hold `{ from, rel, to }`, so it
  comes back as a link that `describe()` reads, and a later write to it
  versions the imported record. A `Fields` line that isn't a JSON object
  fails the import before anything is written, and `importMarkdown()`
  refuses `key`, `fields` or `links` in its defaults. Only the current
  version travels, and an import writes every section to one workspace.

### Changed

- **The last owner can't be removed or demoted while auth is on.**
  `DELETE /auth/principals/:id`, `POST /auth/revoke` and `POST /auth/grant`
  return 400 when they would leave no principal with the owner role. A
  restart used to undo that lock-out by switching auth off; now that auth
  state survives a restart, nothing would.
- **With a data file, `init()` loads the saved auth state**, replacing any
  auth state set up in memory before it, and `kalairos.auth` changes are
  saved as they are made. With `dataFile: ":memory:"` auth stays in memory,
  as before.
- **The Docker build context leaves out `data.kalairos.*`** (auth state,
  checkpoints, the SQLite index) as it already left out `data.kalairos`, so
  an image built from a working checkout carries none of its auth state.
- **The prior-auth replay writes every record with its key.** It no longer
  needs `forceNew` on first writes or lowered version and consolidation
  thresholds. Identity misses stay at 0, and every metric matches the run
  before the change.
- **MCP writes name their agent.** Every write through `kalairos-mcp` is
  attributed to `{ type: "agent", actor }`, with `who.agent` on its trail
  events. The actor is `KALAIROS_MCP_AGENT`, or else the name the host gives
  in the MCP handshake (for example `claude-code`). `kalairos_remember` used
  to write as an unnamed agent (trail: "anon"), so no MCP agent could contest
  another's change to a key. `kalairos_batch_store` and
  `kalairos_extract_facts` used to write as the user, with the user's default
  trust (0.90 rather than an agent's 0.75).
- **`importMarkdown()` takes each section's type from its `Type` line**,
  which keeps its case, instead of lowercasing the `## [id] TYPE` header.
  Type is part of a key's identity, so `priorAuth:PA-1001` used to come back
  as `priorauth:PA-1001`.

- **`kalairos-mcp` loads the engine on the first tool call.** The server
  used to run `init()` before it answered the handshake, so it read the
  whole store, loaded the embedder and started a worker thread per CPU
  whether or not its client ever called a tool. Hosts such as Claude Code
  start a server per session, and most sessions never call a memory tool.
  Measured on macOS with 10 CPUs and a 30-entity store, an idle server with
  the neural embedder now holds **35MB instead of 318MB**, runs 7 threads
  instead of 26, and answers `initialize` in 101ms instead of 275ms. With
  bag-of-words it holds 35MB instead of 111MB. The first tool call pays for
  the load instead: 213ms with the neural embedder and 31ms with
  bag-of-words, against 17ms and 5ms before. Later calls take what they
  took before. Calls that arrive while the engine loads share that one
  load. A load that fails, such as an unreadable store, is now that call's
  tool error and the next call tries again; it used to stop the server at
  boot.

### Fixed

- **Auth survives a restart.** Principals, token hashes, whether auth was on
  and the auth audit log lived only in memory, so a restarted server came
  back with auth off and served every memory to anyone who could reach the
  port. The Docker image listens on all interfaces, so that was the network.
  Auth state is now saved to `<data file>.auth` (mode 0600), replaced the
  way the data file is: tmp file, fsync, rename, fsync the directory.
  `init()` loads it, and an unreadable one stops `init()` rather than
  starting with auth off. Each auth change is saved with its audit entry
  before the response; a change whose save fails returns 500
  `ERR_PERSIST_FAILED` and leaves memory and disk as they were. The saved
  audit log is the in-memory one, bounded the same way (newest 1,000
  entries). Audit entries for data writes are saved with the next auth
  change and at shutdown, so a crash can lose the ones recorded since. A
  server that never set auth up writes no file.
- **Importing an `includeHistory` export keeps each entity's text.** The
  numbered version-history lines were read as part of the text, so
  `kalairos export --include-history` followed by `kalairos import`, the
  README's own example, appended every past version to the current one.
- **`ingestBatch()` keeps each item's `effectiveAt`, `importance`, `who` and
  `why`.** It dropped them, so a batched fact took effect when it was
  ingested rather than when it became true, and `POST /ingest/batch` couldn't
  backdate anything.
- **`shutdown()` finishes when a query is in flight.** A scoring job's reply
  that landed while `shutdown()` was stopping the worker pool unref'd that
  worker, so Node could exit before the worker did: `shutdown()` never
  returned, and the store and the SQLite index were never closed.
  `tests/test-cpu.js` covers this, but when it happened the test exited 0
  partway through, so `npm test` passed with four tests skipped. It now fails
  when it exits early.
- **`queryAt` trust is point-in-time.** A replay used to score trust against
  the entity's full version history and its current annotations, so a
  contradiction, correction or annotation recorded after `asOf` changed the
  trust a past answer reported, and its breakdown cited it. `trust`,
  `trustScore` and `trustBreakdown` from `queryAt(text, asOf)` now come from
  what had been recorded by `asOf`: the versions ingested by then, recency
  from the version returned (and any reaffirm by then), the base trust score
  as it stood then (rewound through every recorded change to it since),
  and the returned version's content-risk verdict, with a reviewer's override
  only if it was made by then. In the prior-auth benchmark, trust drift fell
  from 40% of cases (max Δ 0.27) to 0 and trust citing later contradictions
  from 30% to 0; both are now gated floors. `queryAt` results' `trustScore`
  is now that base, matching `trustBreakdown.base`; it used to be the source
  default of the returned version. A `queryRange` with a finite `until`
  scores the same snapshot as `queryAt(until)`, so its trust follows.
  `query()` output is unchanged, and `queryValidAt` deliberately keeps trust
  from everything known now: it asks what was true, with today's knowledge.
- **A `trustScore` passed to `ingest()` is recorded.** On an update or a
  reaffirm it used to overwrite the stored base without keeping the value it
  replaced, so a `queryAt` replay from before that write reported the newer
  base. The write now records `diff.trustScore = { from, to }`, the shape
  `annotate()` already uses: on the new version for an update (in
  `getHistory()` and on that version's `trail()` event), and on the
  `reaffirmed` trail event for a reaffirm. A write that leaves the base
  unchanged records nothing, so its version and trail event look exactly as
  before.
- **An open-ended `queryRange` works.** A missing bound is documented as
  open-ended, but `null` went through `Number()` and became 0, so
  `queryRange(text, since)` and `queryRange(text, since, null)` threw
  "since must be <= until" for any real timestamp. The same happened over
  REST (`POST /query` and agent recall with only `since`), where a missing
  `until` arrives as `null`. A missing `since` was 0 rather than -Infinity,
  which dropped anything stamped before 1970. Both bounds are now
  open-ended when omitted.
- **A write acknowledged during a batch is on disk.** While `ingestBatch()`,
  `extractFacts()` or `importMarkdown()` was running, every write in the
  process skipped its own fsync, not only the batch's items. A `remember()`
  from another caller (or `kalairos_remember` over MCP while
  `kalairos_batch_store` ran) resolved with its id while the row sat in
  memory until the batch's final flush, so a crash or SIGKILL in that window
  lost a write the caller had been told was stored. The same held for a
  delete, for concurrent writes coalesced into one flush, and for a second
  batch that finished while the first was still running. Only a batch's own
  items now wait for its single flush; every other write reaches the JSONL
  file, and the SQLite index when enabled, before it is acknowledged.
- **`shutdown()` runs queued writes before its final flush.** A write already
  queued behind the write lock when `shutdown()` started ran only if tearing
  down the worker pool happened to yield to the event loop first. With a pool
  that stopped at once, `shutdown()` resolved with the write still queued and
  a following `init()` dropped it. Queued writes now run first, while the
  store is open.
- **A failed flush for coalesced writes rejects them.** Two or more writes
  that reach the write lock in the same tick share one flush. When that flush
  failed on the default file store (a full disk, say), the error escaped the
  write queue as an uncaught exception, none of those writes' promises ever
  settled, and the queue stayed marked busy, so no later write ran either.
  Each of those writes now rejects with the persist error, as a lone write's
  already did, and the queue keeps taking writes. Writes still share a single
  flush and still settle only after it.
- **A write that failed to persist no longer reaches disk later.** A write
  whose persist failed (a full disk, say) rejected, but what it had changed
  stayed in memory. Reads served it, and the next flush, which rewrites the
  whole JSONL file from memory, put it on disk along with some later,
  unrelated write, so a reload brought back a write the caller had been told
  failed. This held for a lone write and for writes coalesced into one flush.
  A write that rejects now leaves memory as it found it: every entity it
  changed, created or removed is restored, including its versions, trail
  events and the links on its neighbours, before the next write runs. Other
  writes are untouched, so a batch running at the same time keeps its items.
- **A failed append no longer leaves bytes in the JSONL file.** Adding a row
  writes it, then fsyncs it. When either step failed, the write rejected but
  what had reached the file stayed there. A row cut off partway (a full
  disk, say) had no newline, so the next successful append joined onto it
  and a reload skipped the joined line as malformed. The row lost was that
  next one, which had been acknowledged. A whole row whose fsync failed came
  back on reload. A short write, where fewer bytes land than were asked for
  and no error is raised, was not checked at all, so a torn row was
  acknowledged. A failed append now truncates the file back to its size
  before the write and rethrows the original error, and a short write keeps
  writing until the row is out or the disk reports an error.
- **A full rewrite of the JSONL file can no longer truncate it.** Updates,
  deletes, batches and `shutdown()` rewrite the whole file: they write a
  temp file and rename it over the store. That write was one call whose byte
  count was ignored, so when the disk filled partway, the torn temp file was
  fsync'd and renamed into place, and every row past the cut was gone on the
  next start. The rewrite now keeps writing until the whole file is out, or
  throws the disk's error and leaves the store as it was.
- **A crash in the middle of an append no longer costs the next row.** A
  process that dies while adding a row can leave part of it at the end of
  the file, with no newline. A reload skipped it, but the next append joined
  onto it, so that row, which was acknowledged, was skipped on the reload
  after. The same held for a whole last row that never got its newline: it
  loaded, then the next append took both down. An append now checks the
  file's last byte and starts on a new line when it is not a newline, with a
  warning. The partial row stays in the file and loads keep skipping it
  until the next full rewrite drops it.
- **A batch op that fails leaves nothing behind.** `ingestBatch()`,
  `extractFacts()` and `importMarkdown()` wrote their items one at a time and
  flushed once at the end. When that flush failed, or an item was rejected
  partway (text over `maxTextLen`, or a workspace the caller may not write),
  the call rejected, but the items written before it stayed in memory. Reads
  served them and the next flush put them on disk. Other writes run while a
  batch waits on each embedding, so one of those could also flush the batch's
  first items to disk before the batch had finished. A batch op now prepares
  every item first and then applies them all in one write, with one flush.
  None of its items can be read, or written to disk by another write, until
  it resolves. If it rejects, memory and disk are as they were before it.
  Items still apply in order, so a later item can update an earlier one, and
  writes made while a batch is being prepared are kept either way. This makes
  `ingestBatch()` atomic, as its documentation already said. One cost: a
  batch's items now apply in a single synchronous step, so reads wait for the
  whole batch rather than for one item at a time.
- **`kalairos-mcp` exits when its client goes away.** The stdio server had
  no shutdown path: nothing listened for stdin ending, and SIGTERM and
  SIGINT went unhandled, so it ran until its event loop emptied on its own.
  On 1.9.0 that never happened, because the worker pool's idle threads held
  the loop open, and servers whose client had exited kept running for days
  at about 260MB each. The server now shuts down when stdin ends or closes,
  when its transport closes, and on SIGTERM or SIGINT. It stops reading
  requests, lets tool calls already running finish, so a write sent just
  before the client left still lands and is answered, flushes the store,
  and exits with code 0. A shutdown that stalls is cut off after 5 seconds
  with code 1.
- **`kalairos-mcp` keeps the last write of a client that vanishes
  mid-request.** A host that crashes closes stdin, stdout and stderr at
  once. The engine logs as it writes, so a log line hit the closed stderr,
  and the unhandled `EPIPE` killed the server before the write reached
  disk; a reply to the closed stdout could do the same. Failed writes to
  stderr are now ignored, a failed write to stdout starts the shutdown
  above, and the write lands.

### Known issues

- **Some base trust changes cannot be replayed.** Annotations and reaffirms
  dropped by a `maxTrailEvents` cap, and `ingest()` trust changes written
  before this release, carry no record of the value they replaced, so a
  `queryAt` replay from before them reports the newer base. Every other
  change is reconstructed exactly.

## [1.9.1] — 2026-10-13

Headline: **a fresh install now works the way the README says it does.**
Installing from npm and running the quickstart, the MCP server and the HTTP
server turned up a set of failures that the test suite never exercised. The
largest: no install had ever downloaded the neural embedder, so every npm user
was running on bag-of-words, where paraphrased questions return nothing and an
update worded differently from the fact it replaces never becomes a version.

### Security

- **The `/auth/*` routes required no authentication.** With auth enabled, an
  anonymous caller could create an owner principal (and receive its token) or
  call `POST /auth/disable` and then read everything. Once auth is on, every
  `/auth/*` route except `/auth/status` now needs an owner token, and an owner
  can grant, revoke, create or remove principals only on workspaces it owns.
  Disabling auth needs an owner of every workspace. Enabling auth is refused
  until an owner principal exists, so it cannot lock every caller out.
  Re-adding an existing principal id is refused instead of silently replacing
  its roles while its old token kept working. Audit entries for these actions
  now record who performed them.
- **The HTTP server binds `127.0.0.1` by default** (was `0.0.0.0`). Auth is off
  until enabled, so the old default exposed the whole store to the network.
  Set `KALAIROS_HOST=0.0.0.0` to serve remotely; the Dockerfile does. The
  server warns at startup when it listens beyond loopback with auth off.
  **Behavior change:** a remote deployment that relied on the old default must
  now set `KALAIROS_HOST`.

### Fixed

- **The neural embedder was never downloaded.** postinstall requested
  `releases/download/v<version>/model_int8.onnx`, an asset no release has ever
  carried, and failed silently. It now fetches the published `v1.6.0/model.onnx`
  and always verifies a pinned SHA-256, before the file becomes visible as
  `model.onnx`, not after. `KALAIROS_MODEL_DIR` is now also where the embedder
  looks, not only where the downloader writes.
- **Stores written by another embedder are re-embedded on startup.** Vectors of
  a different width (a bag-of-words store opened once the model is present, or
  a switched provider) could not be compared with queries. Cosine over
  mismatched arrays returned NaN, which passed every score floor, so old
  memories surfaced with `score: null` or not at all. `init()` now re-embeds
  entity and version vectors from their stored text when the embedding width is
  known (the built-in embedders, or `init({ embedFn, embeddingDim })`). Cosine
  scores mismatched widths as 0 instead of NaN.
- **The MCP server corrupted its own transport.** `query()` timed itself with
  `console.time`, which prints to stdout, the JSON-RPC channel, so every
  `kalairos_recall` wrote a non-protocol line into the stream. Overlapping
  queries also collided on the shared timer label. The MCP server now reports
  the package version instead of `1.0.0`.
- **Scripts that never called `shutdown()` hung forever.** Idle worker threads
  held the process open. They are now unref'd while idle and only hold the
  process while a job is in flight. Writes were already durable without
  `shutdown()`.
- **`npm start` ignored `KALAIROS_DATA_FILE`.** The CLI and MCP server honored
  it, but the HTTP server opened `./data.kalairos` regardless. `init()` now
  defaults to it.
- **`kalairos import` wrote unsearchable memories.** It embedded with a private
  64-dim embedder whose vocabulary depended on encounter order, so nothing it
  imported could be found by the server. It now uses the default embedder.
  `kalairos export` loads no embedder at all.
- **README examples failed as written.** Both full examples used a toy
  embedder that scores almost any two sentences as similar: the quickstart
  merged unrelated facts into one entity, and the compliance audit crashed on
  an empty result. The quickstart also combined `require()` with top-level
  `await`, which runs in no Node module type. Both now use the default
  embedder, and the quickstart uses `import`.
- The HTTP server no longer advertises a dashboard at `/` that does not exist.

### Added

- **`kalairos model [--force]`** downloads the neural embedder on demand, for
  installs that skip postinstall (pnpm and bun by default, `--ignore-scripts`,
  CI). When the model is missing, `init()` now says what that costs and names
  this command.

### Changed

- **`better-sqlite3` is an optional dependency.** It backs the opt-in SQLite
  index (`KALAIROS_INDEX_SQLITE=1`) and is a native addon, so a missing
  prebuilt binary or toolchain used to fail `npm install kalairos` outright.
  Enabling the index without it now raises an error naming the fix.

## [1.9.0] — 2026-09-08

Headline: **the second time axis, and four unbounded-growth paths closed.**
`validAt` answers what was actually true on a date, not merely what we had
recorded by then — two different questions, of which the engine only ever
answered one. Alongside it, ingest gained a content-risk signal that fires on first
touch, and four places where a long-running process grew without limit are now
bounded.

**Note for npm users:** 1.8.0 was tagged but never published to the registry,
so the last release you can install is 1.7.0. Everything in the 1.8.0 entry
below ships here — including the three workspace-isolation fixes that close
cross-tenant leaks on the write path.

### Added

- **Event-time queries — `query(text, { validAt })` and `scope.queryValidAt()`.**
  `asOf` travels *ingest* time: the state we had recorded by a date, so a fact
  learned later is invisible even if it was already true. That is the auditor's
  question. `validAt` travels *event* time: what was actually in force in the
  world on that date. A fact recorded with a backdated `effectiveAt` gives the
  two axes genuinely different answers. Versions are ordered by `effectiveAt`,
  each valid until the next distinct greater one, with `ingestAt` breaking ties
  so the most recently learned correction wins a same-instant conflict.
  Supplying both axes at once is an error rather than a silent precedence rule.

- **Content-risk scoring at ingest — opt-in `contentRiskFn`.** Every other
  trust signal is structural: it reasons about the shape of an entity's version
  history — source type, corroboration, contradictions, recency. None inspect
  what the claim actually says, which leaves a specific hole. A poisoned fact
  that arrives cleanly (first assertion about an entity, plausible source,
  nothing yet to contradict it) scored base × recency and passed at full trust.
  The verdict is stored on both the entity and the version record and folds
  into the composite as a bounded, monotonic multiplier. Off by default: no
  detector configured means no network call and a multiplier of exactly 1.0.

- **Structural poison detection (`directive-shape.js`)** — deterministic,
  offline, no model. Poisoned "facts" share a shape: they are imperatives aimed
  at whoever reads them next. The discriminator against reported speech ("the
  phishing email instructed the employee to disable MFA") is not whether a
  command is present but whether it is addressed to the reader or reported
  about someone else. Held-out recall 0.67, false positives 0.00, and evasion
  recall 0.00 — the limit is published rather than discovered later. Ships in
  the free tier.

- **`maxTrailEvents` / `KALAIROS_MAX_TRAIL_EVENTS`** — companion cap to
  `maxVersions` for the provenance trail. See *Fixed* below.

- **`DELETE /agent/:agentId`** on the REST server, to release a handle created
  by `POST /agent/create`. Drops the server-side handle only; memories the
  agent wrote belong to the engine and are untouched.

### Changed

- **Embeddings are cached across calls.** Embedding is the one genuinely
  expensive step on both hot paths — a full ONNX forward pass locally, or a
  network round trip on a hosted embedder — and it is a pure function of
  (text, type, embedder). Nothing remembered it: re-running a query re-embedded
  the query, and re-ingesting identical content re-embedded it before
  recognising it as a duplicate — idempotent, but idempotent at full price. Against the real 768-dim neural embedder, four distinct
  queries asked six times each: **277ms → 45ms** (11.6ms → 1.9ms per query),
  hit rate 0.72. Bounded LRU, 256 entries by default (~2MB);
  `KALAIROS_EMBED_CACHE=0` disables it. Failed embeds are never cached, so a
  retry is a real retry.

- **The JSONL store loads in chunks rather than all at once.**
  `readFileSync(...).split("\n").filter(Boolean)` held three complete copies of
  the store alive simultaneously — the decoded string, the split array, the
  filtered array — before a single row was parsed. That transient, not the
  resident store, is what kills a small container: the process dies inside
  `init()` before it binds a port, so the platform reports a restart and the
  application log has nothing to say about it.

### Fixed

- **A dead worker thread no longer leaks the queue behind it.** A worker exit
  nulled its slot and gave up: the index stayed in `_idle` so the dead slot kept
  being handed out, nothing respawned so the pool shrank toward zero, and
  `run()` queued into an unbounded array. Once nothing was alive, every query
  parked a job nothing could drain — and each job pins its whole payload, one
  chunk of candidate entities carrying full text and full embedding vectors.
  Terminating both workers of a 2-worker pool and issuing 25 queries retained
  **285.1MB**; it now retains **0.0MB**. The caller side was worse than the
  memory: `_scoreParallel` awaits these, so a stuck job hung `query()` forever,
  and in the REST server that pinned the request and response objects with it.
  `stop()` then cleared the queue without settling it, leaving 48 of 50 callers
  on a promise nothing would ever resolve.

  Dead workers are now replaced (the likely cause is an OOM kill on a small
  container, not a bug in `worker.js`), with a respawn budget so a worker that
  crashes at startup cannot loop forever. `_idle` only ever holds live slots.
  The wait queue is bounded and reports backpressure as
  `ERR_WORKER_QUEUE_FULL`. `run()` fails fast when nothing is alive, and
  `stop()` rejects queued and in-flight jobs instead of dropping them. New
  knobs: `KALAIROS_WORKER_QUEUE_MAX` (256), `KALAIROS_WORKER_MAX_RESPAWNS` (32).

- **The provenance trail grows without limit.** `maxVersions` has capped
  `versions[]` since it was added; `trailEvents[]` had no cap, no knob and no
  default — and it grows on a separate axis. `annotate()` writes no version at
  all and still appends a trail event, so a store whose content never changes
  once could still grow forever. 2000 `annotate()` calls against one entity,
  with versions held at 1: **2000 events / +1.22MB heap / 740KB of JSONL for a
  single entity**, now **100 / +0.41MB / 60KB** under `maxTrailEvents: 100`.

  The default is `0` (unlimited), matching `maxVersions` and matching what an
  audit trail is for — dropping the oldest records by default would undercut
  the append-only guarantee the compliance story rests on. The knob is for
  memory-constrained deployments that opt out knowingly; leaving it unset is
  byte-identical to previous behaviour.

- **Agent handles on the REST server were never released.**
  `POST /agent/create` wrote into a map nothing ever deleted from. Each entry is
  a thin `MemoryScope` wrapper — the memories live in the engine — so it is a
  slow drip rather than a fast leak (4000 handles did not move RSS out of the
  noise), but it is still a client-controlled map with no eviction in a process
  meant to run for months. Bounded at `KALAIROS_MAX_AGENTS` (default 1000,
  oldest evicted first), paired with the new `DELETE` route above.

- **`zod` is declared as a direct dependency.** `mcp.js` requires it but only
  received it by hoisting from `@modelcontextprotocol/sdk`. Under a strict,
  non-hoisting `node_modules` layout (pnpm's default) that resolution fails and
  `kalairos-mcp` cannot start. The range mirrors the SDK's own so the two
  always dedupe.

- **Hosted NemoGuard requests went to the wrong path**, and **an unparsed
  detector response is no longer treated as safe.** A response the adapter
  could not parse previously fell through to a zero-risk verdict — failing open
  on the one signal whose whole job is to fail closed.

- **Worker-thread and ONNX thread pools are sized from the container's CPU
  quota, not the host's core count.** `os.cpus()` reports the physical host's
  cores from inside a container, so `init()` spawned one V8 isolate per host
  core — measured at ~8.8 MB of RSS each, before any entity or model is
  loaded. On a 0.5-CPU / 512 MB instance backed by a 32-core host that is
  ~324 MB of worker threads alone, and the process OOM'd during `init()`
  before it ever bound a port. The platform then served 502s with nothing in
  the application log to explain them.

  New `cpu.js` reads the cgroup quota (v2 `cpu.max`, falling back to v1
  `cpu.cfs_quota_us`) and only falls back to `os.cpus()` when genuinely
  unconstrained. `WorkerPool`, the per-query chunker, and the ONNX Runtime
  session all size from it. `KALAIROS_MAX_WORKERS` overrides it outright.

  Note that ONNX Runtime's arenas are *native* memory, outside the V8 heap —
  `--max-old-space-size` never governed them, and raising that flag above the
  container's RAM limit replaces a catchable V8 error with a kernel SIGKILL.

### Removed

- **`kalairos demo` and the bundled `examples/` directory.** The command, its
  `examples/demo.js` implementation, the npm `files` entry that shipped it, and
  the README invocation are all gone. `examples/desktop-tidy.js` and
  `examples/support-agent-demo.js` went with them; the directory no longer
  exists.

  **Breaking, shipped in a minor.** `kalairos demo` was a public CLI command
  removed without the deprecation window this project normally gives a public
  surface, which on a strict reading calls for a major bump. It ships here in a
  minor because the removal is soft: the command now prints the usage banner
  and exits 0, so a script that still calls it degrades to help output rather
  than crashing. The programmatic API (`init`, `ingest`, `query`, `remember`,
  `getHistory`) is untouched. If you invoke the CLI from automation, pin
  exactly.

  **Migration:** there is none — the demo was zero-config scaffolding with no
  state and no API. `kalairos demo` now prints the usage banner and exits 0
  rather than erroring, so a script that still calls it degrades to help output
  instead of crashing.

## [1.8.0] — 2026-08-16

Headline: **workspace isolation is now enforced on the write path.** Three
fixes close cross-tenant leaks that the read-path `allowedWorkspaces` gates
could not cover, including one that let a write from one workspace overwrite
an entity owned by another. Single-workspace deployments (everything on
`default`) are unaffected by all three.

### Added

- **Series supersession** for `metric`/`series` entities: a value with a
  strictly later `effectiveAt` retires the prior reading into a closed valid
  interval instead of flagging a contradiction (no trust penalty for
  legitimate drift). Same- or earlier-time value flips still contradict.
  `effectiveAt` is now accepted by the MCP `kalairos_remember` tool.

### Fixed

- **Cross-workspace entity merging.** `ingest()` scored every stored entity of
  the same `type` for version/consolidation matching, ignoring `workspaceId`.
  Two workspaces holding similarly-worded facts could collide: a write from one
  tenant would version-update — and overwrite — an entity belonging to another.
  Candidate scans in `ingest()` and the clustering pass in `consolidate()` are
  now confined to a single workspace. Single-workspace deployments (everything
  on `default`) are unaffected.
- **Cross-workspace graph links.** Semantic auto-linking scored every stored
  entity, so the graph held edges spanning tenants: `traverse()` returned a
  neighbour from another workspace, and `linkCount` counted edges the caller
  could not resolve. The read-path `allowedWorkspaces` gates only helped
  callers that passed them, which is not the default. Links are now confined
  to one workspace at write time. Stores written by earlier versions are
  repaired on load — cross-workspace edges are dropped in memory at `init()`
  and disappear from the JSONL (and the SQLite index) on the next write; no
  manual migration is needed. Same-workspace edges are untouched, so
  single-workspace deployments are unaffected.
- **Graph readers reported edges to nodes they withheld.** `traverse()` pushed
  an edge before checking whether the neighbour was visible, and `getGraph()`
  never checked the far end at all — so an edge could name a soft-deleted
  entity, an id no longer in the store, or one outside the caller's
  `allowedWorkspaces`, while `nodes` correctly omitted it. Both now report an
  edge only when both endpoints are returned as nodes. Callers that rendered
  the result as a graph no longer get edges pointing at nothing.

### Changed

- **Node.js >= 20 required** (`engines` was `>=18`). Node 18 is EOL
  (April 2025) and better-sqlite3 v12 — the hybrid-index engine since
  1.7.0 — supports Node 20+ only, so 1.7.0 already failed to install on
  Node 18 wherever a source build wasn't possible (e.g. Windows). CI now
  tests Node 20/22/24.
- **`engines` narrowed to the LTS lines** (`^20 || ^22 || ^24`, was `>=20`).
  `>=20` promised support for odd-numbered, non-LTS releases that were never
  tested and do not install: `better-sqlite3` publishes no prebuilt binary for
  them, so `npm install kalairos` falls back to a source build and fails on a
  machine without a working toolchain. Verified on Node 23.7 / macOS arm64,
  where `prebuild-install` reports `No prebuilt binaries found` and the
  subsequent `node-gyp` build dies compiling `sqlite3.a`. The supported set is
  now exactly the CI matrix. Node 21/23 users should move to an LTS line.

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
