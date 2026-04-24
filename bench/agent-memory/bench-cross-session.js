// bench/agent-memory/bench-cross-session.js
// Deterministic benchmark: simulates multiple agent sessions accessing shared
// memory. Tests cross-session recall, workspace isolation, memory type
// filtering, and concurrent agent identity preservation.
"use strict";

const assert = require("assert/strict");
const { lib, BASE_OPTS, DAY, BenchSuite } = require("./helpers");

async function run() {
  const bench = new BenchSuite("Cross-Session Recall — Multi-Agent");
  bench.start();

  await lib.init(BASE_OPTS);
  const t0 = Date.now();

  // ── Session 1: Research agent stores findings ─────────────────────────────
  const researcher = lib.createAgent({
    name: "research-agent",
    defaultClassification: "internal",
    defaultTags: ["research"],
  });

  const factId = await researcher.remember(
    "The company quarterly revenue was 12 million dollars in Q1",
    { timestamp: t0, workspaceId: "finance" }
  );

  const findingId = await researcher.remember(
    "Customer churn rate increased to 8 percent in March",
    { timestamp: t0 + DAY, workspaceId: "finance" }
  );

  // ── Session 2: Planning agent accesses same workspace ─────────────────────
  const planner = lib.createAgent({
    name: "planning-agent",
    defaultClassification: "internal",
    defaultTags: ["planning"],
  });

  await bench.run("Cross-session recall: planner finds researcher's facts", async () => {
    const res = await planner.recall("quarterly revenue");
    assert.ok(res.results.length > 0, "planner should recall researcher's revenue fact");
    assert.match(res.results[0].text, /12 million/);
  });

  await bench.run("Cross-session recall: planner finds churn data", async () => {
    const res = await planner.recall("customer churn rate");
    assert.ok(res.results.length > 0);
    assert.match(res.results[0].text, /8 percent/);
  });

  // ── Session 2: Planner updates a fact (provenance changes) ────────────────
  await planner.remember(
    "The company quarterly revenue was 14 million dollars in Q1",
    { timestamp: t0 + 2 * DAY, workspaceId: "finance" }
  );

  await bench.run("Updated fact retains stable ID across agents", async () => {
    const entity = await lib.get(factId);
    assert.match(entity.text, /14 million/, "text should reflect planner's update");
  });

  await bench.run("Version history shows both agent sources", async () => {
    const history = await lib.getHistory(factId);
    const actors = history.versions.map(v => v.source.actor);
    assert.ok(actors.includes("research-agent"), "should include researcher");
    assert.ok(actors.includes("planning-agent"), "should include planner");
  });

  // ── Workspace isolation ───────────────────────────────────────────────────
  const isolatedId = await researcher.remember(
    "Secret project codename is phoenix",
    { timestamp: t0 + 3 * DAY, workspaceId: "classified" }
  );

  await bench.run("Workspace filter isolates entities", async () => {
    const financeRes = await planner.recall("secret project codename", {
      filter: { workspaceId: "finance" },
    });
    // Should NOT find the classified entity when filtering by finance workspace
    const foundClassified = financeRes.results.some(r => r.id === isolatedId);
    assert.ok(!foundClassified, "classified workspace entity should not appear in finance query");
  });

  // ── Memory type filtering ─────────────────────────────────────────────────
  const shortTermId = await researcher.remember(
    "Meeting with CFO scheduled for tomorrow about budget review",
    { timestamp: t0 + 4 * DAY, memoryType: "short-term" }
  );

  const longTermId = await researcher.remember(
    "Annual budget planning cycle starts in September every year",
    { timestamp: t0 + 4 * DAY, memoryType: "long-term" }
  );

  await bench.run("Memory type filter: short-term only", async () => {
    const list = await lib.listEntities({ memoryType: "short-term" });
    const hasShort = list.entities.some(e => e.id === shortTermId);
    const hasLong = list.entities.some(e => e.id === longTermId);
    assert.ok(hasShort, "short-term entity should appear");
    assert.ok(!hasLong, "long-term entity should not appear in short-term filter");
  });

  // ── Time-travel across sessions ───────────────────────────────────────────
  await bench.run("Time-travel to session 1: sees original revenue", async () => {
    const res = await planner.recallAt("quarterly revenue", t0 + DAY);
    assert.ok(res.results.length > 0);
    assert.match(res.results[0].text, /12 million/, "should see researcher's original value");
  });

  // ── Signal bus captures errors ────────────────────────────────────────────
  await bench.run("Signal bus captures entity-not-found error", async () => {
    const signals = [];
    const unsub = lib.onSignal("ERR_ENTITY_NOT_FOUND", (s) => signals.push(s));
    try {
      await lib.get(999999999);
    } catch { /* expected */ }
    unsub();
    assert.ok(signals.length >= 1, "signal bus should have captured the error");
    assert.strictEqual(signals[0].code, "ERR_ENTITY_NOT_FOUND");
  });

  return bench.finish();
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
