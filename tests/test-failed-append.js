// test-failed-append.js — a failed append leaves the JSONL file as it found it
//
// FileStore.appendEntity writes one row and fsyncs it. When either step threw,
// it closed the file and rethrew, but whatever had reached the file stayed:
//   * A write that stopped partway left part of a row with no newline. The
//     next successful append joined onto it, the reload skipped the joined
//     line as malformed, and the row lost was that NEXT one, which had been
//     acknowledged.
//   * A row whose fsync failed stayed whole, so a reload brought back a write
//     the caller had been told failed.
// A short write (writeSync returning fewer bytes than it was given, which is
// how a disk that fills mid-row shows up) was not noticed at all: the torn
// row was fsync'd and acknowledged.
//
// What must hold: after a failed append the file is byte-identical to before,
// the caller gets the append's own error, and the next append plus a reload
// keeps every acknowledged row.
// Run: node tests/test-failed-append.js
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-failed-append-"));
let counter = 0;
const freshFile = () => path.join(tmpRoot, `data-${++counter}.kalairos`);

const ids = (file) => new FileStore().loadRaw({ dataFile: file }).map(r => r.id);

/** A store file holding rows 1 and 2, written by the real append path. */
function seeded() {
  const file  = freshFile();
  const store = new FileStore();
  store.appendEntity({ id: 1, text: "first row" }, { dataFile: file });
  store.appendEntity({ id: 2, text: "second row, café 🌍" }, { dataFile: file });
  return { file, store, config: { dataFile: file }, before: fs.readFileSync(file) };
}

function assertUnchanged(file, before) {
  const after = fs.readFileSync(file);
  assert.ok(
    after.equals(before),
    `file changed: ${before.length} → ${after.length} bytes, ` +
    `tail now ${JSON.stringify(after.subarray(before.length).toString("utf8").slice(0, 60))}`,
  );
}

function enospc() {
  return Object.assign(new Error("ENOSPC: no space left on device, write"),
    { code: "ENOSPC", syscall: "write" });
}

// The bytes a writeSync call was asked to write, from either signature.
function asked(data, offset, length) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  const start = offset ?? 0;
  return data.subarray(start, start + (length ?? data.length - start));
}

// Replace fs[name] for the data file only. stderr can be a file written with
// writeSync, and nothing but the store's own I/O should see a stub.
function stub(name, file, impl) {
  const real = fs[name];
  const isData = (fd) => {
    try {
      const a = fs.fstatSync(fd), b = fs.statSync(file);
      return a.ino === b.ino && a.dev === b.dev;
    } catch { return false; }
  };
  fs[name] = function (fd, ...rest) {
    return isData(fd) ? impl(real, fd, ...rest) : real.call(fs, fd, ...rest);
  };
  return () => { fs[name] = real; };
}

const half = (bytes) => Math.floor(bytes.length / 2);

