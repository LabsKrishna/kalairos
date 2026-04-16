#!/usr/bin/env node
// mcp.js — Database X MCP Server
// Exposes DBX as an MCP tool server for Claude Code, Cursor, ChatGPT, and any MCP host.
// Transport: stdio (JSON-RPC 2.0 over stdin/stdout).
//
// Usage in claude_desktop_config.json or .claude/settings.json:
//   { "mcpServers": { "dbx": { "command": "node", "args": ["/path/to/dbx/mcp.js"] } } }
//
// Environment variables:
//   DBX_DATA_FILE  — path to data file (default: ./data.dbx)
//   DBX_MCP_NAME   — server name shown to host (default: "dbx-memory")
"use strict";

const { McpServer }            = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z                        = require("zod");
const path                     = require("path");
const dbx                      = require("./index");

// ─── Built-in Bag-of-Words Embedder ──────────────────────────────────────────
// Lightweight hash-based embedder so the MCP server works zero-config.
// Not production quality — users should supply a real embedFn for serious use.

const BOW_DIM = 128;

function _bowEmbed(text) {
  const vec = new Float64Array(BOW_DIM);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  for (const tok of tokens) {
    // FNV-1a inspired hash → deterministic bucket
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    vec[h % BOW_DIM] += 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < BOW_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(BOW_DIM);
  for (let i = 0; i < BOW_DIM; i++) out[i] = vec[i] / norm;
  return out;
}

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

const serverName = process.env.DBX_MCP_NAME || "dbx-memory";
const server = new McpServer(
  { name: serverName, version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ─── Tools ───────────────────────────────────────────────────────────────────
// 12 tools covering the full agent memory lifecycle.

// 1. dbx_remember — store or update a memory
server.tool(
  "dbx_remember",
  "Store a memory. If similar content already exists, it is updated in-place (version history preserved). Returns the stable entity ID.",
  {
    text:           z.string().describe("The memory content to store (max 5000 chars)"),
    type:           z.string().optional().describe("Entity type (default: 'text'). Use 'fact', 'metric', etc. for typed recall"),
    tags:           z.array(z.string()).optional().describe("Filterable tags"),
    metadata:       z.object({}).passthrough().optional().describe("Arbitrary metadata object"),
    memoryType:     z.enum(["short-term", "long-term", "working"]).optional().describe("Memory durability class (default: 'long-term')"),
    workspaceId:    z.string().optional().describe("Workspace/tenant isolation key (default: 'default')"),
  },
  async ({ text, type, tags, metadata, memoryType, workspaceId }) => {
    try {
      const id = await dbx.remember(text, { type, tags, metadata, memoryType, workspaceId });
      return ok({ id });
    } catch (err) { return fail(err); }
  },
);

// 2. dbx_recall — semantic search
server.tool(
  "dbx_recall",
  "Search memories by semantic similarity. Returns ranked results with scores, provenance, and version info. Supports time-travel via asOf and token-budgeted packing via maxTokens.",
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
    asOf:  z.number().optional().describe("Time-travel: return state as of this Unix ms timestamp"),
  },
  async ({ text, limit, maxTokens, type, tags, memoryType, workspaceId, since, until, asOf }) => {
    try {
      const filter = {};
      if (type)        filter.type = type;
      if (tags)        filter.tags = tags;
      if (memoryType)  filter.memoryType = memoryType;
      if (workspaceId) filter.workspaceId = workspaceId;
      if (since)       filter.since = since;
      if (until)       filter.until = until;
      const result = await dbx.query(text, { limit, maxTokens, filter, asOf });
      return ok(result);
    } catch (err) { return fail(err); }
  },
);

// 3. dbx_get — fetch a single entity
server.tool(
  "dbx_get",
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

// 4. dbx_history — version trail
server.tool(
  "dbx_history",
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

// 5. dbx_delete — soft-delete
server.tool(
  "dbx_delete",
  "Soft-delete a memory. The entity is marked as deleted but retained for audit purposes. Use dbx_recall to verify it no longer appears in results.",
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

// 6. dbx_status — database overview
server.tool(
  "dbx_status",
  "Get an overview of the database: total entities, breakdowns by type/memoryType/workspace, and recent version activity.",
  {},
  async () => {
    try {
      const status = await dbx.getStatus();
      return ok(status);
    } catch (err) { return fail(err); }
  },
);

// 7. dbx_list — paginated listing
server.tool(
  "dbx_list",
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

// 8. dbx_batch_store — store many at once
server.tool(
  "dbx_batch_store",
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

// 9. dbx_extract_facts — fact extraction
server.tool(
  "dbx_extract_facts",
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

// 10. dbx_graph — relationship graph
server.tool(
  "dbx_graph",
  "Get the knowledge graph of relationships between memories. Returns nodes, edges, and breakdowns by type/workspace.",
  {},
  async () => {
    try {
      const graph = await dbx.getGraph();
      return ok(graph);
    } catch (err) { return fail(err); }
  },
);

// 11. dbx_consolidate — deduplication
server.tool(
  "dbx_consolidate",
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

// 12. dbx_export — markdown export
server.tool(
  "dbx_export",
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

// ─── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  // Initialize DBX with bag-of-words fallback (works out of the box, no API key needed).
  // Users can override via environment or by wrapping this file.
  const dataFile = process.env.DBX_DATA_FILE || path.join(process.cwd(), "data.dbx");

  await dbx.init({
    dataFile,
    strictEmbeddings: false,
    embedFn: async (text) => _bowEmbed(text),
    embeddingDim: BOW_DIM,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`dbx-mcp fatal: ${err.message}\n`);
  process.exit(1);
});
