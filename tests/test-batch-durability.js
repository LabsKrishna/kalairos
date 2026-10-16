// test-batch-durability.js — a write acknowledged during a batch is on disk
//
// ingestBatch(), extractFacts() and importMarkdown() skip per-item I/O and
// flush once at the end. That suppression used to be a module-wide counter
// held above zero across the batch's awaits, so ANY write that landed in that
// window (a remember() from another caller, kalairos_remember over MCP while
// kalairos_batch_store runs) was applied in memory and acknowledged without
// reaching disk. A crash or SIGKILL before the batch's flush lost it.
//
// The contract in store/file-store.js is that an acknowledged write has been
// fsync'd. Each test holds a batch open on a slow embed, makes an unrelated
// write, and reads the JSONL straight off disk after the acknowledgement:
// what is in the file at that moment is exactly what survives a SIGKILL.
// The last case holds shutdown() to the same rule for a write already queued
// when it starts.
// Run: node tests/test-batch-durability.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const lib = require("../index");
const { WorkerPool } = require("../worker-pool");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}`); console.log(`       ${e.message}`); failed++; }
}

const DIM = 64;

// Bag-of-words embedder: texts with no words in common score 0, so nothing in
// these tests merges into anything else by accident.
function makeMockEmbedder() {
  const vocab = new Map();
  return async function embed(text) {
    const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
    const vec   = new Array(DIM).fill(0);
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
      vec[vocab.get(w) % DIM]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

/** The mock embedder, except that embedding `holdText` waits for release(). */
function gatedEmbedder(holdText) {
  const base = makeMockEmbedder();
  let release, entered;
  const held    = new Promise(r => { release = r; });
  const reached = new Promise(r => { entered = r; });
  const embed = async (text, type) => {
    if (text === holdText) { entered(); await held; }
    return base(text, type);
  };
  return { embed, reached, release };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-batch-durability-"));
let counter = 0;
function freshDataFile() {
  const dir = path.join(tmpRoot, `run-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "data.kalairos");
}

