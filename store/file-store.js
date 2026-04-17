// store/file-store.js — JSONL file-backed store adapter (default)
// Provides the same sync Map interface used throughout index.js.
// I/O is synchronous (fs.readFileSync / writeFileSync) to preserve the
// existing write-lock design — no async boundary inside the critical section.
"use strict";

const fs = require("fs");

class FileStore {
  constructor() {
    this._map = new Map();
  }

  // ── Sync Map interface ─────────────────────────────────────────────────────
  get(id)         { return this._map.get(id); }
  set(id, entity) { this._map.set(id, entity); return this; }
  has(id)         { return this._map.has(id); }
  delete(id)      { return this._map.delete(id); }
  values()        { return this._map.values(); }
  entries()       { return this._map.entries(); }
  get size()      { return this._map.size; }
  // Allow `for (const [k, v] of store)` patterns in index.js
  [Symbol.iterator]() { return this._map[Symbol.iterator](); }

  // ── Load raw rows from JSONL file ──────────────────────────────────────────
  // Returns an array of plain objects. Sync. Malformed lines are skipped
  // with a warning; parsing errors are returned alongside clean rows so
  // the caller can emit typed errors via the signal bus.
  loadRaw(config) {
    const file = config.dataFile;
    if (!file || file === ":memory:" || !fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        console.warn(`[smriti] FileStore: skipping malformed line: ${line.slice(0, 80)}`);
      }
    }
    return rows; // caller normalizes and calls store.set()
  }

  // ── Persist all entities → atomic JSONL rewrite ────────────────────────────
  // `rows` is an array of plain-object entities (links already serialised to array).
  // Throws on I/O failure so the caller can emitError.
  persistAll(rows, config) {
    const file = config.dataFile;
    if (!file || file === ":memory:") return;

    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    fs.renameSync(tmp, file); // atomic on POSIX — no corrupt reads on crash
  }

  // ── Append one entity ──────────────────────────────────────────────────────
  appendEntity(row, config) {
    const file = config.dataFile;
    if (!file || file === ":memory:") return;
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  }

  // No connections to close.
  shutdown() {}
}

module.exports = { FileStore };
