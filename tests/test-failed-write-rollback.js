// test-failed-write-rollback.js — a write that rejects leaves nothing behind
//
// A write whose persist fails rejects, as the durability contract in
// store/file-store.js requires. Its mutation used to stay in the in-memory
// store, though, and the next _persistAll() rewrites the whole JSONL from
// memory, so a later, unrelated write put the rejected row on disk anyway:
// the caller was told it failed, and a reload brought it back. Reads served it
// in the meantime too. That held for a lone write (its lock body mutates the
// store, then its own append or flush throws) and for writes coalesced into
// one drain whose shared flush failed.
//
// What must hold: after a write rejects, memory is exactly what it was before
// that write, so no later flush can write it out, and other in-flight work
// (a running batch op) is untouched.
// Run: node tests/test-failed-write-rollback.js
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

// Bag-of-words over letters only, so texts that differ only in digits embed
// identically. Cosine is (shared words) / sqrt(words × words): with the
// default thresholds, 3 of 4 shared words (0.75) links two entities without
// merging them, and 4 of 5 (0.89) makes the second an update of the first.
// One instance per data file: a reload must see the same vocabulary.
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-write-rollback-"));
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

/** Every row on disk holding this text, current or in its history. */
function rowsWithText(dataFile, text) {
  return [...onDisk(dataFile).values()].filter(row =>
    row.text === text || (row.versions || []).some(v => v.text === text));
}

const diskFull = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

/** Make the next call to FileStore.prototype[method] throw; returns the error and a restore. */
function failNext(method) {
  const real = FileStore.prototype[method];
  const err  = diskFull();
  let armed  = true;
  FileStore.prototype[method] = function (...args) {
    if (armed) { armed = false; throw err; }
    return real.apply(this, args);
  };
  return { err, restore: () => { FileStore.prototype[method] = real; } };
}

const who = { agent: "write-rollback-test" };

async function open(dataFile, embedFn) {
  await lib.init({ dataFile, embedFn, embeddingDim: DIM });
}

/**
 * Everything in memory, as shutdown()'s final flush writes it, then reopen.
 * Taken twice before an op (the first pass settles what a load normalizes),
 * so a rollback that restores memory exactly compares equal.
 */
async function snapshot(dataFile, embedFn) {
  await lib.shutdown();
  const rows = [...onDisk(dataFile).entries()].sort(([a], [b]) => a - b);
  await open(dataFile, embedFn);
  return rows;
}

/**
 * A store with a linked pair (a, b), an unrelated entity (c), a soft-deleted
 * one (d) and an exact duplicate pair (e, f) for consolidate.
 */
async function seeded() {
  const dataFile = freshDataFile();
  const embedFn  = makeMockEmbedder();
  await open(dataFile, embedFn);
  const ids = {};
  ids.a = await lib.remember("alpha bravo charlie delta", { who });
  ids.b = await lib.remember("alpha bravo charlie echo", { who });
  ids.c = await lib.remember("kilo lima mike november", { who });
  ids.d = await lib.remember("sierra tango uniform victor", { who });
  await lib.forget(ids.d, { who, reason: "seed" });
  ids.e = await lib.ingest("whiskey xray yankee zulu", { who });
  ids.f = await lib.ingest("whiskey xray yankee zulu", { who, forceNew: true });
  await snapshot(dataFile, embedFn);
  const baseline = await snapshot(dataFile, embedFn);
  return { dataFile, embedFn, ids, baseline };
}

