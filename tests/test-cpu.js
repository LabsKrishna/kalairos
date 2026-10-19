// test-cpu.js — cpu.js unit tests + the WorkerPool sizing regression.
// Run: node tests/test-cpu.js
"use strict";

const assert = require("assert/strict");
const os     = require("os");

const { availableCpus, cgroupCpuQuota } = require("../cpu");
const { WorkerPool } = require("../worker-pool");

// ─── Minimal test runner (mirrors test-basic.js / test-entity-normalizer.js) ──
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

// Every test that touches the override must put the env back, or it leaks
// into the next one.
function withOverride(value, fn) {
  const prev = process.env.KALAIROS_MAX_WORKERS;
  if (value === undefined) delete process.env.KALAIROS_MAX_WORKERS;
  else process.env.KALAIROS_MAX_WORKERS = String(value);
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KALAIROS_MAX_WORKERS;
    else process.env.KALAIROS_MAX_WORKERS = prev;
  }
}

// A test that awaits something nothing will settle doesn't fail on its own:
// the event loop empties, Node exits 0 partway through this file, and npm test
// carries on as if every test had passed. Make that exit a failure.
let finished = false;
process.on("exit", () => {
  if (finished) return;
  console.log("\n  ❌  exited before the last test finished: a test awaited something that never settled");
  process.exitCode = 1;
});

