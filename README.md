# Kalairos

> Durable, private, time-aware memory for long-running AI agents.

Your agent stores a fact. Updates it. Then asks *"what was true last week?"* A vector DB forgets the old embedding. **Kalairos remembers — with a full version trail.**

```bash
npm install kalairos
```

No cloud service. No API key required (bring any embedder, or start with the bundled one). JSONL on disk — human-readable, git-friendly.

---

## Quick start — 10 lines, no API key

```js
const kalairos = require('kalairos');
const embed = async (t) => [...t].map(c => c.charCodeAt(0) / 255); // toy embedder

await kalairos.init({ embedFn: embed });
const agent = kalairos.createAgent({ name: 'analyst' });

const id = await agent.remember('Revenue target is $10M for Q3');
await agent.remember('Revenue target revised to $12M for Q3');

console.log((await agent.recall('revenue target'))[0].text);        // → "$12M"
const then = Date.now() - 7 * 24 * 60 * 60 * 1000;
console.log((await agent.recall('revenue target', { asOf: then }))[0].text); // → "$10M"
```

That's memory with time travel. Swap the toy embedder for OpenAI, Cohere, or any `async (text) => number[]` when you're ready.

**Try the interactive demo — zero config:**

```bash
npx kalairos demo
```

---

## API stability

Kalairos follows semver. Within the `1.x` line, the signatures of **`init`, `ingest`, `remember`, `query`, `getHistory`** — and their agent-shaped aliases on `createAgent()` — are **frozen**. Additive fields are fine; breaking changes require a major bump. See §19 in `CLAUDE.md` for the full contract.

---

## Why not just use a vector database?

|                                | Vector DB              | Kalairos                               |
| ------------------------------ | ---------------------- | ------------------------------------ |
| **Updates**                    | Overwrite or duplicate | Automatic versioning                 |
| **History**                    | None                   | Full version trail with deltas       |
| **"What was true on Jan 15?"** | Can't answer           | `asOf` any timestamp                 |
| **Contradictions**             | Invisible              | Auto-detected between versions       |
| **Provenance**                 | Not tracked            | Who stored it, when, from where      |
| **Retrieval**                  | Cosine similarity      | Semantic + graph + keyword + recency |
| **Deployment**                 | Cloud SDK              | Local-first, zero cloud dependency   |
| **Embedding model**            | Bundled or locked in   | BYO — any provider, any model        |

---

## Benchmarks

All numbers from `npm run bench` — deterministic bag-of-words embedder, no API key needed. Reproducible on any machine.

| Metric                      | Score                            | What it measures                                      |
| --------------------------- | -------------------------------- | ----------------------------------------------------- |
| **Recall@5**                | 75% (finance), 50% (engineering) | Fraction of relevant items in top-5 results           |
| **Precision@3**             | 100% (health)                    | Fraction of top-3 results that are relevant           |
| **MRR**                     | 1.0                              | First relevant result appears at rank 1               |
| **Temporal accuracy**       | 100%                             | `asOf` time-travel returns correct historical version |
| **Contradiction detection** | 100%                             | Value changes flagged across all scenarios            |
| **Cross-session recall**    | 100%                             | Agent B finds Agent A's memories                      |
| **Noise separation**        | 3/5 finance in top-5             | Relevant entities ranked above unrelated noise        |

**Constitution Goal Scorecard: 10/10 goals, 53/53 assertions passing (100%)**

These numbers use a bag-of-words embedder (no neural model). With OpenAI `text-embedding-3-small` or Cohere embeddings, expect recall@5 > 90%. See `bench/agent-memory/bench-eval-real.js` for a variant that uses real embeddings.

```bash
npm run bench          # full suite (53 tests, ~300ms)
npm run bench:real     # real embeddings (requires OPENAI_API_KEY)
```

---

## Agent API

