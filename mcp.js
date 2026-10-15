#!/usr/bin/env node
// mcp.js — Kalairos MCP Server
// Exposes Kalairos as an MCP tool server for Claude Code, Cursor, ChatGPT, and any MCP host.
// Transport: stdio (JSON-RPC 2.0 over stdin/stdout).
//
// Usage in claude_desktop_config.json or .claude/settings.json:
//   { "mcpServers": { "kalairos": { "command": "node", "args": ["/path/to/kalairos/mcp.js"] } } }
//
// Environment variables:
//   KALAIROS_DATA_FILE  — path to data file (default: ./data.kalairos)
//   KALAIROS_MCP_NAME   — server name shown to host (default: "kalairos")
"use strict";

const { McpServer }            = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z                        = require("zod");
const path                     = require("path");
const dbx                      = require("./index");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: "text", text: err?.message || String(err) }],
  };
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const serverName = process.env.KALAIROS_MCP_NAME || "kalairos";
const server = new McpServer(
  { name: serverName, version: require("./package.json").version },
  { capabilities: { tools: {} } },
);

// Tool calls still running. Shutdown lets them finish, so a write the client
// sent just before it went away still lands and still gets its reply.
const inflight = new Set();

// server.tool(), with each call held in `inflight` until it settles.
function tool(name, description, schema, handler) {
  server.tool(name, description, schema, (...args) => {
    const call = handler(...args);
    inflight.add(call);
    const done = () => inflight.delete(call);
    call.then(done, done);
    return call;
  });
}

// ─── Tools ───────────────────────────────────────────────────────────────────
// Tools covering the full agent memory lifecycle.

// 1. kalairos_remember — store or update a memory
tool(
  "kalairos_remember",
  "Store a memory. If similar content already exists, it is updated in-place (version history preserved). Returns the stable entity ID.",
  {
    text:           z.string().describe("The memory content to store (max 5000 chars)"),
    type:           z.string().optional().describe("Entity type (default: 'text'). Use 'metric' or 'series' for time-varying values: a later effectiveAt supersedes the prior reading as a new valid interval instead of flagging a contradiction"),
    tags:           z.array(z.string()).optional().describe("Filterable tags"),
    metadata:       z.object({}).passthrough().optional().describe("Arbitrary metadata object"),
    importance:     z.number().min(0).max(1).optional().describe("Importance score (0-1). Higher = prioritized in tight token budgets. Auto-derived if not set"),
    memoryType:     z.enum(["short-term", "long-term", "working"]).optional().describe("Memory durability class (default: 'long-term')"),
    workspaceId:    z.string().optional().describe("Workspace/tenant isolation key (default: 'default')"),
    effectiveAt:    z.union([z.number(), z.string()]).optional().describe("Event time this value became true (Unix ms or ISO-8601 string). Defaults to ingest time. For metric/series types, a strictly later effectiveAt retires the previous value into a closed valid interval — both readings stay queryable via recall(asOf)"),
  },
  async ({ text, type, tags, metadata, importance, memoryType, workspaceId, effectiveAt }) => {
    try {
      const id = await dbx.remember(text, { type, tags, metadata, importance, memoryType, workspaceId, effectiveAt });
      return ok({ id });
    } catch (err) { return fail(err); }
  },
);

