# Database X

> Your AI agent forgot what it knew yesterday. That's not a bug — your database just doesn't care about time.

**Vector databases store embeddings. Database X remembers.**

Your agent stores a fact. Updates it. Then asks "what was true last week?" Your vector database returns nothing — the old embedding is gone. Database X returns the right answer, with a full version trail showing when and why it changed.

```bash
npm install dbx-memory
```

---

## See it work — 30 seconds, no API key

```bash
npx dbx-memory demo
```

Runs a live agent memory demo in your terminal. Zero config. Nothing written to disk.

---

## Quick start

```js
const dbx = require('dbx-memory');

async function main() {
  await dbx.init({
    // Bring your own embedder — any function that returns a number[]
    embedFn: async (text) => {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
      });
      return (await res.json()).data[0].embedding;
    },
  });

  const agent = dbx.createAgent({ name: 'analyst' });

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

  await dbx.shutdown();
}

main();
```

---

## Why not just use a vector database?

|  | Vector DB | Database X |
|---|---|---|
| **Updates** | Overwrite or duplicate | Automatic versioning |
| **History** | None | Full version trail with deltas |
| **"What was true on Jan 15?"** | Can't answer | `asOf` any timestamp |
| **Contradictions** | Invisible | Auto-detected between versions |
| **Provenance** | Not tracked | Who stored it, when, from where |
| **Retrieval** | Cosine similarity | Semantic + graph + keyword + recency |
| **Deployment** | Cloud SDK | Local-first, zero cloud dependency |
| **Embedding model** | Bundled or locked in | BYO — any provider, any model |

---

## Agent API

`createAgent()` is the recommended interface. It wraps the core engine with agent identity, default classification, default tags, and a clean `remember / recall / update` surface.

```js
const agent = dbx.createAgent({
  name: 'budget-planner',
  defaultClassification: 'confidential',
  defaultTags: ['finance'],
});

await agent.remember('Q2 budget is 2.4M');
await agent.update('Q2 budget is now 2.7M');

const results = await agent.recall('Q2 budget');
const past    = await agent.recall('Q2 budget', {
  asOf: Date.now() - 7 * 24 * 60 * 60 * 1000,
});

const history         = await agent.getHistory(id);
const { contradictions } = await agent.getContradictions(id);
```

| Method | What it does |
|--------|-------------|
| `agent.remember(text, opts?)` | Store or update a fact (version detection is automatic) |
| `agent.update(text, opts?)` | Alias for `remember` — makes update intent explicit |
| `agent.recall(text, opts?)` | Query memories (supports `asOf` for time-travel) |
| `agent.getHistory(id)` | Full version history with provenance trail |
| `agent.getContradictions(id)` | Versions flagged as contradictory |

---

## Core capabilities

### Versioned memory

Every update creates a version, never an overwrite. Each version records the new content, a delta summary describing the change, a timestamp, source provenance, classification, and a snapshot of graph edges at that point in time.

### Time-travel queries

Pass `asOf` (Unix ms) to any query. Entities that didn't exist yet are skipped. Each entity is scored against the version that was current at that time.

```js
const results = await dbx.query('raw material cost', {
  asOf: new Date('2026-01-15').getTime(),
});
```

### Contradiction detection

When a version contradicts a previous one (e.g. a price changes from $200 to $250), the delta is flagged. Agents can inspect contradictions and decide how to act.

### Provenance and classification

Every entity tracks `source` (who created it) and `classification` (how sensitive it is). Query results include both so downstream systems can make trust decisions.

```js
await dbx.ingest('Customer requested a refund', {
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
await dbx.remember('Meeting notes from standup', {
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
- **Recency boost** — configurable half-life, disabled in `asOf` mode

### Error signals

Structured errors that agents can subscribe to for adaptive behavior:

```js
dbx.onSignal('ERR_EMBEDDING_FAILED', (err) => {
  console.warn(err.message, '—', err.suggestion);
});
```

### LLM enrichment

Pass `llmFn` to `init()` for optional metadata extraction on ingest. When `useLLM: true` is set, the LLM extracts keywords, context, semantic tags, and importance scores. Off by default. Failures are non-blocking.

```js
await dbx.init({
  embedFn: myEmbedder,
  llmFn: async (text, type) => ({
    keywords: ['budget', 'Q2'],
    context: 'Quarterly budget update',
    llmTags: ['finance', 'planning'],
    importance: 0.8,
  }),
});

