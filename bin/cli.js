#!/usr/bin/env node
// bin/cli.js — Smriti CLI
// Usage: smriti start | smriti status | smriti query <text>
"use strict";

const args = process.argv.slice(2);
const cmd  = args[0] || "start";
const PORT = Number(process.env.SMRITI_PORT) || 3000;

if (cmd === "start") {
  require("../server");

} else if (cmd === "demo") {
  require("../examples/demo");

} else if (cmd === "status") {
  fetch(`http://localhost:${PORT}/status`)
    .then(r => r.json())
    .then(s => console.log(JSON.stringify(s, null, 2)))
    .catch(() => {
      console.error(`[smriti] Could not reach server on port ${PORT}. Is it running?`);
      process.exit(1);
    });

} else if (cmd === "query") {
  const text = args.slice(1).join(" ").trim();
  if (!text) {
    console.error("Usage: smriti query <text>");
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
      console.error(`[smriti] Could not reach server on port ${PORT}. Is it running?`);
      process.exit(1);
    });

} else if (cmd === "migrate") {
  console.error("[smriti] 'smriti migrate' requires Smriti Enterprise (PostgreSQL/pgvector).");
  console.error("  See https://github.com/LabsKrishna/smriti-db#enterprise for upgrade information.");
  process.exit(1);

} else {
  console.log("Smriti CLI");
  console.log("");
  console.log("Usage:");
  console.log("  smriti start            Start the server (default port 3000)");
  console.log("  smriti demo             Run interactive demo (no API key needed)");
  console.log("  smriti status           Print server status as JSON");
  console.log('  smriti query <text>     Run a semantic query against the server');
  console.log("  smriti migrate [file]   [Enterprise] Import data.smriti → PostgreSQL");
  console.log("");
  console.log("Environment:");
  console.log("  SMRITI_PORT              Server port (default: 3000)");
  console.log("  SMRITI_RATE_LIMIT        Max requests/minute per IP (default: 120, 0=off)");
  console.log("  SMRITI_LINK_THRESHOLD    Graph link threshold (default: 0.72)");
  console.log("  SMRITI_VERSION_THRESHOLD Version detection threshold (default: 0.82)");
  process.exit(cmd === "help" ? 0 : 1);
}