/** The entities on disk right now, last row per id wins (as a reload would). */
function onDisk(dataFile) {
  const byId = new Map();
  if (!fs.existsSync(dataFile)) return byId;
  for (const line of fs.readFileSync(dataFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byId.set(row.id, row);
  }
  return byId;
}

const textsOnDisk = (dataFile) => [...onDisk(dataFile).values()].map(r => r.text);
const who = { agent: "durability-test" };

const HELD = "delta echo foxtrot";

(async () => {
  console.log("\n=== writes acknowledged during a batch are durable ===\n");

  await test("a remember() acknowledged mid-ingestBatch is on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({ dataFile, embedFn: gate.embed, embeddingDim: DIM });
    try {
      const batch = lib.ingestBatch([{ text: "alpha bravo charlie" }, { text: HELD }]);
      await gate.reached; // first item applied, second held in its embed

      const id = await lib.remember("golf hotel india", { who });
      assert.ok(onDisk(dataFile).has(id), "the acknowledged write is not on disk");

      gate.release();
      const ids = await batch;
      const disk = onDisk(dataFile);
      for (const bid of ids) assert.ok(disk.has(bid), `batch row ${bid} missing after the flush`);
      assert.ok(disk.has(id), "the concurrent write was lost by the batch's flush");
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  await test("a remember() acknowledged mid-extractFacts is on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({
      dataFile, embedFn: gate.embed, embeddingDim: DIM,
      factExtractFn: async () => ["juliet kilo lima", HELD],
    });
    try {
      const extraction = lib.extractFacts("notes from the standup");
      await gate.reached;

      const id = await lib.remember("mike november oscar", { who });
      assert.ok(onDisk(dataFile).has(id), "the acknowledged write is not on disk");

      gate.release();
      const { ids } = await extraction;
      const disk = onDisk(dataFile);
      for (const fid of ids) assert.ok(disk.has(fid), `extracted fact ${fid} missing after the flush`);
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  // Two writes that reach the queue in the same tick are coalesced into one
  // drain with a single flush. That flush must not be swallowed by a batch.
  await test("coalesced writes acknowledged mid-batch are on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({ dataFile, embedFn: gate.embed, embeddingDim: DIM });
    try {
      const batch = lib.ingestBatch([{ text: "alpha bravo charlie" }, { text: HELD }]);
      await gate.reached;

      const [a, b] = await Promise.all([
        lib.remember("papa quebec romeo", { who }),
        lib.remember("sierra tango uniform", { who }),
      ]);
      const disk = onDisk(dataFile);
      assert.ok(disk.has(a), "the first coalesced write is not on disk");
      assert.ok(disk.has(b), "the second coalesced write is not on disk");

      gate.release();
      await batch;
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  // remove() goes through _persistAll() rather than an append; a delete that
  // is lost comes back from the dead on the next start.
  await test("a remove() acknowledged mid-batch is on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({ dataFile, embedFn: gate.embed, embeddingDim: DIM });
    try {
      const id = await lib.remember("victor whiskey xray", { who });
      const batch = lib.ingestBatch([{ text: "alpha bravo charlie" }, { text: HELD }]);
      await gate.reached;

      await lib.remove(id);
      assert.ok(onDisk(dataFile).get(id)?.deletedAt, "the acknowledged delete is not on disk");

      gate.release();
      await batch;
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  await test("a batch that finishes while another is in flight is on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({ dataFile, embedFn: gate.embed, embeddingDim: DIM });
    try {
      const slow = lib.ingestBatch([{ text: "alpha bravo charlie" }, { text: HELD }]);
      await gate.reached;

      const ids = await lib.ingestBatch([{ text: "yankee zulu" }, { text: "amber cobalt" }]);
      const disk = onDisk(dataFile);
      for (const id of ids) assert.ok(disk.has(id), `row ${id} of the finished batch is not on disk`);

      gate.release();
      await slow;
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  // The fix must not trade away what batching is for: the batch's own items
  // still skip per-item I/O and land in its one flush at the end.
  await test("a batch's own writes still wait for its single flush", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await lib.init({ dataFile, embedFn: gate.embed, embeddingDim: DIM });
    try {
      const batch = lib.ingestBatch([{ text: "alpha bravo charlie" }, { text: HELD }]);
      await gate.reached;
      assert.deepEqual(textsOnDisk(dataFile), [], "a batch item was written before the batch finished");

      await lib.remember("golf hotel india", { who });
      assert.deepEqual(textsOnDisk(dataFile), ["golf hotel india"],
        "an unrelated write flushed the batch's items one by one");

      gate.release();
      await batch;
      assert.deepEqual(textsOnDisk(dataFile).sort(), ["alpha bravo charlie", HELD, "golf hotel india"].sort());
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  console.log("\n=== a write queued at shutdown() is durable ===\n");

  // A write whose lock body is queued but not yet run when shutdown() starts
  // used to depend on something inside shutdown() yielding a macrotask so the
  // drain's setImmediate could fire. Terminating worker threads happens to do
  // that; a pool that stops at once does not, and shutdown() then resolved
  // with the write still queued (and a following init() dropped it).
  await test("a write queued when shutdown() starts is on disk when it resolves", async () => {
    const dataFile = freshDataFile();
    await lib.init({ dataFile, embedFn: makeMockEmbedder(), embeddingDim: DIM });
    const realStop = WorkerPool.prototype.stop;
    let pool = null;
    WorkerPool.prototype.stop = async function () { pool = this; };
    try {
      const write = lib.remember("golf hotel india", { who });
      // Let the ingest reach the write queue. Its embed and checks resolve as
      // microtasks, so no macrotask (the drain's setImmediate) runs here.
      for (let i = 0; i < 1000; i++) await null;

      await lib.shutdown();
      assert.deepEqual(textsOnDisk(dataFile), ["golf hotel india"],
        "shutdown() resolved before the queued write reached disk");
      await write;
    } finally {
      WorkerPool.prototype.stop = realStop;
      if (pool) await realStop.call(pool);
    }
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