`createAgent()` is the recommended interface. It wraps the core engine with agent identity, default classification, default tags, and a clean `remember / recall / update` surface.

```js
const agent = kalairos.createAgent({
	name: 'budget-planner',
	defaultClassification: 'confidential',
	defaultTags: ['finance'],
});

await agent.remember('Q2 budget is 2.4M');
await agent.update('Q2 budget is now 2.7M');

const results = await agent.recall('Q2 budget');
const past = await agent.recall('Q2 budget', {
	asOf: Date.now() - 7 * 24 * 60 * 60 * 1000,
});

const history = await agent.getHistory(id);
const { contradictions } = await agent.getContradictions(id);
```

| Method                        | What it does                                            |
| ----------------------------- | ------------------------------------------------------- |
| `agent.remember(text, opts?)` | Store or update a fact (version detection is automatic) |
| `agent.update(text, opts?)`   | Alias for `remember` — makes update intent explicit     |
| `agent.recall(text, opts?)`   | Query memories (supports `asOf` for time-travel)        |
| `agent.getHistory(id)`        | Full version history with provenance trail              |
| `agent.getContradictions(id)` | Versions flagged as contradictory                       |

### Agent memory workflow — token-budgeted context

Feed Kalairos memories into your agent's prompt with a token budget. This is the recommended integration pattern for production agents:

```js
const kalairos = require('kalairos');

await kalairos.init({ embedFn: myEmbedder });
const agent = kalairos.createAgent({ name: 'assistant' });

// Store facts over time
await agent.remember('User prefers dark mode');
await agent.remember('Last deployment was v2.3.1 on March 15');

// At inference time: retrieve within a token budget
const { results, tokenUsage } = await agent.recall('user preferences', {
	maxTokens: 2000,
});
const context = results.map((r) => r.text).join('\n');
// → Feed `context` into your agent prompt

console.log(tokenUsage);
// → { budget: 2000, used: 847, resultsDropped: 0 }
```

For agent boot (no query needed — just the most important memories):

```js
const { items } = await agent.boot({ maxTokens: 1000, depth: 'essential' });
const bootContext = items.map((i) => i.text).join('\n');
// → Prepend to system prompt for session continuity
```

---

## Core capabilities

### Versioned memory

Every update creates a version, never an overwrite. Each version records the new content, a delta summary describing the change, a timestamp, source provenance, classification, and a snapshot of graph edges at that point in time.

### Time-travel queries

Use `queryAt(text, timestamp)` for a point-in-time snapshot, or `queryRange(text, since, until)` for entities whose version timeline overlaps a range. Entities that didn't exist yet are skipped. Each entity is scored against the version current at that timestamp.

```js
// Point-in-time snapshot
const snapshot = await kalairos.queryAt(
	'raw material cost',
	new Date('2026-01-15').getTime(),
);

// Range query — entities active between these bounds
const window = await kalairos.queryRange(
	'raw material cost',
	new Date('2026-01-01').getTime(),
	new Date('2026-01-31').getTime(),
);
```

### Contradiction detection

When a version contradicts a previous one (e.g. a price changes from $200 to $250), the delta is flagged. Agents can inspect contradictions and decide how to act.

### Provenance and classification

Every entity tracks `source` (who created it) and `classification` (how sensitive it is). Query results include both so downstream systems can make trust decisions.

```js
await kalairos.ingest('Customer requested a refund', {
	source: { type: 'tool', uri: 'support-ticket-1234' },
	classification: 'confidential',
	tags: ['support', 'billing'],
});
```

### Retention and deletion

- **Soft delete**: `remove(id, { deletedBy })` — excluded from queries, preserved for audit
- **Hard delete**: `purge(id)` — permanent erasure for right-to-erasure workflows (GDPR)
- **Retention policy**: `{ policy: "keep" | "expire", expiresAt }` per entity

### Memory types and workspaces

