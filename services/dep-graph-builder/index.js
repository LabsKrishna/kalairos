// services/dep-graph-builder/index.js
//
// Node-side dep-graph builder — the JS counterpart to the Python
// HandoffNode in `python/src/kalairos/agents/pr_risk.py`. Listens for
// `handoff_requested` events tagged with this service's name, parses
// imports/requires from the changed files, and POSTs a
// `handoff_result` back through the Python LedgerServer so the Python
// executor unblocks and feeds the dep graph into its summarize step.
//
// Read-only on the JSONL (the architecture: Python is sole writer).
// Writes happen via HTTP — same path any other Node microservice
// would use to talk to the ledger.
//
// Run:
//   KALAIROS_LEDGER_JSONL=/path/to/ledger.jsonl \
//   KALAIROS_LEDGER_URL=http://127.0.0.1:8765 \
//   KALAIROS_REPO_ROOT=/path/to/repo \
//   node services/dep-graph-builder/index.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { tailJsonl } = require("./tail");
const { parseImports } = require("./parser");

const SERVICE_NAME = "kalairos-dep-graph-builder";
const DEFAULT_LEDGER_URL = "http://127.0.0.1:8765";
const POLL_INTERVAL_MS = 500;


async function main() {
  const jsonlPath = process.env.KALAIROS_LEDGER_JSONL;
  if (!jsonlPath) {
    console.error(
      "error: KALAIROS_LEDGER_JSONL is not set (path to ledger.jsonl)",
    );
    process.exit(1);
  }
  const ledgerUrl = process.env.KALAIROS_LEDGER_URL || DEFAULT_LEDGER_URL;
  const repoRoot = process.env.KALAIROS_REPO_ROOT || process.cwd();

  console.log(`[dep-graph-builder] service ${SERVICE_NAME}`);
  console.log(`[dep-graph-builder] watching ${jsonlPath}`);
  console.log(`[dep-graph-builder] ledger ${ledgerUrl}`);
  console.log(`[dep-graph-builder] repo root ${repoRoot}`);

  await tailJsonl(jsonlPath, POLL_INTERVAL_MS, async (record) => {
    await handleRecord(record, { ledgerUrl, repoRoot });
  });
}


// Exported so tests can drive the dispatch without spinning up a tail
// loop. Production code path is identical: tailJsonl → handleRecord.
async function handleRecord(record, ctx) {
  const md = record && record.metadata;
  if (!md || md.event_type !== "handoff_requested") return;
  const payload = md.payload || {};
  if (payload.service !== SERVICE_NAME) return;

  const handoffId = payload.handoff_id;
  const filesText = (payload.input && payload.input.files) || "";
  const paths = filesText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    `[dep-graph-builder] handoff=${handoffId} files=${paths.length}`,
  );

  try {
    const depGraph = buildDepGraph(paths, ctx.repoRoot);
    await postResult(ctx.ledgerUrl, handoffId, depGraph, null);
    console.log(
      `[dep-graph-builder] handoff=${handoffId} → ` +
        `${depGraph.nodes.length} nodes, ${depGraph.edges.length} edges`,
    );
  } catch (err) {
    console.error(
      `[dep-graph-builder] handoff=${handoffId} failed: ${err.message}`,
    );
    // Even on failure we have to ack — otherwise Python blocks until
    // its timeout. Reporting `error` lets the Python side fail fast
    // with the underlying reason instead of "timeout".
    try {
      await postResult(ctx.ledgerUrl, handoffId, null, String(err));
    } catch (postErr) {
      console.error(
        `[dep-graph-builder] failed to post error result: ${postErr.message}`,
      );
    }
  }
}


// Build a `{nodes, edges}` dep graph by reading the changed files and
// parsing their imports. Files that don't exist locally (PR checked
// out elsewhere, or a deletion) are kept as nodes with no outgoing
// edges — the Python summarizer can still note "file removed" from
// the diff.
function buildDepGraph(paths, repoRoot) {
  const nodes = paths.slice();
  const edges = [];
  for (const p of paths) {
    const abs = path.resolve(repoRoot, p);
    let content;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    for (const imp of parseImports(p, content)) {
      edges.push({ from: p, to: imp });
    }
  }
  return { nodes, edges };
}


async function postResult(ledgerUrl, handoffId, result, error) {
  const ts = Date.now();
  const payload = { handoff_id: handoffId, result, error };
  const text = JSON.stringify(payload);
  const record = {
    id: `handoff/${handoffId}/result`,
    text,
    type: "handoff-event",
    memoryType: "long-term",
    workspaceId: "agent-runs",
    tags: ["handoff-event", "handoff_result", `handoff:${handoffId}`],
    versions: [{ timestamp: ts, text, ingestAt: ts }],
    metadata: {
      event_type: "handoff_result",
      payload,
    },
  };
  const resp = await fetch(`${ledgerUrl}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`POST /append failed: ${resp.status} ${body}`);
  }
  return resp.json();
}


if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}


module.exports = {
  SERVICE_NAME,
  buildDepGraph,
  handleRecord,
  postResult,
};