await dbx.remember('Q2 budget is 2.4M', { useLLM: true });
```

---

## API reference

### Lifecycle

```js
await dbx.init({ embedFn, llmFn?, embeddingDim?, dataFile?, ...overrides })
await dbx.shutdown()
```

### Write

```js
await dbx.remember(text, opts?)
await dbx.ingest(text, opts?)
await dbx.ingestBatch(items)
await dbx.ingestFile(filePath, opts?)
await dbx.ingestTimeSeries(label, points, opts?)
```

Options: `{ type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM }`

### Read

```js
await dbx.query(text, { limit?, filter?, asOf? })
await dbx.get(id)
await dbx.getMany(ids)
await dbx.getHistory(id)
await dbx.listEntities({ page?, limit?, type?, since?, until?, tags?, memoryType?, workspaceId? })
await dbx.getGraph()
await dbx.traverse(id, depth?)
await dbx.getStatus()
```

### Delete

```js
await dbx.remove(id, { deletedBy? })    // soft delete
await dbx.purge(id)                      // permanent hard delete
```

### Agent

```js
const agent = dbx.createAgent({ name, defaultClassification?, defaultTags?, useLLM? })
```

### Signals

```js
dbx.onSignal(code, callback)
dbx.getSignals(code?)
```

---

## HTTP server

```bash
npx dbx-memory          # starts on localhost:3000
```

### Core endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Ingest with full options |
| `POST` | `/remember` | Agent-facing write |
| `POST` | `/ingest/batch` | Batch ingest |
| `POST` | `/ingest/timeseries` | Time series data |
| `POST` | `/ingest/file` | File ingest |
| `POST` | `/query` | Query with `{ text, limit?, filter?, asOf? }` |
| `GET` | `/entity/:id` | Get entity |
| `DELETE` | `/entity/:id` | Soft delete |
| `DELETE` | `/entity/:id/purge` | Permanent hard delete |
| `POST` | `/entities/batch` | Get multiple by ID |
| `GET` | `/entities` | List with filters |
| `GET` | `/history/:id` | Version history |
| `GET` | `/graph` | Full graph |
| `GET` | `/traverse/:id` | Traverse from entity |
| `GET` | `/status` | System status |

### Agent endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/create` | Create agent `{ name, defaultClassification?, defaultTags?, useLLM? }` |
| `POST` | `/agent/:agentId/remember` | Store via agent |
| `POST` | `/agent/:agentId/update` | Update via agent |
| `POST` | `/agent/:agentId/recall` | Query via agent (supports `asOf`) |
| `GET` | `/agent/:agentId/history/:entityId` | Version history |
| `GET` | `/agent/:agentId/contradictions/:entityId` | Contradiction inspection |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DBX_LINK_THRESHOLD` | `0.72` | Similarity threshold for graph linking |
| `DBX_VERSION_THRESHOLD` | `0.82` | Similarity threshold for version detection |
| `DBX_GRAPH_BOOST` | `0.01` | Graph relationship boost weight |
| `DBX_LLM_BOOST` | `0.08` | LLM keyword boost weight |
| `DBX_RECENCY_WEIGHT` | `0.10` | Recency boost weight |
| `DBX_RECENCY_HALFLIFE_DAYS` | `30` | Recency half-life in days |
| `DBX_MIN_SCORE` | `0.45` | Minimum final score for results |
| `DBX_MIN_SEMANTIC` | `0.35` | Minimum semantic similarity |
| `DBX_MAX_VERSIONS` | `0` | Max versions per entity (0 = unlimited) |
| `DBX_STRICT_EMBEDDINGS` | `1` | Require embedder (`0` to disable) |
| `DBX_PORT` | `3000` | HTTP server port |

---

## Storage

- Persisted locally to `data.dbx` (configurable via `dataFile`)
- Atomic writes to reduce corruption risk
- Pass `dataFile: ":memory:"` for in-memory-only mode

---

## Feedback

We'd love to hear how you're using Database X — what works, what's missing, what you'd build on top of it.

Reach us at **main@krishnalabs.ai**

---

## License

MIT — [KrishnaLabs](https://krishnalabs.ai)