Tag entities with `memoryType` (`"short-term"`, `"long-term"`, `"working"`) and `workspaceId` for tenant isolation. Both are filterable in queries.

```js
await kalairos.remember('Meeting notes from standup', {
	memoryType: 'short-term',
	workspaceId: 'team-alpha',
});
```

### Hybrid scoring

Queries combine multiple signals into a final score:

- **Semantic similarity** — cosine distance between embeddings
- **Graph boost** — related entities via automatically discovered links
- **Keyword boost** — exact term overlap
- **LLM keyword boost** — when `useLLM` enrichment is enabled
- **Importance boost** — explicit `importance` (0-1), LLM-derived, or auto-heuristic from version count + connectivity + contradictions
- **Recency boost** — configurable half-life, disabled in `asOf` mode

Set importance explicitly to prioritize critical memories in tight token budgets:

```js
await agent.remember('API key rotation policy: every 90 days', {
	importance: 0.9,
});
await agent.remember('Office wifi password is "guest123"', { importance: 0.2 });
```

### Error signals

Structured errors that agents can subscribe to for adaptive behavior:

```js
kalairos.onSignal('ERR_EMBEDDING_FAILED', (err) => {
	console.warn(err.message, '—', err.suggestion);
});
```

### LLM enrichment

Pass `llmFn` to `init()` for optional metadata extraction on ingest. When `useLLM: true` is set, the LLM extracts keywords, context, semantic tags, and importance scores. Off by default. Failures are non-blocking.

```js
await kalairos.init({
	embedFn: myEmbedder,
	llmFn: async (text, type) => ({
		keywords: ['budget', 'Q2'],
		context: 'Quarterly budget update',
		llmTags: ['finance', 'planning'],
		importance: 0.8,
	}),
});

await kalairos.remember('Q2 budget is 2.4M', { useLLM: true });
```

---

## API reference

### Lifecycle

```js
await kalairos.init({ embedFn, llmFn?, embeddingDim?, dataFile?, ...overrides })
await kalairos.shutdown()
```

### Write

```js
await kalairos.remember(text, opts?)
await kalairos.ingest(text, opts?)
await kalairos.ingestBatch(items)
await kalairos.ingestFile(filePath, opts?)
await kalairos.ingestTimeSeries(label, points, opts?)
```

Options: `{ type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM, importance, forceNew }`

- **`forceNew`** (`boolean`, default `false`) — skip similarity matching and always create a new entity row. Use when you know two memories are distinct despite similar wording (e.g. separate journal entries on the same topic).
- Text length is validated against **`maxTextLen`** (default `5000` chars, configurable via `init({ maxTextLen })` or `KALAIROS_MAX_TEXT_LEN` env). Exceeding it throws `ERR_TEXT_TOO_LONG` — split long content into smaller memories rather than relying on silent truncation.

### Read

```js
await kalairos.query(text, { limit?, maxTokens?, filter? })
await kalairos.queryAt(text, timestamp, { limit?, maxTokens?, filter? })
await kalairos.queryRange(text, since, until, { limit?, maxTokens?, filter? })
await kalairos.get(id)
await kalairos.getMany(ids)
await kalairos.getHistory(id)
await kalairos.listEntities({ page?, limit?, type?, since?, until?, tags?, memoryType?, workspaceId? })
await kalairos.getGraph()
await kalairos.traverse(id, depth?)
await kalairos.getStatus()
```

### Delete

```js
await kalairos.remove(id, { deletedBy? })    // soft delete
await kalairos.purge(id)                      // permanent hard delete
```

### Agent

```js
const agent = kalairos.createAgent({ name, defaultClassification?, defaultTags?, useLLM? })
```

### Signals

```js
kalairos.onSignal(code, callback)
kalairos.getSignals(code?)
```

---

## Markdown export / import

Memory is portable and diffable. Any agent or human can read it.

```bash
npx kalairos export --out memory.md --include-history   # dump to markdown
npx kalairos import memory.md                           # ingest back (idempotent shape)
```

