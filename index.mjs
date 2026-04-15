// index.mjs — ESM wrapper for Database X Core Engine
// Enables `import dbx from "dbx-memory"` in ESM environments (e.g. OpenClaw plugins).

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const lib = require("./index.js");

// Re-export every named export from the CJS module.
export const {
  init,
  ingest,
  remember,
  ingestBatch,
  extractFacts,
  ingestTimeSeries,
  ingestFile,
  query,
  get,
  getMany,
  remove,
  purge,
  consolidate,
  getGraph,
  traverse,
  listEntities,
  getHistory,
  getStatus,
  exportMarkdown,
  importMarkdown,
  shutdown,
  createAgent,
  auth,
  onSignal,
  getSignals,
} = lib;

// Default export — the full library object.
export default lib;
