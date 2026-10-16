// test-drain-flush-failure.js — a failed shared flush rejects its writes
//
// Writes that reach the queue in the same tick share one drain: their lock
// bodies run with I/O skipped, then one _persistAll() covers them all. On the
// sync FileStore path _persistAll() rethrows the I/O error. That throw used to
// escape _drainWrites() from inside its setImmediate callback, which left an
// uncaught exception, _draining stuck at true (so no later write ever drained)
// and every promise in the micro-batch unsettled. A single-write drain already
// got this right: the error is thrown inside the lock body, caught, and the
// caller's promise rejects.
//
// The contract in store/file-store.js is that an acknowledged write has been
// fsync'd, so a write whose flush failed must reject, and the engine must keep
// taking writes afterwards.
// Run: node tests/test-drain-flush-failure.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const lib = require("../index");
const { FileStore } = require("../store/file-store");

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-drain-flush-"));
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

/** Fails instead of hanging when a write never settles. */
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const who = { agent: "drain-flush-test" };

// Catch what escapes instead of letting it kill the run, so the test can say
// what went wrong.
const uncaught = [];
process.on("uncaughtException", (err) => { uncaught.push(err); });

(async () => {
  console.log("\n=== a failed flush for a coalesced drain ===\n");

  await test("both coalesced writes reject and the engine keeps taking writes", async () => {
    const dataFile = freshDataFile();
    await lib.init({ dataFile, embedFn: makeMockEmbedder(), embeddingDim: DIM });
    const realPersistAll = FileStore.prototype.persistAll;
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    let flushes = 0;
    FileStore.prototype.persistAll = function (...args) {
      if (++flushes === 1) throw diskFull;
      return realPersistAll.apply(this, args);
    };
    try {
      // Same tick: both lock bodies land in one drain and share its flush.
      const results = await within(Promise.allSettled([
        lib.remember("alpha bravo charlie", { who }),
        lib.remember("delta echo foxtrot", { who }),
      ]), 2000, "the coalesced writes");

      assert.equal(flushes, 1, "the two writes did not share one flush");
      assert.deepEqual(uncaught, [], "the flush error escaped as an uncaught exception");
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, "rejected", `write ${i + 1} was acknowledged though its flush failed`);
        assert.equal(r.reason, diskFull, `write ${i + 1} rejected with something other than the persist error`);
      }

      // The drain must not be wedged: a lone write, then another coalesced
      // pair, still go through and are on disk when acknowledged.
      const id = await within(lib.remember("golf hotel india", { who }), 2000, "a later write");
      assert.ok(onDisk(dataFile).has(id), "the later write is not on disk");

      const before = flushes;
      const [a, b] = await within(Promise.all([
        lib.remember("juliet kilo lima", { who }),
        lib.remember("mike november oscar", { who }),
      ]), 2000, "a later coalesced pair");
      assert.equal(flushes - before, 1, "the later pair did not share one flush");
      const disk = onDisk(dataFile);
      assert.ok(disk.has(a), "the first write of the later pair is not on disk");
      assert.ok(disk.has(b), "the second write of the later pair is not on disk");
      assert.deepEqual(uncaught, [], "an uncaught exception was raised");
    } finally {
      FileStore.prototype.persistAll = realPersistAll;
      await lib.shutdown();
    }
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
