// services/dep-graph-builder/tail.js
//
// JSONL polling helper. Reads new bytes off the canonical ledger and
// dispatches each complete line as a parsed record. The Node service
// is a read-only consumer — writes go through the Python LedgerServer.
//
// Tracks byte offset so it doesn't reprocess older records on restart;
// the caller can seed `startOffset` to resume from a known position.
// Partial trailing lines (mid-write) are not consumed until the next
// poll picks up the rest.
"use strict";

const fs = require("node:fs/promises");


async function tailJsonl(jsonlPath, intervalMs, onRecord, opts = {}) {
  const { startOffset = 0, signal } = opts;
  let offset = startOffset;

  while (!signal?.aborted) {
    let size = 0;
    try {
      const stat = await fs.stat(jsonlPath);
      size = stat.size;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // File doesn't exist yet — wait and retry. Python creates the
      // file lazily on first append.
    }

    if (size > offset) {
      const fd = await fs.open(jsonlPath, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await fd.read(buf, 0, size - offset, offset);
        const text = buf.toString("utf-8");
        // split on \n; the last element is either '' (file ended on \n,
        // safe to consume) or a partial line (only consume what's
        // before the last \n so we don't double-process the trailing
        // half on the next poll).
        const parts = text.split("\n");
        const tail = parts.pop();
        let consumedBytes = 0;
        for (const line of parts) {
          consumedBytes += Buffer.byteLength(line, "utf-8") + 1;
          if (!line) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch (err) {
            console.warn(
              `[tail] skipping malformed JSONL line: ${err.message}`,
            );
            continue;
          }
          try {
            await onRecord(record);
          } catch (err) {
            console.warn(`[tail] onRecord raised: ${err.message}`);
          }
        }
        offset += consumedBytes;
      } finally {
        await fd.close();
      }
    }

    await _sleep(intervalMs);
  }
}


function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


module.exports = { tailJsonl };
