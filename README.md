# Smriti

> Your AI agent forgot what it knew yesterday. That's not a bug — your database just doesn't care about time.

**Vector databases store embeddings. Smriti remembers.**

Your agent stores a fact. Updates it. Then asks "what was true last week?" Your vector database returns nothing — the old embedding is gone. Smriti returns the right answer, with a full version trail showing when and why it changed.

```bash
npm install smriti-db
```

---

## See it work — 30 seconds, no API key

```bash
npx smriti-db demo
```

Runs a live agent memory demo in your terminal. Zero config. Nothing written to disk.

---

## Quick start

```js
const smriti = require('smriti-db');

async function main() {
	await smriti.init({
		// Bring your own embedder — any function that returns a number[]
		embedFn: async (text) => {
			const res = await fetch('https://api.openai.com/v1/embeddings', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
			});
			return (await res.json()).data[0].embedding;
		},
	});

	const agent = smriti.createAgent({ name: 'analyst' });

	// Store a fact
	const id = await agent.remember('Revenue target is $10M for Q3');

	// Update it — version detection is automatic, no ID needed
	await agent.remember('Revenue target revised to $12M for Q3');

	// What's current?
	const now = await agent.recall('revenue target');
	// → "Revenue target revised to $12M for Q3"

	// What was true BEFORE the revision?
	const then = await agent.recall('revenue target', {
		asOf: Date.now() - 7 * 24 * 60 * 60 * 1000, // one week ago
	});
	// → "Revenue target is $10M for Q3"

	// What changed?
	const history = await agent.getHistory(id);
	// → v1: "$10M" → v2: "$12M", delta: "Value changed: [$10m] → [$12m]"

	// Spot contradictions
	const { contradictions } = await agent.getContradictions(id);

	await smriti.shutdown();
}

main();
```

---

## Why not just use a vector database?

|                                | Vector DB              | Smriti                               |
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
const agent = smriti.createAgent({
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

Feed Smriti memories into your agent's prompt with a token budget. This is the recommended integration pattern for production agents:

```js
const smriti = require('smriti-db');

await smriti.init({ embedFn: myEmbedder });
const agent = smriti.createAgent({ name: 'assistant' });

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

Pass `asOf` (Unix ms) to any query. Entities that didn't exist yet are skipped. Each entity is scored against the version that was current at that time.

```js
const results = await smriti.query('raw material cost', {
	asOf: new Date('2026-01-15').getTime(),
});
```

### Contradiction detection

When a version contradicts a previous one (e.g. a price changes from $200 to $250), the delta is flagged. Agents can inspect contradictions and decide how to act.

### Provenance and classification

Every entity tracks `source` (who created it) and `classification` (how sensitive it is). Query results include both so downstream systems can make trust decisions.

```js
await smriti.ingest('Customer requested a refund', {
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
await smriti.remember('Meeting notes from standup', {
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
smriti.onSignal('ERR_EMBEDDING_FAILED', (err) => {
	console.warn(err.message, '—', err.suggestion);
});
```

### LLM enrichment

Pass `llmFn` to `init()` for optional metadata extraction on ingest. When `useLLM: true` is set, the LLM extracts keywords, context, semantic tags, and importance scores. Off by default. Failures are non-blocking.

```js
await smriti.init({
	embedFn: myEmbedder,
	llmFn: async (text, type) => ({
		keywords: ['budget', 'Q2'],
		context: 'Quarterly budget update',
		llmTags: ['finance', 'planning'],
		importance: 0.8,
	}),
});

await smriti.remember('Q2 budget is 2.4M', { useLLM: true });
```

---

## API reference

### Lifecycle

```js
await smriti.init({ embedFn, llmFn?, embeddingDim?, dataFile?, ...overrides })
await smriti.shutdown()
```

### Write

```js
await smriti.remember(text, opts?)
await smriti.ingest(text, opts?)
await smriti.ingestBatch(items)
await smriti.ingestFile(filePath, opts?)
await smriti.ingestTimeSeries(label, points, opts?)
```

Options: `{ type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM, importance }`

### Read

```js
await smriti.query(text, { limit?, filter?, asOf? })
await smriti.get(id)
await smriti.getMany(ids)
await smriti.getHistory(id)
await smriti.listEntities({ page?, limit?, type?, since?, until?, tags?, memoryType?, workspaceId? })
await smriti.getGraph()
await smriti.traverse(id, depth?)
await smriti.getStatus()
```

### Delete

```js
await smriti.remove(id, { deletedBy? })    // soft delete
await smriti.purge(id)                      // permanent hard delete
```

### Agent

```js
const agent = smriti.createAgent({ name, defaultClassification?, defaultTags?, useLLM? })
```

### Signals

```js
smriti.onSignal(code, callback)
smriti.getSignals(code?)
```

---

## HTTP server

```bash
npx smriti-db          # starts on localhost:3000
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
| `SMRITI_LINK_THRESHOLD`        | `0.72`  | Similarity threshold for graph linking     |
| `SMRITI_VERSION_THRESHOLD`     | `0.82`  | Similarity threshold for version detection |
| `SMRITI_GRAPH_BOOST`           | `0.01`  | Graph relationship boost weight            |
| `SMRITI_LLM_BOOST`             | `0.08`  | LLM keyword boost weight                   |
| `SMRITI_IMPORTANCE_WEIGHT`     | `0.05`  | Importance boost weight in query scoring   |
| `SMRITI_RECENCY_WEIGHT`        | `0.10`  | Recency boost weight                       |
| `SMRITI_RECENCY_HALFLIFE_DAYS` | `30`    | Recency half-life in days                  |
| `SMRITI_MIN_SCORE`             | `0.45`  | Minimum final score for results            |
| `SMRITI_MIN_SEMANTIC`          | `0.35`  | Minimum semantic similarity                |
| `SMRITI_MAX_VERSIONS`          | `0`     | Max versions per entity (0 = unlimited)    |
| `SMRITI_STRICT_EMBEDDINGS`     | `1`     | Require embedder (`0` to disable)          |
| `SMRITI_PORT`                  | `3000`  | HTTP server port                           |

---

## Storage

- Persisted locally to `data.smriti` (configurable via `dataFile`)
- Atomic writes to reduce corruption risk
- Pass `dataFile: ":memory:"` for in-memory-only mode

---

## Feedback

We'd love to hear how you're using Smriti — what works, what's missing, what you'd build on top of it.

Reach us at **main@krishnalabs.ai**

---

## License

MIT — [KrishnaLabs](https://krishnalabs.ai)
