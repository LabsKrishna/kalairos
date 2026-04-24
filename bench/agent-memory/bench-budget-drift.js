// bench/agent-memory/bench-budget-drift.js
// Deterministic benchmark: an agent tracks a project budget over 7 days.
// Tests stable identity, version accumulation, delta classification, recency
// ranking, and time-travel retrieval as values drift over time.
//
// Key design constraint: texts must share enough vocabulary to stay above
// the version threshold (0.82) with the bag-of-words mock embedder.
// Only the numeric value changes — phrasing stays constant.
"use strict";

const assert = require("assert/strict");
const { lib, BASE_OPTS, DAY, BenchSuite } = require("./helpers");

async function run() {
  const bench = new BenchSuite("Budget Drift — Temporal Evolution");
  bench.start();

  await lib.init(BASE_OPTS);

  const agent = lib.createAgent({
    name: "finance-tracker",
    defaultClassification: "confidential",
    defaultTags: ["budget", "q2"],
  });

  const t0 = Date.now();

  // ── 7-day budget evolution (uniform phrasing, only value changes) ──────────
  const updates = [
    { day: 0, val: "2.4"  },
    { day: 1, val: "2.5"  },
    { day: 2, val: "2.7"  },
    { day: 3, val: "2.55" },  // contradiction: drop after rise
    { day: 4, val: "2.3"  },  // contradiction: another drop
    { day: 5, val: "2.8"  },  // contradiction: big reversal
    { day: 6, val: "2.85" },
  ];

  const budgetText = (val) => `Q2 budget forecast for atlas project is ${val} million dollars`;

  const ids = [];
  for (const u of updates) {
    ids.push(await agent.remember(budgetText(u.val), { timestamp: t0 + u.day * DAY }));
  }
  const entityId = ids[0];

  // ── Assertions ─────────────────────────────────────────────────────────────

  await bench.run("Stable identity across all updates", async () => {
    // All IDs should be the same entity
    for (const id of ids) assert.strictEqual(id, entityId, "all updates should hit the same entity");
    const history = await agent.getHistory(entityId);
    assert.strictEqual(history.versionCount, updates.length, `expected ${updates.length} versions, got ${history.versionCount}`);
  });

  await bench.run("Latest text reflects final value (2.85M)", async () => {
    const entity = await lib.get(entityId);
    assert.match(entity.text, /2\.85 million/);
  });

  await bench.run("All versions have agent provenance", async () => {
    const history = await agent.getHistory(entityId);
    for (const v of history.versions) {
      assert.strictEqual(v.source.actor, "finance-tracker");
    }
  });

  await bench.run("Contradictions detected for value reversals", async () => {
    const { contradictions } = await agent.getContradictions(entityId);
    assert.ok(contradictions.length >= 2, `expected ≥2 contradictions, got ${contradictions.length}`);
  });

  await bench.run("Time-travel to day 0 returns 2.4M", async () => {
    const res = await agent.recallAt("atlas project Q2 budget forecast", t0);
    assert.ok(res.results.length > 0);
    assert.match(res.results[0].text, /2\.4 million/);
  });

  await bench.run("Time-travel to day 4 returns 2.3M", async () => {
    const res = await agent.recallAt("atlas project Q2 budget forecast", t0 + 4 * DAY);
    assert.ok(res.results.length > 0);
    assert.match(res.results[0].text, /2\.3 million/);
  });

  await bench.run("Current query returns 2.85M", async () => {
    const res = await agent.recall("atlas project Q2 budget forecast");
    assert.ok(res.results.length > 0);
    assert.match(res.results[0].text, /2\.85 million/);
  });

  await bench.run("Classification persists as confidential", async () => {
    const history = await agent.getHistory(entityId);
    assert.strictEqual(history.classification, "confidential");
  });

  return bench.finish();
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
