// test-file-store-load.js — the JSONL reader's edges
//
// loadRaw reads the store in 1MB chunks rather than whole, which is what keeps
// a large store from peaking at three copies of itself during init(). Chunking
// buys that at the cost of three edges that a readFileSync never had: a
// multi-byte character can straddle a chunk boundary, the last row may have no
// trailing newline, and a line can now be assembled from two reads. Each is
// silent corruption if wrong — a mangled character or a dropped row, on a path
// nothing else checks. Hence this file.
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { FileStore } = require("../store/file-store");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}`); console.log(`       ${e.message}`); failed++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-load-"));
const write = (name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};
const load = (file) => new FileStore().loadRaw({ dataFile: file });

console.log("\n── loadRaw: chunk boundaries ──────────────────────────────────────");

// The 1MB chunk is an implementation detail, so aim a multi-byte character AT
// it rather than near it: pad a row so the emoji lands across the seam. A
// naive buf.toString() per chunk turns that into two replacement characters.
test("a multi-byte character split across a chunk boundary survives", () => {
  const CHUNK = 1 << 20;
  const tail = "🌍 café — ünïcödé";
  // Land the emoji's four bytes ACROSS the seam, not merely near it. Row 2
  // opens with `{"id":2,"text":"` (16 bytes), so if row 1 plus its newline is
  // CHUNK-18 bytes long the emoji begins at CHUNK-2 and spills into the next
  // read. The assertion below pins that, so the test cannot quietly stop
  // testing anything if the chunk size or the row shape ever changes.
  const PREFIX = '{"id":1,"text":"'.length + '"}'.length; // JSON around the pad
  const pad = "x".repeat(CHUNK - 19 - PREFIX);
  const head = JSON.stringify({ id: 1, text: pad });
  const row2 = JSON.stringify({ id: 2, text: tail });
  const content = head + "\n" + row2 + "\n";

  const emojiAt = Buffer.byteLength(head + "\n" + '{"id":2,"text":"', "utf8");
  assert.ok(
    emojiAt < CHUNK && emojiAt + 4 > CHUNK,
    `fixture is not straddling the seam: emoji at byte ${emojiAt}, chunk ends at ${CHUNK}`,
  );

  const rows = load(write("split.jsonl", content));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].text, tail, "unicode was mangled at the seam");
  assert.ok(!rows[1].text.includes("\uFFFD"), "replacement character present");
});

test("a row larger than one chunk is reassembled", () => {
  const big = { id: 1, text: "y".repeat(3 * (1 << 20)) };
  const rows = load(write("big.jsonl", JSON.stringify(big) + "\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text.length, big.text.length);
});

console.log("\n── loadRaw: line endings ──────────────────────────────────────────");

test("a final row with no trailing newline is not dropped", () => {
  const rows = load(write("no-eol.jsonl", '{"id":1}\n{"id":2}'));
  assert.deepEqual(rows.map(r => r.id), [1, 2]);
});

test("blank lines are skipped, not parsed", () => {
  const rows = load(write("blanks.jsonl", '{"id":1}\n\n\n{"id":2}\n\n'));
  assert.deepEqual(rows.map(r => r.id), [1, 2]);
});

test("a malformed line is skipped and its neighbours survive", () => {
  const rows = load(write("bad.jsonl", '{"id":1}\nnot json at all\n{"id":3}\n'));
  assert.deepEqual(rows.map(r => r.id), [1, 3]);
});

console.log("\n── loadRaw: nothing to read ───────────────────────────────────────");

test("an empty file loads as no rows", () => {
  assert.deepEqual(load(write("empty.jsonl", "")), []);
});

test("a missing file loads as no rows", () => {
  assert.deepEqual(load(path.join(dir, "does-not-exist.jsonl")), []);
});

test("an in-memory store reads nothing from disk", () => {
  assert.deepEqual(load(":memory:"), []);
});

console.log("\n── loadRaw: round trip ────────────────────────────────────────────");

// The property that actually matters: what persistAll writes, loadRaw reads
// back identically — across a chunk boundary, with vectors and unicode in it.
test("a multi-chunk store round-trips through persistAll byte-for-byte", () => {
  const file = path.join(dir, "roundtrip.jsonl");
  const original = Array.from({ length: 600 }, (_, i) => ({
    id: i,
    text: `memory ${i} — café 🌍`,
    vector: Array.from({ length: 512 }, (_, j) => (i + j) / 1000),
  }));
  const store = new FileStore();
  store.persistAll(original, { dataFile: file });
  assert.ok(fs.statSync(file).size > (1 << 20), "fixture must exceed one chunk to be meaningful");

  const back = store.loadRaw({ dataFile: file });
  assert.equal(back.length, original.length);
  assert.deepEqual(back, original);
});

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  ${passed}/${passed + failed} passed ${failed ? "❌" : "✅"}`);
console.log("────────────────────────────────────────────────────────────\n");
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
