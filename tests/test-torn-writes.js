// test-torn-writes.js — no write tears the JSONL file in a way that loses rows
//
// persistAll wrote its tmp file with a single writeSync and ignored the count
// it returned. A disk that fills mid-write reports the bytes it took with no
// error (only the next call raises ENOSPC), so the torn tmp file was fsync'd
// and renamed over the store, truncating it.
//
// What must hold: persistAll writes every row or throws and leaves the store
// byte-identical.
// Run: node tests/test-torn-writes.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

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

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed ? "❌" : "✅"}`);
  console.log("────────────────────────────────────────────────────────────\n");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