(async () => {

// ── availableCpus ────────────────────────────────────────────────────────────
console.log("\n── availableCpus ─────────────────────────────────────────────────");

await test("always returns a positive integer", () => {
  const n = withOverride(undefined, () => availableCpus());
  assert.ok(Number.isInteger(n), `expected an integer, got ${n}`);
  assert.ok(n >= 1, `expected >= 1, got ${n}`);
});

await test("never exceeds the host core count", () => {
  const n = withOverride(undefined, () => availableCpus());
  assert.ok(n <= os.cpus().length, `${n} workers on a ${os.cpus().length}-core host`);
});

await test("KALAIROS_MAX_WORKERS pins the count outright", () => {
  assert.equal(withOverride(2, () => availableCpus()), 2);
  assert.equal(withOverride(1, () => availableCpus()), 1);
});

await test("an override above the host count is still honoured — the operator meant it", () => {
  const big = os.cpus().length + 4;
  assert.equal(withOverride(big, () => availableCpus()), big);
});

await test("a fractional override floors rather than spawning a partial worker", () => {
  assert.equal(withOverride(2.9, () => availableCpus()), 2);
});

await test("junk and non-positive overrides are ignored, not obeyed", () => {
  const baseline = withOverride(undefined, () => availableCpus());
  for (const bad of ["", "abc", "0", "-4", "NaN"]) {
    assert.equal(withOverride(bad, () => availableCpus()), baseline,
      `override ${JSON.stringify(bad)} should have been ignored`);
  }
});

// ── cgroupCpuQuota ───────────────────────────────────────────────────────────
console.log("\n── cgroupCpuQuota ────────────────────────────────────────────────");

await test("reports null (unconstrained) or a positive CPU allowance", () => {
  const q = cgroupCpuQuota();
  assert.ok(q === null || (typeof q === "number" && q > 0),
    `expected null or a positive number, got ${q}`);
});

await test("is stable across calls — it reads the quota, it does not compute drift", () => {
  assert.equal(cgroupCpuQuota(), cgroupCpuQuota());
});

// ── WorkerPool sizing — the regression this module exists to prevent ─────────
console.log("\n── WorkerPool sizing ─────────────────────────────────────────────");

await test("spawns exactly the requested number of workers", async () => {
  const pool = new WorkerPool(2);
  pool.start();
  try {
    assert.equal(pool._workers.length, 2, "pool spawned more threads than asked for");
  } finally {
    await pool.stop();
  }
});

await test("defaults to availableCpus(), not the host core count", async () => {
  // A 0.5-CPU container reports dozens of host cores; the default must follow
  // the quota. Pinning the override proves the default reads it at all.
  await withOverride(1, async () => {
    const pool = new WorkerPool();
    pool.start();
    try {
      assert.equal(pool._workers.length, 1,
        "the default pool size ignored KALAIROS_MAX_WORKERS — it is reading os.cpus() again");
    } finally {
      await pool.stop();
    }
  });
});

await test("a stopped pool releases every worker", async () => {
  const pool = new WorkerPool(2);
  pool.start();
  await pool.stop();
  assert.equal(pool._workers.length, 0);
});

// ── WorkerPool failure handling — the leak regressions ───────────────────────
// Each of these was a measured leak, not a hypothetical one. A worker dying is
// the expected failure on the small containers cpu.js exists for, and every
// path out of that used to either retain memory or hang the caller forever.
console.log("\n── WorkerPool failure handling ───────────────────────────────────");

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

await test("stop() settles queued jobs instead of abandoning their promises", async () => {
  const pool = new WorkerPool(1);
  pool.start();
  await settle(300);
  let settled = 0;
  for (let i = 0; i < 50; i++) {
    pool.run({ chunk: [], queryVector: [], queryTerms: [], config: {} })
      .then(() => settled++, () => settled++);
  }
  await pool.stop();
  await settle();
  assert.equal(settled, 50,
    `only ${settled}/50 queued callers were settled — the rest wait on a promise nothing will resolve`);
});

await test("a dead worker is replaced and never left advertised as idle", async () => {
  const pool = new WorkerPool(1);
  pool.start();
  await settle(300);
  await pool._workers[0].worker.terminate();
  await settle();
  try {
    assert.ok(pool._workers[0], "the pool did not replace the dead worker");
    for (const idx of pool._idle) {
      assert.ok(pool._workers[idx], `_idle advertises dead slot ${idx} — the next dispatch writes to null`);
    }
    const results = await pool.run({ chunk: [], queryVector: [], queryTerms: [], config: {} });
    assert.ok(Array.isArray(results), "the replaced worker cannot run jobs");
  } finally {
    await pool.stop();
  }
});

await test("with no live worker left, run() rejects rather than queueing forever", async () => {
  // maxRespawns: 0 is the pool that has given up. Queued jobs pin their whole
  // chunk — every candidate's text and vector — so holding them is the leak.
  const pool = new WorkerPool(1, { maxRespawns: 0 });
  pool.start();
  await settle(300);
  await pool._workers[0].worker.terminate();
  await settle();
  try {
    assert.equal(pool._liveCount(), 0, "expected the pool to have no live workers");
    let rejected = 0;
    await Promise.all(Array.from({ length: 25 }, () =>
      pool.run({ chunk: new Array(500).fill({ v: 1 }), queryVector: [], config: {} }).catch(() => rejected++)));
    assert.equal(rejected, 25, `${25 - rejected} jobs are still waiting on a pool that cannot run them`);
    assert.equal(pool._queue.length, 0, `_queue retained ${pool._queue.length} chunks`);
  } finally {
    await pool.stop();
  }
});

await test("the wait queue is bounded and reports backpressure", async () => {
  const pool = new WorkerPool(1, { queueMax: 5 });
  pool.start();
  await settle(300);
  try {
    const codes = [];
    await Promise.all(Array.from({ length: 40 }, () =>
      pool.run({ chunk: [], queryVector: [], queryTerms: [], config: {} }).catch(e => codes.push(e.code))));
    assert.ok(pool._queue.length <= 5, `queue grew to ${pool._queue.length} past its cap of 5`);
    assert.ok(codes.includes("ERR_WORKER_QUEUE_FULL"),
      `no backpressure signal raised; saw ${JSON.stringify([...new Set(codes)])}`);
  } finally {
    await pool.stop();
  }
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
finished = true;
process.exit(failed > 0 ? 1 : 0);

})();
