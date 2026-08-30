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

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);

})();
