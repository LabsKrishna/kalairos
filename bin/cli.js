#!/usr/bin/env node
// bin/cli.js — Kalairos CLI
// Usage: kalairos start | kalairos status | kalairos query <text> | kalairos model
//        kalairos export [--out file.md] [--include-history]
//        kalairos import <file.md>
"use strict";

const args = process.argv.slice(2);
const cmd  = args[0] || "start";
const PORT = Number(process.env.KALAIROS_PORT) || 3000;

// Flag helpers used by export/import
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(name) { return args.indexOf(name) >= 0; }

// export only reads text, so it needs no real embedder — and must not get one:
// a known embedding width would let init() re-embed and rewrite the store, the
// wrong side effect for a read, and racy beside a running server. A no-op
// embedFn leaves the width unknown, so init() leaves vectors alone.
const noEmbed = async () => [];

if (cmd === "start") {
  require("../server");

} else if (cmd === "status") {
  fetch(`http://localhost:${PORT}/status`)
    .then(r => r.json())
    .then(s => console.log(JSON.stringify(s, null, 2)))
    .catch(() => {
      console.error(`[kalairos] Could not reach server on port ${PORT}. Is it running?`);
      process.exit(1);
    });

} else if (cmd === "query") {
  const text = args.slice(1).join(" ").trim();
  if (!text) {
    console.error("Usage: kalairos query <text>");
    process.exit(1);
  }
  fetch(`http://localhost:${PORT}/query`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ text, limit: 5 }),
  })
    .then(r => r.json())
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(() => {
      console.error(`[kalairos] Could not reach server on port ${PORT}. Is it running?`);
      process.exit(1);
    });

} else if (cmd === "export") {
  // kalairos export [--out file.md] [--include-history] [--data path]
  (async () => {
    const kalairos  = require("..");
    const fs        = require("fs");
    const outPath   = flagValue("--out");
    const dataFile  = flagValue("--data") || process.env.KALAIROS_DATA_FILE || "data.kalairos";
    const history   = hasFlag("--include-history");

    await kalairos.init({ embedFn: noEmbed, dataFile });
    const md = await kalairos.exportMarkdown({ includeHistory: history });
    if (outPath) {
      fs.writeFileSync(outPath, md);
      console.error(`[kalairos] Wrote ${md.length} bytes to ${outPath}`);
    } else {
      process.stdout.write(md);
    }
    await kalairos.shutdown();
  })().catch(err => {
    console.error(`[kalairos] export failed: ${err.message}`);
    process.exit(1);
  });

} else if (cmd === "import") {
  // kalairos import <file.md> [--data path]
  const input = args[1];
  if (!input) {
    console.error("Usage: kalairos import <file.md> [--data data.kalairos]");
    process.exit(1);
  }
  (async () => {
    const kalairos  = require("..");
    const fs        = require("fs");
    const dataFile  = flagValue("--data") || process.env.KALAIROS_DATA_FILE || "data.kalairos";
    const mdText    = fs.readFileSync(input, "utf8");

    // The default embedder, the same one the server and MCP server load, so
    // imported memories are findable there. A private embedder here wrote
    // vectors no other entry point could compare against.
    await kalairos.init({ dataFile });
    const res = await kalairos.importMarkdown(mdText);
    console.error(`[kalairos] Imported ${res.imported} entities → ${dataFile}`);
    await kalairos.shutdown();
  })().catch(err => {
    console.error(`[kalairos] import failed: ${err.message}`);
    process.exit(1);
  });

} else if (cmd === "model") {
  // kalairos model [--force] — fetch the neural embedder. postinstall tries
  // this too, but pnpm, bun, --ignore-scripts and CI all skip postinstall.
  require("../scripts/download-model")
    .downloadModel({ force: hasFlag("--force") })
    .catch(err => {
      console.error(`[kalairos] model download failed: ${err.message}`);
      process.exit(1);
    });

} else if (cmd === "migrate") {
  console.error("[kalairos] 'kalairos migrate' requires Kalairos Enterprise (PostgreSQL/pgvector).");
  console.error("  See https://github.com/LabsKrishna/kalairos#enterprise for upgrade information.");
  process.exit(1);

} else {
  console.log("Kalairos CLI");
  console.log("");
  console.log("Usage:");
  console.log("  kalairos start                     Start the server (default port 3000)");
  console.log("  kalairos status                    Print server status as JSON");
  console.log('  kalairos query <text>              Run a semantic query against the server');
  console.log("  kalairos export [--out file.md]    Dump local memory as human-readable markdown");
  console.log("         [--include-history]         ...include full version history per entity");
  console.log("         [--data <path>]             ...override data file (default: data.kalairos)");
  console.log("  kalairos import <file.md>          Ingest a markdown file back into local memory");
  console.log("         [--data <path>]             ...override data file (default: data.kalairos)");
  console.log("  kalairos model [--force]           Download the neural embedder to ~/.kalairos (~105 MB)");
  console.log("  kalairos migrate [file]            [Enterprise] Import data.kalairos → PostgreSQL");
  console.log("");
  console.log("Environment:");
  console.log("  KALAIROS_PORT              Server port (default: 3000)");
  console.log("  KALAIROS_DATA_FILE         Default data file for export/import (default: data.kalairos)");
  console.log("  KALAIROS_RATE_LIMIT        Max requests/minute per IP (default: 120, 0=off)");
  console.log("  KALAIROS_LINK_THRESHOLD    Graph link threshold (default: 0.72)");
  console.log("  KALAIROS_VERSION_THRESHOLD Version detection threshold (default: 0.82)");
  console.log("  KALAIROS_MAX_TEXT_LEN      Max characters per ingested memory (default: 5000)");
  console.log("  KALAIROS_WRITE_QUEUE_MAX   Max pending concurrent writes before 429 (default: 500)");
  process.exit(cmd === "help" ? 0 : 1);
}
