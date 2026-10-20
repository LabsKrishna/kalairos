// test-torn-writes.js — no write tears the JSONL file in a way that loses rows
//
// Two ways a row could be lost after the append path learned to undo itself:
//   * persistAll wrote its tmp file with a single writeSync and ignored the
//     count it returned. A disk that fills mid-write reports the bytes it took
//     with no error (only the next call raises ENOSPC), so the torn tmp file
//     was fsync'd and renamed over the store, truncating it.
//   * A process that dies mid-append leaves part of a row with no newline. A
//     reload skips it, and the next append used to join onto it, so that row,
//     which was acknowledged, was skipped on the reload after.
//
// What must hold: persistAll writes every row or throws and leaves the store
// byte-identical, and an append after a torn tail survives a reload.
// Run: node tests/test-torn-writes.js
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-torn-writes-"));
let counter = 0;
const freshFile = () => path.join(tmpRoot, `data-${++counter}.kalairos`);

// Collect console.warn while fn runs, so expected warnings stay out of the log.
function quiet(fn) {
  const warn = console.warn, warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try { fn(); } finally { console.warn = warn; }
  return warned;
}

async function muted(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

const ids = (file) => {
  let rows;
  quiet(() => { rows = new FileStore().loadRaw({ dataFile: file }); });
  return rows.map(r => r.id);
};

const ROWS = [
  { id: 1, text: "first row" },
  { id: 2, text: "second row, café 🌍" },
];
const NEXT = [...ROWS, { id: 3, text: "third row, naïve 🌍" }];
const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";

function assertUnchanged(file, before) {
  const after = fs.readFileSync(file);
  assert.ok(
    after.equals(before),
    `file changed: ${before.length} → ${after.length} bytes`,
  );
}

function enospc() {
  return Object.assign(new Error("ENOSPC: no space left on device, write"),
    { code: "ENOSPC", syscall: "write" });
}

// The bytes a writeSync call was asked to write, from either signature. The
// stubs pass the call's position on, since the store writes at an explicit
// offset.
function asked(data, offset, length) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  const start = offset ?? 0;
  return data.subarray(start, start + (length ?? data.length - start));
}

// Replace fs[name] for one file only, matched by inode when the call is made,
// so a file that does not exist yet (persistAll's tmp) can be targeted.
// stderr can be a file written with writeSync, and must not see the stub.
function stub(name, file, impl) {
  const real = fs[name];
  const isTarget = (fd) => {
    try {
      const a = fs.fstatSync(fd), b = fs.statSync(file);
      return a.ino === b.ino && a.dev === b.dev;
    } catch { return false; }
  };
  fs[name] = function (fd, ...rest) {
    return isTarget(fd) ? impl(real, fd, ...rest) : real.call(fs, fd, ...rest);
  };
  return () => { fs[name] = real; };
}

const half = (bytes) => Math.floor(bytes.length / 2);

/** A store file holding ROWS, written by persistAll. */
function persisted() {
  const file  = freshFile();
  const store = new FileStore();
  store.persistAll(ROWS, { dataFile: file });
  return { file, store, config: { dataFile: file }, before: fs.readFileSync(file) };
}

/** A store file holding ROWS by the real append path, then `tail` with no newline. */
function torn(tail) {
  const file  = freshFile();
  const store = new FileStore();
  for (const r of ROWS) store.appendEntity(r, { dataFile: file });
  fs.appendFileSync(file, tail);
  return { file, store, config: { dataFile: file } };
}

/** The first `keep` bytes of a row as JSON, the way a crash would leave it. */
const partial = (row, keep) => Buffer.from(JSON.stringify(row), "utf8").subarray(0, keep);

