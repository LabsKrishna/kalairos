// test-batch-atomicity.js — a batch op that rejects leaves nothing behind
//
// ingestBatch(), extractFacts() and importMarkdown() used to write each item
// as its own write, with its I/O skipped, and flush once at the end. When that
// flush failed, or an item rejected partway, the call rejected but the items
// already written stayed in memory, and the next flush (which rewrites the
// whole JSONL from memory) put them on disk. Worse, other writes run between
// a batch's items while it awaits each embedding, and any one of them that
// flushed wrote the batch's earlier items to disk before the batch had
// finished, or failed. The contract in store/file-store.js is that a write
// that is rejected must not end up stored, and ingestBatch is documented as
// atomic.
//
// What must hold: a batch op that rejects leaves memory and disk exactly as
// they were, and until it resolves none of its items can be read or flushed.
// Writes that interleave with it are kept whatever the batch does.
// Run: node tests/test-batch-atomicity.js
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
  // First line only: a deepEqual over whole stores prints a diff thousands of lines long.
  catch (e) { console.log(`  ❌  ${name}`); console.log(`       ${e.message.split("\n")[0]}`); failed++; }
}

const DIM = 64;

// Bag-of-words over letters only. Cosine is (shared words) / sqrt(words ×
// words): with the default thresholds, 3 of 4 shared words (0.75) links two
// entities without merging them, and 4 of 5 (0.89) makes the second an update
// of the first. One instance per data file: a reload must see the same vocabulary.
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

/** A mock embedder, except that embedding `holdText` waits for release(). */
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-batch-atomicity-"));
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

