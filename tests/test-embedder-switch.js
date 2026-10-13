// test-embedder-switch.js — A store must stay usable when its embedder changes.
//
// Stores outlive embedders: the neural model is downloaded after weeks on the
// bag-of-words fallback (128-dim → 768-dim), or a caller switches providers.
// Before this was handled, cosine over vectors of different widths returned
// NaN, NaN passed every score floor, and old memories came back with
// `score: null` in arbitrary order — or never came back at all.
// Run: node tests/test-embedder-switch.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const lib    = require("../index");
const { cosine } = require("../kernel");

// Bag-of-words over a fixed hashed vocabulary, so two instances of different
// widths agree on what "similar" means and the test is deterministic.
function makeEmbedder(dim) {
  return async (text) => {
    const vec = new Array(dim).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      vec[h % dim]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

async function captureStderr(fn) {
  const original = console.error;
  let out = "";
  console.error = (...args) => { out += args.join(" ") + "\n"; };
  try { await fn(); } finally { console.error = original; }
  return out;
}

const BASE = { linkThreshold: 0.72, versionThreshold: 0.82, minFinalScore: 0.2, minSemanticScore: 0.1 };

(async () => {
  console.log("\n=== embedder switch ===\n");

  // ── 1. cosine never returns NaN ───────────────────────────────────────────
  assert.strictEqual(cosine([1, 0, 0, 0], [1, 0]), 0, "a shorter second vector scores 0");
  assert.strictEqual(cosine([1, 0], [1, 0, 0, 0]), 0, "a shorter first vector scores 0");
  assert.strictEqual(cosine([1, 0], [1, 0]), 1, "equal widths still compare normally");
  console.log("  [ok] cosine scores mismatched widths as 0, not NaN");

  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-embswitch-"));
  const dataFile = path.join(dir, "data.kalairos");

  // ── 2. Write a store with a 16-dim embedder, including a version chain ────
  await lib.init({ ...BASE, dataFile, embedFn: makeEmbedder(16), embeddingDim: 16 });
  const planId = await lib.remember("The customer subscription price is ten dollars monthly");
  await new Promise(r => setTimeout(r, 5)); // distinct timestamps for the two versions
  await lib.remember("The customer subscription price is twenty dollars monthly");
  await lib.remember("Deploys go out every Friday afternoon");
  const before = await lib.getHistory(planId);
  assert.ok(before.versions.length >= 2, "setup: the price change should version one entity");
  await lib.shutdown();

  // ── 3. Reopen with a 32-dim embedder: every vector is re-embedded ─────────
  await lib.init({ ...BASE, dataFile, embedFn: makeEmbedder(32), embeddingDim: 32 });
  const raw = fs.readFileSync(dataFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const latest = new Map(raw.map(r => [r.id, r])); // JSONL: last row per id wins
  for (const e of latest.values()) {
    assert.strictEqual(e.vector.length, 32, `entity ${e.id} vector was re-embedded on disk`);
    for (const v of e.versions) assert.strictEqual(v.vector.length, 32, `entity ${e.id} version vector was re-embedded on disk`);
  }
  console.log("  [ok] entity and version vectors re-embedded and persisted");

  const now = await lib.query("customer subscription price");
  assert.ok(now.results.length > 0, "old memories are findable with the new embedder");
  assert.match(now.results[0].text, /twenty/, "the current version wins");
  for (const r of now.results) assert.ok(Number.isFinite(r.score), `score is a number, got ${r.score}`);
  console.log("  [ok] queries find old memories with finite scores");

  const hist = await lib.getHistory(planId);
  const at = hist.versions[0].timestamp; // getHistory lists oldest first
  const past = await lib.queryAt("customer subscription price", at);
  assert.ok(past.results.length > 0 && /ten/.test(past.results[0].text), "time travel still finds the old version");
  console.log("  [ok] queryAt still reaches past versions");
  await lib.shutdown();

  // ── 4. Reopening with the same embedder re-embeds nothing ─────────────────
  // shutdown() always flushes the store, so file timestamps prove nothing;
  // what matters is that no re-embedding pass runs.
  let log = await captureStderr(() => lib.init({ ...BASE, dataFile, embedFn: makeEmbedder(32), embeddingDim: 32 }));
  assert.doesNotMatch(log, /re-embedding/, "no re-embedding when widths already match");
  await lib.shutdown();
  console.log("  [ok] a store that already matches is not re-embedded");

  // ── 5. Unknown width (custom embedFn, no embeddingDim): no re-embed, no NaN
  log = await captureStderr(() => lib.init({ ...BASE, dataFile, embedFn: makeEmbedder(8) }));
  assert.doesNotMatch(log, /re-embedding/, "an undeclared width never triggers re-embedding");
  const mixed = await lib.query("customer subscription price");
  for (const r of mixed.results) assert.ok(Number.isFinite(r.score), `score is a number, got ${r.score}`);
  await lib.shutdown();
  for (const line of fs.readFileSync(dataFile, "utf8").trim().split("\n")) {
    assert.strictEqual(JSON.parse(line).vector.length, 32, "stored vectors keep their width");
  }
  console.log("  [ok] without a declared width, vectors are left alone and never score NaN");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n=== all embedder-switch tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