Checkpoint it into git, share it across agents, or hand-edit it when debugging. No proprietary format lock-in.

---

## HTTP server

```bash
npx kalairos          # starts on localhost:3000
```

### Core endpoints

| Method   | Path                 | Description                                   |
| -------- | -------------------- | --------------------------------------------- |
| `POST`   | `/ingest`            | Ingest with full options                      |
| `POST`   | `/remember`          | Agent-facing write                            |
| `POST`   | `/ingest/batch`      | Batch ingest                                  |
| `POST`   | `/ingest/timeseries` | Time series data                              |
| `POST`   | `/ingest/file`       | File ingest                                   |
| `POST`   | `/query`             | Query with `{ text, limit?, filter?, asOf? }` |
| `GET`    | `/entity/:id`        | Get entity                                    |
| `DELETE` | `/entity/:id`        | Soft delete                                   |
| `DELETE` | `/entity/:id/purge`  | Permanent hard delete                         |
| `POST`   | `/entities/batch`    | Get multiple by ID                            |
| `GET`    | `/entities`          | List with filters                             |
| `GET`    | `/history/:id`       | Version history                               |
| `GET`    | `/graph`             | Full graph                                    |
| `GET`    | `/traverse/:id`      | Traverse from entity                          |
| `GET`    | `/status`            | System status                                 |

### Agent endpoints

| Method | Path                                       | Description                                                            |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `POST` | `/agent/create`                            | Create agent `{ name, defaultClassification?, defaultTags?, useLLM? }` |
| `POST` | `/agent/:agentId/remember`                 | Store via agent                                                        |
| `POST` | `/agent/:agentId/update`                   | Update via agent                                                       |
| `POST` | `/agent/:agentId/recall`                   | Query via agent (supports `asOf`)                                      |
| `GET`  | `/agent/:agentId/history/:entityId`        | Version history                                                        |
| `GET`  | `/agent/:agentId/contradictions/:entityId` | Contradiction inspection                                               |

---

## Configuration

| Variable                       | Default | Description                                |
| ------------------------------ | ------- | ------------------------------------------ |
| `KALAIROS_LINK_THRESHOLD`        | `0.72`  | Similarity threshold for graph linking     |
| `KALAIROS_VERSION_THRESHOLD`     | `0.82`  | Similarity threshold for version detection |
| `KALAIROS_GRAPH_BOOST`           | `0.01`  | Graph relationship boost weight            |
| `KALAIROS_LLM_BOOST`             | `0.08`  | LLM keyword boost weight                   |
| `KALAIROS_IMPORTANCE_WEIGHT`     | `0.05`  | Importance boost weight in query scoring   |
| `KALAIROS_RECENCY_WEIGHT`        | `0.10`  | Recency boost weight                       |
| `KALAIROS_RECENCY_HALFLIFE_DAYS` | `30`    | Recency half-life in days                  |
| `KALAIROS_MIN_SCORE`             | `0.45`  | Minimum final score for results            |
| `KALAIROS_MIN_SEMANTIC`          | `0.35`  | Minimum semantic similarity                |
| `KALAIROS_MAX_VERSIONS`          | `0`     | Max versions per entity (0 = unlimited)    |
| `KALAIROS_STRICT_EMBEDDINGS`     | `1`     | Require embedder (`0` to disable)          |
| `KALAIROS_PORT`                  | `3000`  | HTTP server port                           |

---

## Storage

- Persisted locally to `data.kalairos` (configurable via `dataFile`)
- Atomic writes to reduce corruption risk
- Pass `dataFile: ":memory:"` for in-memory-only mode

---

## Feedback

We'd love to hear how you're using Kalairos — what works, what's missing, what you'd build on top of it.

Reach us at **main@krishnalabs.ai**

---

## License

MIT — [KrishnaLabs](https://krishnalabs.ai)