/** True if a read serves an entity whose current text is this. */
async function served(text) {
  const { entities } = await lib.listEntities({ limit: 100 });
  return entities.some(e => e.text === text);
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

const who = { agent: "batch-atomicity-test" };

// extractFacts() gets its facts from this: one per ";"-separated part.
const factExtractFn = async (text) => text.split(";").map(s => s.trim());

async function open(dataFile, embedFn) {
  await lib.init({ dataFile, embedFn, embeddingDim: DIM, factExtractFn });
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

/** A store with a linked pair (a, b), an unrelated entity (c) and a soft-deleted one (d). */
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
  await snapshot(dataFile, embedFn);
  const baseline = await snapshot(dataFile, embedFn);
  return { dataFile, embedFn, ids, baseline };
}

// Items that change the seeded store in every way an item can: a new entity
// linked to a and b, an update of a, a merge into c, and a new entity that
// the batch's own last item then updates.
const ITEMS = [
  "alpha bravo charlie foxtrot",
  "alpha bravo charlie delta golf",
  "kilo lima mike november",
  "oscar papa quebec romeo",
  "oscar papa quebec romeo hotel",
];
const TOO_LONG = "x".repeat(6000); // over the default maxTextLen of 5000

// The three batch ops, each fed a list of texts; each resolves with the ids.
const OPS = {
  ingestBatch:    (texts, opts) => lib.ingestBatch(texts.map(text => ({ text })), opts),
  extractFacts:   (texts)       => lib.extractFacts(texts.join(" ; "), { who }).then(r => r.ids),
  importMarkdown: (texts)       => lib.importMarkdown(texts.map(t => `- ${t}`).join("\n")).then(r => r.ids),
};

(async () => {
  console.log("\n=== a batch op that rejects leaves the store as it found it ===\n");

  for (const [name, op] of Object.entries(OPS)) {
    await test(`${name} whose flush fails: rejected and fully undone`, async () => {
      const { dataFile, embedFn, baseline } = await seeded();
      try {
        const io = failNext("persistAll");
        try {
          await assert.rejects(op(ITEMS), io.err);
        } finally { io.restore(); }
        // ITEMS[2] is c's own text, which is on disk anyway.
        for (const text of ITEMS.filter((_, i) => i !== 2)) {
          assert.deepEqual(rowsWithText(dataFile, text), [], `the rejected item "${text}" is on disk`);
          assert.ok(!(await served(text)), `the rejected item "${text}" is still served`);
        }
        assert.deepEqual(await snapshot(dataFile, embedFn), baseline, "memory differs from before the rejected batch");
      } finally { await lib.shutdown(); }
    });

    await test(`${name} with an item that rejects: no earlier item stays`, async () => {
      const { dataFile, embedFn, baseline } = await seeded();
      try {
        await assert.rejects(op([...ITEMS, TOO_LONG]), { code: "ERR_TEXT_TOO_LONG" });
        assert.deepEqual(await snapshot(dataFile, embedFn), baseline, "memory differs from before the rejected batch");
      } finally { await lib.shutdown(); }
    });
  }

  await test("ingestBatch with an item the caller may not write: no earlier item stays", async () => {
    const { dataFile, embedFn, baseline } = await seeded();
    try {
      const items = [...ITEMS.map(text => ({ text })), { text: "zulu yankee xray", workspaceId: "elsewhere" }];
      await assert.rejects(lib.ingestBatch(items, { allowedWorkspaces: ["default"] }), { code: "ERR_FORBIDDEN" });
      assert.deepEqual(await snapshot(dataFile, embedFn), baseline, "memory differs from before the rejected batch");
    } finally { await lib.shutdown(); }
  });

  console.log("\n=== a batch op that succeeds still commits every item, in order ===\n");

  // The rejection cases above prove nothing unless these items really change
  // the store, and the fix must keep each item seeing the ones before it.
  for (const [name, op] of Object.entries(OPS)) {
    await test(`${name} commits all its items, each seeing the ones before it`, async () => {
      const { dataFile, embedFn, ids, baseline } = await seeded();
      try {
        const out = await op(ITEMS);
        assert.equal(out.length, ITEMS.length);
        const disk = onDisk(dataFile);
        for (const id of out) assert.ok(disk.has(id), `item ${id} is not on disk when the batch resolves`);
        assert.equal(out[1], ids.a, "the update of a became a new entity");
        assert.equal(out[2], ids.c, "the repeat of c became a new entity");
        assert.equal(out[4], out[3], "the last item did not update the batch's own earlier item");
        assert.equal(disk.get(out[3]).text, ITEMS[4]);
        assert.ok(disk.get(ids.b).links.includes(out[0]), "b has no link to the batch's new neighbour");
        assert.notDeepEqual(await snapshot(dataFile, embedFn), baseline);
      } finally { await lib.shutdown(); }
    });
  }

  console.log("\n=== writes that interleave with a batch ===\n");

  const HELD = "golf hotel india juliet";

  await test("an unfinished batch is not served, and another write's flush does not write it", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await open(dataFile, gate.embed);
    try {
      const c = await lib.remember("kilo lima mike november", { who });
      const batch = lib.ingestBatch([{ text: "alpha bravo charlie delta" }, { text: HELD }]);
      await gate.reached; // the batch is past its first item, held in its second

      // An update rewrites the whole JSONL from memory.
      assert.equal(await lib.remember("kilo lima mike november oscar", { who }), c);
      assert.deepEqual(rowsWithText(dataFile, "alpha bravo charlie delta"), [],
        "another write's flush wrote an item of an unfinished batch");
      assert.ok(!(await served("alpha bravo charlie delta")), "an item of an unfinished batch is served");

      gate.release();
      const ids = await batch;
      const disk = onDisk(dataFile);
      for (const id of ids) assert.ok(disk.has(id), `item ${id} is not on disk when the batch resolves`);
      assert.equal(disk.get(c).text, "kilo lima mike november oscar");
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  await test("a batch whose flush fails after another write flushed leaves none of its items on disk", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await open(dataFile, gate.embed);
    try {
      const c = await lib.remember("kilo lima mike november", { who });
      const first = "alpha bravo charlie delta";
      const batch = lib.ingestBatch([{ text: first }, { text: HELD }]);
      await gate.reached;
      await lib.remember("kilo lima mike november oscar", { who }); // a full rewrite

      const flush = failNext("persistAll");
      try {
        gate.release();
        await assert.rejects(batch, flush.err);
      } finally { flush.restore(); }

      // Same tick: one drain, one _persistAll() that rewrites the whole file.
      await Promise.all([
        lib.remember("papa quebec romeo sierra", { who }),
        lib.remember("tango uniform victor whiskey", { who }),
      ]);
      for (const text of [first, HELD]) {
        assert.deepEqual(rowsWithText(dataFile, text), [], `the rejected batch's "${text}" is on disk`);
        assert.ok(!(await served(text)), `the rejected batch's "${text}" is still served`);
      }
      assert.equal(onDisk(dataFile).get(c).text, "kilo lima mike november oscar", "the interleaved write was lost");
      assert.equal(onDisk(dataFile).size, 3, "something other than the acknowledged writes is on disk");
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  // The undo journals from the write rollback cannot simply be replayed over
  // a batch: here an acknowledged write lands on what would be the same
  // entity as one of the batch's items. Whatever the batch does, that write stays.
  await test("a write acknowledged mid-batch on a batch item's entity is kept when the batch rejects", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await open(dataFile, gate.embed);
    try {
      const item  = "alpha bravo charlie delta";
      const batch = lib.ingestBatch([{ text: item }, { text: HELD }]);
      await gate.reached;
      const kept = "alpha bravo charlie delta golf"; // 4 of 5 words: same entity as the item
      const id = await lib.remember(kept, { who });

      const flush = failNext("persistAll");
      try {
        gate.release();
        await assert.rejects(batch, flush.err);
      } finally { flush.restore(); }

      await lib.shutdown(); // final flush: memory as it now is
      const row = onDisk(dataFile).get(id);
      assert.ok(row, "the acknowledged write is not on disk");
      assert.equal(row.text, kept);
      assert.deepEqual(row.versions.map(v => v.text), [kept], "the rejected batch's item is in the kept write's history");
      assert.deepEqual(rowsWithText(dataFile, item), [], "the rejected batch's item is on disk");
      assert.deepEqual(rowsWithText(dataFile, HELD), [], "the rejected batch's item is on disk");
    } finally {
      gate.release();
      await lib.shutdown();
    }
  });

  await test("a batch coalesced with another write rejects with it when their shared flush fails", async () => {
    const dataFile = freshDataFile();
    const gate = gatedEmbedder(HELD);
    await open(dataFile, gate.embed);
    try {
      const first = "alpha bravo charlie delta";
      const other = "kilo lima mike november";
      const batch = lib.ingestBatch([{ text: first }, { text: HELD }]);
      await gate.reached;

      const flush = failNext("persistAll");
      let results;
      try {
        // Same tick: the batch's commit and the other write share one drain.
        gate.release();
        results = await Promise.allSettled([batch, lib.remember(other, { who })]);
      } finally { flush.restore(); }
      for (const r of results) {
        assert.equal(r.status, "rejected", "a write was acknowledged though its flush failed");
        assert.equal(r.reason, flush.err);
      }

      await Promise.all([
        lib.remember("papa quebec romeo sierra", { who }),
        lib.remember("tango uniform victor whiskey", { who }),
      ]);
      for (const text of [first, HELD, other]) {
        assert.deepEqual(rowsWithText(dataFile, text), [], `the rejected "${text}" is on disk`);
      }
      assert.equal(onDisk(dataFile).size, 2, "something other than the later pair is on disk");
    } finally {
      gate.release();
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