(async () => {
  console.log("\n=== a failed append leaves the file as it found it ===\n");

  await test("a write that stops partway and throws is undone", () => {
    const { file, store, config, before } = seeded();
    const err = enospc();
    const restore = stub("writeSync", file, (real, fd, data, offset, length) => {
      const bytes = asked(data, offset, length);
      real.call(fs, fd, bytes, 0, half(bytes));
      throw err;
    });
    try {
      assert.throws(() => store.appendEntity({ id: 3, text: "rejected" }, config), e => e === err);
    } finally { restore(); }
    assertUnchanged(file, before);

    store.appendEntity({ id: 4, text: "acknowledged after the failure" }, config);
    assert.deepEqual(ids(file), [1, 2, 4]);
  });

  // How a full disk actually reports: the call that runs out returns the
  // bytes it took, and only the next call raises ENOSPC.
  await test("a short write followed by ENOSPC is undone", () => {
    const { file, store, config, before } = seeded();
    const err = enospc();
    let calls = 0;
    const restore = stub("writeSync", file, (real, fd, data, offset, length) => {
      const bytes = asked(data, offset, length);
      if (++calls === 1) return real.call(fs, fd, bytes, 0, half(bytes));
      throw err;
    });
    try {
      assert.throws(() => store.appendEntity({ id: 3, text: "rejected" }, config), e => e === err);
    } finally { restore(); }
    assertUnchanged(file, before);

    store.appendEntity({ id: 4, text: "acknowledged after the failure" }, config);
    assert.deepEqual(ids(file), [1, 2, 4]);
  });

  await test("a short write that the next call finishes lands as one whole row", () => {
    const { file, store, config } = seeded();
    let first = true;
    const restore = stub("writeSync", file, (real, fd, data, offset, length) => {
      const bytes = asked(data, offset, length);
      if (first) { first = false; return real.call(fs, fd, bytes, 0, half(bytes)); }
      return real.call(fs, fd, bytes);
    });
    try {
      store.appendEntity({ id: 3, text: "written in two calls" }, config);
    } finally { restore(); }

    store.appendEntity({ id: 4, text: "the next row" }, config);
    assert.deepEqual(ids(file), [1, 2, 3, 4]);
  });

  await test("a row whose fsync fails is removed", () => {
    const { file, store, config, before } = seeded();
    const err = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
    let armed = true;
    const restore = stub("fsyncSync", file, (real, fd) => {
      if (armed) { armed = false; throw err; }
      return real.call(fs, fd);
    });
    try {
      assert.throws(() => store.appendEntity({ id: 3, text: "rejected" }, config), e => e === err);
    } finally { restore(); }
    assertUnchanged(file, before);

    store.appendEntity({ id: 4, text: "acknowledged after the failure" }, config);
    assert.deepEqual(ids(file), [1, 2, 4]);
  });

  // The undo's own fsync fails too. The caller still needs the append's
  // error, not the undo's, and the file must not hold the row.
  await test("the append's own error reaches the caller when the undo cannot fsync", () => {
    const { file, store, config, before } = seeded();
    const errs = [];
    const restore = stub("fsyncSync", file, () => {
      const e = Object.assign(new Error(`EIO #${errs.length + 1}`), { code: "EIO" });
      errs.push(e);
      throw e;
    });
    const warn = console.warn, warned = [];
    console.warn = (...a) => warned.push(a.join(" "));
    try {
      assert.throws(() => store.appendEntity({ id: 3, text: "rejected" }, config), e => e === errs[0]);
    } finally { restore(); console.warn = warn; }
    assert.ok(errs.length >= 2, "the undo did not try to fsync");
    assert.ok(warned.some(w => /could not undo/.test(w)), `no warning about the failed undo: ${warned}`);
    assertUnchanged(file, before);

    store.appendEntity({ id: 4, text: "acknowledged after the failure" }, config);
    assert.deepEqual(ids(file), [1, 2, 4]);
  });

  console.log("\n=== through the engine ===\n");

  // The data loss, end to end: an ingest is acknowledged after a failed one,
  // and the JSONL as a reload reads it, with no rewrite in between, must hold
  // it. Before the fix the acknowledged row joined onto the torn one and was
  // skipped.
  await test("an ingest acknowledged after a failed one survives a reload", async () => {
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
    const who = { agent: "failed-append-test" };

    await lib.init({ dataFile, embedFn, embeddingDim: DIM });
    try {
      const a = await lib.ingest("alpha bravo charlie delta", { who });
      const err = enospc();
      const restore = stub("writeSync", dataFile, (real, fd, data, offset, length) => {
        const bytes = asked(data, offset, length);
        real.call(fs, fd, bytes, 0, half(bytes));
        throw err;
      });
      try {
        await assert.rejects(lib.ingest("kilo lima mike november", { who }), e => e === err);
      } finally { restore(); }
      const c = await lib.ingest("sierra tango uniform victor", { who });

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
