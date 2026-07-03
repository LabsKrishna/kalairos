// test-scope.js — Verifies kalairos.scope() behavior.
// Run: node test-scope.js
"use strict";

const assert = require("assert/strict");
const lib = require("../index");

function makeMockEmbedder(dim = 64) {
  const vocab = new Map();
  return async (text) => {
    const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
    const vec = new Array(dim).fill(0);
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
      vec[vocab.get(w) % dim]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

const INIT_OPTS = {
  dataFile: ":memory:",
  embeddingDim: 64,
  embedFn: makeMockEmbedder(64),
  linkThreshold: 0.72,
  versionThreshold: 0.82,
  minFinalScore: 0.20,
  recencyWeight: 0.15,
  recencyHalfLifeMs: 2 * 86_400_000,
};

(async () => {
  console.log("\n=== kalairos.scope() test ===\n");

  // ── 1. scope() stamps provenance/classification/tags on writes ────────────
  await lib.init(INIT_OPTS);

  const scope = lib.scope({
    source: { type: "agent", actor: "budget-planner" },
    classification: "confidential",
    tags: ["finance", "atlas"],
  });

  const id = await scope.remember("Q2 budget forecast for atlas project is 2.4 million dollars");
  const entity = await lib.get(id);
  assert.deepStrictEqual(entity.source, { type: "agent", actor: "budget-planner" });
  assert.strictEqual(entity.classification, "confidential");
  assert.ok(entity.tags.includes("finance"));
  assert.ok(entity.tags.includes("atlas"));
  console.log("  [ok] scope defaults propagate to source, classification, tags");

  // ── 2. Per-call opts merge on top of scope defaults ───────────────────────
  const id2 = await scope.remember("Marketing spend cap for Q2 is 400k", {
    tags: ["marketing"],
    source: { type: "user", actor: "ops-lead" },
  });
  const entity2 = await lib.get(id2);
  assert.deepStrictEqual(entity2.source, { type: "user", actor: "ops-lead" },
    "per-call source overrides scope default");
  assert.strictEqual(entity2.classification, "confidential",
    "classification falls back to scope default when not overridden");
  assert.ok(entity2.tags.includes("finance") && entity2.tags.includes("marketing"),
    "per-call tags merge with scope defaults");
  console.log("  [ok] per-call opts override/merge correctly");

  // ── 3. Flat-API verbs on the scoped handle ────────────────────────────────
  await scope.remember("Q2 budget forecast for atlas project is 2.7 million dollars");
  const q = await scope.query("atlas Q2 budget");
  assert.ok(q.results.length > 0 && /2\.7/.test(q.results[0].text),
    "scope.query returns current version");

  const history = await scope.getHistory(id);
  assert.strictEqual(history.versionCount, 2, "scope.getHistory surfaces both versions");

  const firstVersionT = history.versions[0].timestamp;
  const qAt = await scope.queryAt("atlas Q2 budget", firstVersionT);
  assert.ok(qAt.results.length > 0 && /2\.4/.test(qAt.results[0].text),
    "scope.queryAt returns the historical version");
  console.log("  [ok] flat-API verbs (query, queryAt, getHistory) work on scoped handle");

  // ── 4. Deprecated aliases still work ──────────────────────────────────────
  const rec = await scope.recall("atlas Q2 budget");
  assert.ok(rec.results.length > 0, "deprecated recall() still works");
  const recAt = await scope.recallAt("atlas Q2 budget", firstVersionT);
  assert.ok(recAt.results.length > 0, "deprecated recallAt() still works");
  await scope.update("Q2 budget forecast for atlas project is 2.55 million dollars");
  const h2 = await scope.getHistory(id);
  assert.strictEqual(h2.versionCount, 3, "deprecated update() still appends versions");
  console.log("  [ok] deprecated aliases (recall, recallAt, update) still work");

  // ── 5. createAgent() remains a functional alias ───────────────────────────
  await lib.init(INIT_OPTS);
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const legacy = lib.createAgent({
      name: "legacy-bot",
      defaultClassification: "internal",
      defaultTags: ["legacy"],
    });
    assert.strictEqual(legacy.name, "legacy-bot");
    const lid = await legacy.remember("legacy fact about the atlas project");
    const lEntity = await lib.get(lid);
    assert.strictEqual(lEntity.source.actor, "legacy-bot");
    assert.strictEqual(lEntity.classification, "internal");
    assert.ok(lEntity.tags.includes("legacy"));

    const legacy2 = lib.createAgent({ name: "second-bot" });
    await legacy2.remember("another legacy fact");
    assert.strictEqual(
      warnings.filter(w => w.includes("createAgent() is deprecated")).length,
      1,
      "deprecation warning should fire exactly once per process",
    );
    console.log("  [ok] createAgent() alias works and warns exactly once");
  } finally {
    console.warn = origWarn;
  }

  await lib.shutdown();
  console.log("\n=== scope() test passed ===\n");
})().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