// 2. kalairos_recall — semantic search
tool(
  "kalairos_recall",
  "Search memories by semantic similarity. Returns ranked results with scores, provenance, and version info. Two independent time axes: asOf answers \"what did we BELIEVE on date X\" (ingest time) and validAt answers \"what was actually TRUE on date X\" (event time). They give different answers for any fact recorded with a backdated effectiveAt — use validAt when the question is about the world, asOf when it is about the record. Supports token-budgeted packing via maxTokens.",
  {
    text:      z.string().describe("Natural language search query"),
    limit:     z.number().int().min(1).max(100).optional().describe("Max results to return (default: 5)"),
    maxTokens: z.number().int().min(1).optional().describe("Token budget — pack results greedily until budget is exhausted (~4 chars/token). Ideal for feeding results into agent context windows"),
    type:  z.string().optional().describe("Filter by entity type"),
    tags:  z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
    memoryType:  z.enum(["short-term", "long-term", "working"]).optional().describe("Filter by memory type"),
    workspaceId: z.string().optional().describe("Filter by workspace"),
    since: z.number().optional().describe("Only results created/updated after this Unix ms timestamp"),
    until: z.number().optional().describe("Only results created/updated before this Unix ms timestamp"),
    asOf:  z.number().optional().describe("Ingest-time travel: return the state we believed at this Unix ms timestamp. A fact learned later is absent, even if it was already true then. Mutually exclusive with validAt"),
    validAt: z.number().optional().describe("Event-time validity: return the version that was actually in force at this Unix ms timestamp in the world, regardless of when we learned it. Mutually exclusive with asOf"),
  },
  async ({ text, limit, maxTokens, type, tags, memoryType, workspaceId, since, until, asOf, validAt }) => {
    try {
      const filter = {};
      if (type)        filter.type = type;
      if (tags)        filter.tags = tags;
      if (memoryType)  filter.memoryType = memoryType;
      if (workspaceId) filter.workspaceId = workspaceId;
      if (since)       filter.since = since;
      if (until)       filter.until = until;
      const opts = { limit, maxTokens, filter };
      if (asOf != null && validAt != null) {
        throw new Error("asOf and validAt are distinct time axes — supply one or the other, not both");
      }
      let result;
      if (asOf != null)         result = await dbx.queryAt(text, asOf, opts);
      else if (validAt != null) result = await dbx.queryValidAt(text, validAt, opts);
      else                      result = await dbx.query(text, opts);
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 3. kalairos_get — fetch a single entity
tool(
  "kalairos_get",
  "Retrieve a specific memory by its stable ID. Returns full entity including metadata, tags, provenance, and version count.",
  {
    id: z.number().int().describe("Entity ID"),
  },
  async ({ id }) => {
    try {
      const entity = await dbx.get(id);
      return ok(entity);
    } catch (err) { return fail(err); }
  },
);

// 4. kalairos_history — version trail
tool(
  "kalairos_history",
  "Get the full version history for a memory. Shows how it changed over time, including diffs, contradiction flags, and provenance per version.",
  {
    id: z.number().int().describe("Entity ID"),
  },
  async ({ id }) => {
    try {
      const history = await dbx.getHistory(id);
      return ok(history);
    } catch (err) { return fail(err); }
  },
);

// 5. kalairos_delete — soft-delete
tool(
  "kalairos_delete",
  "Soft-delete a memory. The entity is marked as deleted but retained for audit purposes. Use kalairos_recall to verify it no longer appears in results.",
  {
    id:        z.number().int().describe("Entity ID to delete"),
    deletedBy: z.string().optional().describe("Actor name for audit trail"),
  },
  async ({ id, deletedBy }) => {
    try {
      await dbx.remove(id, { deletedBy });
      return ok({ id, deleted: true });
    } catch (err) { return fail(err); }
  },
);

// 6. kalairos_status — database overview
tool(
  "kalairos_status",
  "Get an overview of the database: total entities, breakdowns by type/memoryType/workspace, and recent version activity.",
  {},
  async () => {
    try {
      const status = await dbx.getStatus();
      return ok(status);
    } catch (err) { return fail(err); }
  },
);

// 7. kalairos_list — paginated listing
tool(
  "kalairos_list",
  "List stored memories with pagination and optional filters. Returns entity summaries sorted by most recently updated.",
  {
    page:        z.number().int().min(1).optional().describe("Page number (default: 1)"),
    limit:       z.number().int().min(1).max(100).optional().describe("Results per page (default: 20)"),
    type:        z.string().optional().describe("Filter by entity type"),
    memoryType:  z.enum(["short-term", "long-term", "working"]).optional().describe("Filter by memory type"),
    workspaceId: z.string().optional().describe("Filter by workspace"),
    tags:        z.array(z.string()).optional().describe("Filter by tags"),
    since:       z.number().optional().describe("Only entities updated after this Unix ms timestamp"),
    until:       z.number().optional().describe("Only entities updated before this Unix ms timestamp"),
  },
  async ({ page, limit, type, memoryType, workspaceId, tags, since, until }) => {
    try {
      const result = await dbx.listEntities({ page, limit, type, memoryType, workspaceId, tags, since, until });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 8. kalairos_batch_store — store many at once
tool(
  "kalairos_batch_store",
  "Store multiple memories in a single call. Deduplication and version detection apply to each item. Returns array of entity IDs.",
  {
    items: z.array(z.object({
      text:        z.string().describe("Memory content"),
      type:        z.string().optional(),
      tags:        z.array(z.string()).optional(),
      metadata:    z.object({}).passthrough().optional(),
      memoryType:  z.enum(["short-term", "long-term", "working"]).optional(),
      workspaceId: z.string().optional(),
    })).describe("Array of memories to store"),
  },
  async ({ items }) => {
    try {
      const ids = await dbx.ingestBatch(items);
      return ok({ ids, count: ids.length });
    } catch (err) { return fail(err); }
  },
);

// 9. kalairos_extract_facts — fact extraction
tool(
  "kalairos_extract_facts",
  "Extract discrete facts from raw text (e.g. meeting notes, paragraphs) and store each as a separate memory. Requires factExtractFn to be configured.",
  {
    text:        z.string().describe("Raw text to extract facts from"),
    type:        z.string().optional().describe("Entity type for extracted facts"),
    tags:        z.array(z.string()).optional().describe("Tags to apply to all extracted facts"),
    workspaceId: z.string().optional().describe("Workspace for extracted facts"),
  },
  async ({ text, type, tags, workspaceId }) => {
    try {
      const result = await dbx.extractFacts(text, { type, tags, workspaceId });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 10. kalairos_graph — relationship graph
tool(
  "kalairos_graph",
  "Get the knowledge graph of relationships between memories. Returns nodes, edges, and breakdowns by type/workspace.",
  {},
  async () => {
    try {
      const graph = await dbx.getGraph();
      return ok(graph);
    } catch (err) { return fail(err); }
  },
);

// 11. kalairos_consolidate — deduplication
tool(
  "kalairos_consolidate",
  "Merge duplicate or near-duplicate memories. Returns counts of consolidated, removed, and preserved entities.",
  {
    threshold: z.number().min(0).max(1).optional().describe("Similarity threshold for merging (default: 0.78). Higher = stricter"),
    dryRun:    z.boolean().optional().describe("Preview what would be merged without actually merging"),
    type:      z.string().optional().describe("Only consolidate entities of this type"),
  },
  async ({ threshold, dryRun, type }) => {
    try {
      const result = await dbx.consolidate({ threshold, dryRun, type });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 13. kalairos_startup_summary — progressive context loading
tool(
  "kalairos_startup_summary",
  "Get the most critical memories in minimal tokens for agent boot. Ranks by importance, recency, connectivity, and update frequency — no search query needed. Call once at startup instead of scanning all memories.",
  {
    maxTokens: z.number().int().min(1).optional().describe("Token budget for the summary (default: 500). Controls how many memories fit in the response"),
    maxItems:  z.number().int().min(1).max(100).optional().describe("Hard cap on number of items returned"),
    depth:     z.enum(["essential", "standard", "full"]).optional().describe("Loading depth: 'essential' (top 5), 'standard' (top 20, default), 'full' (top 50)"),
    type:        z.string().optional().describe("Filter by entity type"),
    tags:        z.array(z.string()).optional().describe("Filter by tags"),
    memoryType:  z.enum(["short-term", "long-term", "working"]).optional().describe("Filter by memory type"),
    workspaceId: z.string().optional().describe("Filter by workspace"),
  },
  async ({ maxTokens, maxItems, depth, type, tags, memoryType, workspaceId }) => {
    try {
      const filter = {};
      if (type)        filter.type = type;
      if (tags)        filter.tags = tags;
      if (memoryType)  filter.memoryType = memoryType;
      if (workspaceId) filter.workspaceId = workspaceId;
      const result = await dbx.getStartupSummary({ maxTokens, maxItems, depth, filter });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 14. kalairos_export — markdown export
tool(
  "kalairos_export",
  "Export all memories as structured Markdown. Useful for backup, inspection, or sharing.",
  {
    type:           z.string().optional().describe("Filter by entity type"),
    memoryType:     z.enum(["short-term", "long-term", "working"]).optional().describe("Filter by memory type"),
    workspaceId:    z.string().optional().describe("Filter by workspace"),
    tags:           z.array(z.string()).optional().describe("Filter by tags"),
    includeHistory: z.boolean().optional().describe("Include version history in export"),
  },
  async ({ type, memoryType, workspaceId, tags, includeHistory }) => {
    try {
      const result = await dbx.exportMarkdown({ type, memoryType, workspaceId, tags, includeHistory });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// ─── Shutdown ────────────────────────────────────────────────────────────────
// A stdio server should live exactly as long as its client. This one used to
// run until its event loop emptied on its own, and on 1.9.0 the loop never
// did: idle worker threads held it open, so servers outlived their clients by
// days. Now every sign that the client is gone, or wants the server gone,
// runs the same shutdown once: stdin ending or closing, a failed write to
// stdout, the transport closing, SIGTERM or SIGINT.

const SHUTDOWN_TIMEOUT_MS = 5_000;
let shuttingDown = null;

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// Resolves once everything written to stdout has been handed to the OS, so
// exiting does not cut off the last reply.
function flushStdout() {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve();
    process.stdout.write("", () => resolve());
  });
}

function shutdown(reason) {
  if (shuttingDown) return shuttingDown;
  process.stderr.write(`kalairos-mcp: ${reason}, shutting down\n`);

  // Whatever happens below, the process must not outlive this.
  setTimeout(() => {
    process.stderr.write(`kalairos-mcp: shutdown took over ${SHUTDOWN_TIMEOUT_MS}ms, exiting\n`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  process.stdin.pause(); // take no new requests

  shuttingDown = (async () => {
    let code = 0;
    try {
      await nextTurn();                   // requests read along with EOF reach their handlers
      await Promise.allSettled(inflight); // their writes are on disk once they settle
      await nextTurn();                   // their replies are written
      await dbx.shutdown();               // final flush, worker pool stopped
      await flushStdout();
    } catch (err) {
      process.stderr.write(`kalairos-mcp: shutdown failed: ${err.message}\n`);
      code = 1;
    }
    process.exit(code);
  })();
  return shuttingDown;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  const dataFile = process.env.KALAIROS_DATA_FILE || path.join(process.cwd(), "data.kalairos");

  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown("transport closed"); // connect() calls this before its own handler
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  // Writes to a client that has gone fail with EPIPE, and an unhandled stream
  // error kills the process on the spot, mid-write. A failed reply means the
  // client is gone; a failed log line (the engine logs as it writes) has
  // nowhere else to go.
  process.stdout.on("error", (err) => shutdown(`stdout ${err.code || "failed"}`));
  process.stderr.on("error", () => {});
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // No embedFn: init() auto-detects (neural ONNX when the model is cached,
  // built-in bag-of-words otherwise) and logs that choice to stderr, which
  // keeps stdout clean for JSON-RPC. The built-in BoW is bit-identical to the
  // copy this file used to carry, so existing stores need no reindexing.
  await dbx.init({
    dataFile,
    strictEmbeddings: false,
  });

  if (shuttingDown) return; // told to stop while loading
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`kalairos-mcp fatal: ${err.message}\n`);
  process.exit(1);
});