(async () => {
  console.log("\n=== persistAll: a short write to the tmp file ===\n");

  await test("a short write that the next call finishes still writes every row", () => {
    const { file, store, config } = persisted();
    const tmp = file + ".tmp";
    let first = true;
    const restore = stub("writeSync", tmp, (real, fd, data, offset, length, position) => {
      const bytes = asked(data, offset, length);
      if (first) { first = false; return real.call(fs, fd, bytes, 0, half(bytes), position); }
      return real.call(fs, fd, bytes, 0, bytes.length, position);
    });
    try {
      store.persistAll(NEXT, config);
    } finally { restore(); }

    assert.equal(fs.readFileSync(file, "utf8"), jsonl(NEXT));
    assert.deepEqual(ids(file), [1, 2, 3]);
  });

  // How a full disk actually reports: the call that runs out returns the
  // bytes it took, and only the next call raises ENOSPC.
  await test("a short write followed by ENOSPC throws and leaves the store as it was", () => {
    const { file, store, config, before } = persisted();
    const err = enospc();
    let calls = 0;
    const restore = stub("writeSync", file + ".tmp", (real, fd, data, offset, length, position) => {
      const bytes = asked(data, offset, length);
      if (++calls === 1) return real.call(fs, fd, bytes, 0, half(bytes), position);
      throw err;
    });
    try {
      assert.throws(() => store.persistAll(NEXT, config), e => e === err);
    } finally { restore(); }

    assertUnchanged(file, before);
    assert.deepEqual(ids(file), [1, 2]);
  });

  console.log("\n=== an append after a crash tore the last row ===\n");

  await test("a row appended after a torn tail survives a reload", () => {
    const { file, store, config } = torn(partial({ id: 3, text: "never acknowledged" }, 20));
    assert.deepEqual(ids(file), [1, 2]);

    const warned = quiet(() => store.appendEntity({ id: 4, text: "acknowledged" }, config));
    assert.deepEqual(ids(file), [1, 2, 4]);
    assert.ok(warned.some(w => /partway through a row/.test(w)), `no warning about the torn tail: ${warned}`);
  });

  await test("a tail torn inside a multi-byte character does not take the next row", () => {
    const row  = { id: 3, text: "🌍🌍🌍" };
    const json = Buffer.from(JSON.stringify(row), "utf8");
    const cut  = json.indexOf(Buffer.from("🌍", "utf8")) + 2; // mid-emoji
    const { file, store, config } = torn(json.subarray(0, cut));

    quiet(() => store.appendEntity({ id: 4, text: "acknowledged" }, config));
    assert.deepEqual(ids(file), [1, 2, 4]);
  });

  // A whole row that never got its newline (the crash came between the two,
  // or someone edited the file by hand) loads today. The next append must
  // not join onto it and take both down.
  await test("a whole last row with no newline survives the next append", () => {
    const { file, store, config } = torn(JSON.stringify({ id: 3, text: "no newline" }));
    assert.deepEqual(ids(file), [1, 2, 3]);

    quiet(() => store.appendEntity({ id: 4, text: "acknowledged" }, config));
    assert.deepEqual(ids(file), [1, 2, 3, 4]);
  });

  await test("a failed append to a torn file leaves it byte-identical", () => {
    const { file, store, config } = torn(partial({ id: 3, text: "never acknowledged" }, 20));
    const before = fs.readFileSync(file);
    const err = enospc();
    const restore = stub("writeSync", file, (real, fd, data, offset, length, position) => {
      const bytes = asked(data, offset, length);
      real.call(fs, fd, bytes, 0, half(bytes), position);
      throw err;
    });
    try {
      quiet(() => assert.throws(() => store.appendEntity({ id: 4, text: "rejected" }, config), e => e === err));
    } finally { restore(); }
    assertUnchanged(file, before);

    quiet(() => store.appendEntity({ id: 5, text: "acknowledged after the failure" }, config));
    assert.deepEqual(ids(file), [1, 2, 5]);
  });

  await test("a clean file gets no blank lines and a new file no leading newline", () => {
    const file   = freshFile();
    const store  = new FileStore();
    const config = { dataFile: file };
    const warned = quiet(() => { for (const r of NEXT) store.appendEntity(r, config); });
    assert.equal(fs.readFileSync(file, "utf8"), jsonl(NEXT));
    assert.deepEqual(warned, []);
  });

  console.log("\n=== through the engine ===\n");

  // The data loss, end to end: reopen a store whose last row a crash tore,
  // ingest, and read the JSONL as the next start would, with no rewrite in
  // between. Before the fix the ingest joined onto the torn row and was gone.
  await test("an ingest after reopening a torn store survives a reload", async () => {
    const dataFile = freshFile();
    const DIM = 64;
    const vocab = new Map();
    const embedFn = async (text) => {
      const vec = new Array(DIM).fill(0);
      for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) {
        if (!vocab.has(w)) vocab.set(w, vocab.size);
        vec[vocab.get(w) % DIM]++;
      }
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map(v => v / mag);
    };
    const who = { agent: "torn-writes-test" };

    await lib.init({ dataFile, embedFn, embeddingDim: DIM });
    let a;
    try {
      a = await lib.ingest("alpha bravo charlie delta", { who });
    } finally { await lib.shutdown(); }

    // The crash: part of a row reached the file, then the process died.
    fs.appendFileSync(dataFile, partial({ id: a + 1, text: "echo foxtrot golf hotel" }, 24));

    await muted(() => lib.init({ dataFile, embedFn, embeddingDim: DIM }));
    try {
      const c = await muted(() => lib.ingest("sierra tango uniform victor", { who }));
      assert.deepEqual(ids(dataFile), [a, c]);
    } finally {
      await lib.shutdown();
    }
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed ? "❌" : "✅"}`);
  console.log("────────────────────────────────────────────────────────────\n");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