(async () => {
  console.log("\n=== a rejected write does not reach disk through a later flush ===\n");

  await test("a lone new write whose append fails stays off disk after a later flush", async () => {
    const dataFile = freshDataFile();
    await open(dataFile, makeMockEmbedder());
    const rejected = "alpha bravo charlie delta";
    const append = failNext("appendEntity");
    try {
      await assert.rejects(lib.remember(rejected, { who }), append.err);
    } finally { append.restore(); }
    try {
      // Same tick: one drain, one _persistAll() that rewrites the whole file.
      await Promise.all([
        lib.remember("echo foxtrot golf hotel", { who }),
        lib.remember("india juliet kilo lima", { who }),
      ]);
      assert.deepEqual(rowsWithText(dataFile, rejected), [], "the rejected write is on disk");
      assert.equal(onDisk(dataFile).size, 2, "something other than the later pair is on disk");
      const { entities } = await lib.listEntities({ limit: 100 });
      assert.ok(!entities.some(e => e.text === rejected), "the rejected write is still served from memory");
    } finally { await lib.shutdown(); }
  });

  await test("a lone update whose flush fails stays off disk after a later flush", async () => {
    const dataFile = freshDataFile();
    await open(dataFile, makeMockEmbedder());
    try {
      const id = await lib.remember("alpha bravo charlie delta", { who });
      const rejected = "alpha bravo charlie delta golf"; // 4 of 5 words: an update of id
      const flush = failNext("persistAll");
      try {
        await assert.rejects(lib.remember(rejected, { who }), flush.err);
      } finally { flush.restore(); }
      await Promise.all([
        lib.remember("mike november oscar papa", { who }),
        lib.remember("quebec romeo sierra tango", { who }),
      ]);
      assert.deepEqual(rowsWithText(dataFile, rejected), [], "the rejected update is on disk");
      const row = onDisk(dataFile).get(id);
      assert.equal(row.text, "alpha bravo charlie delta", "the entity's current text is the rejected one");
      assert.equal(row.versions.length, 1, "the rejected update left a version behind");
      assert.equal(row.versions[0].validTo, null, "the rejected update closed the prior version");
    } finally { await lib.shutdown(); }
  });

  await test("coalesced writes whose shared flush fails stay off disk after a later flush", async () => {
    const dataFile = freshDataFile();
    await open(dataFile, makeMockEmbedder());
    try {
      const rejected = ["alpha bravo charlie delta", "echo foxtrot golf hotel"];
      const flush = failNext("persistAll");
      let results;
      try {
        results = await Promise.allSettled(rejected.map(t => lib.remember(t, { who })));
      } finally { flush.restore(); }
      for (const r of results) assert.equal(r.status, "rejected", "a write was acknowledged though its flush failed");
      await Promise.all([
        lib.remember("india juliet kilo lima", { who }),
        lib.remember("mike november oscar papa", { who }),
      ]);
      for (const text of rejected) {
        assert.deepEqual(rowsWithText(dataFile, text), [], `the rejected "${text}" is on disk`);
      }
      assert.equal(onDisk(dataFile).size, 2, "something other than the later pair is on disk");
    } finally { await lib.shutdown(); }
  });

  console.log("\n=== memory after a rejected write is exactly what it was before it ===\n");

  // Each op runs with its persist failing once, then shutdown()'s final flush
  // writes memory out and that must match the baseline row for row: links on
  // neighbours, versions, validTo, trail events, metadata, deletion marks.
  const cases = [
    ["a new entity that links to two others", "appendEntity",
      ()    => lib.remember("alpha bravo charlie foxtrot", { who })],
    ["an update that drops a link", "persistAll",
      ({ a }) => lib.remember("alpha bravo charlie delta golf", { who }).then(id => assert.equal(id, a))],
    ["a reaffirm", "persistAll",
      ()    => lib.remember("alpha bravo charlie delta", { who })],
    ["a forget", "persistAll",
      ({ a }) => lib.forget(a, { who, reason: "test" })],
    ["a restore", "persistAll",
      ({ d }) => lib.restore(d, { who, reason: "test" })],
    ["a purge", "persistAll",
      ({ a }) => lib.purge(a)],
    ["an annotate", "persistAll",
      ({ a }) => lib.annotate(a, { trustScore: 0.1, notes: "checked", verified: true, who })],
    ["a consolidate", "persistAll",
      ()    => lib.consolidate()],
    ["a coalesced update and a merge into the entity it just updated", "persistAll",
      ()    => Promise.all([
        lib.remember("alpha bravo charlie delta golf", { who }),
        lib.remember("alpha bravo charlie delta hotel", { who }),
      ])],
  ];

  for (const [name, method, op] of cases) {
    await test(`${name}: rejected and fully undone`, async () => {
      const { dataFile, embedFn, ids, baseline } = await seeded();
      try {
        const io = failNext(method);
        try {
          await assert.rejects(op(ids), io.err);
        } finally { io.restore(); }
        assert.deepEqual(await snapshot(dataFile, embedFn), baseline, "memory differs from before the rejected write");
      } finally { await lib.shutdown(); }
    });
  }

  console.log("\n=== a rejected write does not disturb a batch in flight ===\n");

  await test("a lone write that fails mid-batch leaves the batch's items to its own flush", async () => {
    const dataFile = freshDataFile();
    const embed = makeMockEmbedder();
    // Hold the batch's second item in its embedding step, so a lone write
    // runs between the batch's two items.
    let release;
    const gate = new Promise(r => { release = r; });
    let reached;
    const atGate = new Promise(r => { reached = r; });
    const embedFn = async (text) => {
      if (text.includes("gated")) { reached(); await gate; }
      return embed(text);
    };
    await open(dataFile, embedFn);
    try {
      const batch = lib.ingestBatch([
        { text: "alpha bravo charlie delta" },
        { text: "gated echo foxtrot golf" },
      ]);
      await atGate; // the first item is in memory, unflushed

      const rejected = "alpha bravo charlie hotel"; // links to the batch's first item
      const append = failNext("appendEntity");
      try {
        await assert.rejects(lib.remember(rejected, { who }), append.err);
      } finally { append.restore(); }

      release();
      const [first, second] = await batch;
      const disk = onDisk(dataFile);
      assert.ok(disk.has(first), "the batch's first item is not on disk");
      assert.ok(disk.has(second), "the batch's second item is not on disk");
      assert.deepEqual(disk.get(first).links, [], "the batch's first item kept a link to the rejected write");
      assert.deepEqual(rowsWithText(dataFile, rejected), [], "the rejected write is on disk");
    } finally { await lib.shutdown(); }
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
