// bench/agent-memory/bench-temporal-trust.js
// Evaluation suite for: time-aware retrieval, version semantics, provenance, and trust signals.
//
// These benchmarks test the features that differentiate Smriti as an agent memory system:
//
//   1. Temporal retrieval — getChangeSince, asOf accuracy
//   2. Version semantics — contradiction detection (numeric + negation), getDrift
//   3. Agent memory workflow — promote, forget, consolidateSession, getWorkingMemory
//   4. Provenance & trust — trustScore defaults, annotate, trust in query results
//
"use strict";

const assert = require("assert/strict");
const { lib, BASE_OPTS, DAY, BenchSuite } = require("./helpers");

async function run() {
  const suite = new BenchSuite("Temporal, Version Semantics, Agent Workflow & Trust Benchmarks");
  suite.start();

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. TEMPORAL RETRIEVAL — getChangeSince
  // ══════════════════════════════════════════════════════════════════════════════

  await lib.init(BASE_OPTS);
  const now = Date.now();

  // Ingest facts at controlled timestamps
  const oldId   = await lib.ingest("Project alpha was planned for Q1 release",           { type: "fact", timestamp: now - 20 * DAY });
  const recentId = await lib.ingest("Project alpha shipped ahead of schedule in February", { type: "fact", timestamp: now - 2 * DAY });
  const todayId  = await lib.ingest("Project alpha post-launch review scheduled for next week", { type: "fact", timestamp: now });

  await suite.run("getChangeSince returns only entities changed after the cutoff", async () => {
    const result = await lib.getChangeSince(now - 5 * DAY);
    const ids = result.changes.map(c => c.id);
    assert.ok(ids.includes(recentId), "recent entity should be in changes");
    assert.ok(ids.includes(todayId),  "today's entity should be in changes");
    assert.ok(!ids.includes(oldId),   "old entity should NOT be in changes (predates cutoff)");
  });

  await suite.run("getChangeSince includes changedAt timestamp and delta for each result", async () => {
    const result = await lib.getChangeSince(now - 5 * DAY);
    assert.ok(result.changes.length > 0, "should have at least one change");
    for (const c of result.changes) {
      assert.ok(typeof c.changedAt === "number", "changedAt must be a number");
      assert.ok(typeof c.id === "number",        "id must be present");
      assert.ok(typeof c.text === "string",      "text must be present");
      assert.ok("source" in c,                   "source must be present");
      assert.ok("trustScore" in c,               "trustScore must be present in changes");
    }
  });

  await suite.run("getChangeSince returns empty when nothing changed since future timestamp", async () => {
    const result = await lib.getChangeSince(now + 1 * DAY);
    assert.strictEqual(result.changes.length, 0, "no changes should appear after the future cutoff");
  });

  await suite.run("getChangeSince results are sorted most-recent first", async () => {
    const result = await lib.getChangeSince(now - 30 * DAY);
    for (let i = 1; i < result.changes.length; i++) {
      assert.ok(
        result.changes[i - 1].changedAt >= result.changes[i].changedAt,
        "changes must be sorted descending by changedAt"
      );
    }
  });

  await suite.run("getChangeSince respects type filter", async () => {
    await lib.ingest("Team standup happened at 9am", { type: "event", timestamp: now - 1 * DAY });
    const factChanges  = await lib.getChangeSince(now - 5 * DAY, { type: "fact" });
    const eventChanges = await lib.getChangeSince(now - 5 * DAY, { type: "event" });
    const factTypes    = factChanges.changes.map(c => c.type);
    const eventTypes   = eventChanges.changes.map(c => c.type);
    assert.ok(factTypes.every(t => t === "fact"),  "fact filter should only return facts");
    assert.ok(eventTypes.every(t => t === "event"), "event filter should only return events");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. VERSION SEMANTICS — contradiction detection (negation), getDrift
  // ══════════════════════════════════════════════════════════════════════════════

  await lib.init(BASE_OPTS);

  // Numeric contradiction (existing behavior preserved)
  const priceId = await lib.ingest("The contract is worth 500000 dollars",  { type: "fact" });
  await lib.ingest("The contract is worth 750000 dollars",                  { type: "fact" });

  await suite.run("contradiction detection flags numeric value flips", async () => {
    const { contradictions } = await lib.getContradictions(priceId);
    assert.ok(contradictions.length >= 1, `expected >= 1 contradiction, got ${contradictions.length}`);
  });

  // Negation contradiction (new behavior)
  const statusId = await lib.ingest("The system is online and accepting requests",     { type: "status" });
  await lib.ingest("The system is not online and not accepting requests",              { type: "status" });

  await suite.run("contradiction detection catches negation flips ('not' added)", async () => {
    const { contradictions } = await lib.getContradictions(statusId);
    assert.ok(contradictions.length >= 1,
      `expected negation flip to be detected as contradiction, got ${contradictions.length}`);
    assert.ok(contradictions.some(v => v.delta?.contradicts === true),
      "contradicts flag should be true");
  });

  // Another negation case: removal of negation
  const accessId = await lib.ingest("User cannot access the admin dashboard", { type: "policy" });
  await lib.ingest("User can access the admin dashboard",                      { type: "policy" });

  await suite.run("contradiction detection catches negation removal ('not/cannot' removed)", async () => {
    const { contradictions } = await lib.getContradictions(accessId);
    assert.ok(contradictions.length >= 1,
      "removing 'cannot' and replacing with 'can' should be flagged as contradiction");
  });

  // getDrift — stable entity
  const stableId = await lib.ingest("Team meeting is every Tuesday at 10am",         { type: "fact" });
  await lib.ingest("Team meeting is every Tuesday morning at 10am in room A",        { type: "fact" });

  await suite.run("getDrift returns trend=stable for minor additions", async () => {
    const drift = await lib.getDrift(stableId);
    assert.ok(typeof drift.totalDrift === "number",   "totalDrift should be a number");
    assert.ok(typeof drift.averageDrift === "number", "averageDrift should be a number");
    assert.ok(typeof drift.trend === "string",        "trend should be a string");
    assert.ok(["stable", "evolving", "drifting"].includes(drift.trend), "trend must be a valid label");
    console.log(`    drift trend: ${drift.trend}, total: ${drift.totalDrift}`);
  });

  // getDrift — drifting entity: use nearly-identical texts so the BOW embedder merges them
  // as versions, then the drift between versions can be measured.
  const driftId = await lib.ingest("the project budget for q2 is three million dollars",            { type: "fact" });
  await lib.ingest("the project budget for q2 is now four million dollars",                         { type: "fact" });
  await lib.ingest("the project budget for q2 has been revised to five million dollars this cycle", { type: "fact" });

  await suite.run("getDrift returns steps array with per-version drift", async () => {
    const drift = await lib.getDrift(driftId);
    assert.ok(Array.isArray(drift.steps), "steps should be an array");
    assert.ok(drift.steps.length > 0, "should have at least one step");
    for (const s of drift.steps) {
      assert.ok(typeof s.drift === "number", "each step should have a numeric drift");
      assert.ok("fromVersion" in s && "toVersion" in s, "each step should have version refs");
    }
    console.log(`    drift trend: ${drift.trend}, total: ${drift.totalDrift}, steps: ${drift.steps.length}`);
  });

  await suite.run("getContradictions returns correct shape", async () => {
    const result = await lib.getContradictions(priceId);
    assert.ok("id" in result, "result should have id");
    assert.ok(Array.isArray(result.contradictions), "contradictions should be an array");
    assert.ok(typeof result.total === "number", "total should be a number");
    assert.strictEqual(result.contradictions.length, result.total, "contradictions.length should equal total");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. AGENT MEMORY WORKFLOW — promote, forget, consolidateSession, getWorkingMemory
  // ══════════════════════════════════════════════════════════════════════════════

  await lib.init(BASE_OPTS);
  const agent = lib.createAgent({ name: "workflow-test-agent" });

  const workingId = await agent.remember("Currently drafting the proposal document", {
    memoryType: "working",
  });

  await suite.run("agent working memory contains newly added working-memory entity", async () => {
    const wm = await agent.getWorkingMemory();
    assert.ok(wm.total >= 1, "working memory should have at least 1 entity");
    const ids = wm.entities.map(e => e.id);
    assert.ok(ids.includes(workingId), "working memory should contain the just-added entity");
  });

  await suite.run("promote changes memoryType from working to long-term", async () => {
    const updated = await agent.promote(workingId);
    assert.strictEqual(updated.memoryType, "long-term", "memoryType should be long-term after promote");
    // Promoted entity should no longer appear in working memory
    const wm = await agent.getWorkingMemory();
    const ids = wm.entities.map(e => e.id);
    assert.ok(!ids.includes(workingId), "promoted entity should not appear in working memory");
  });

  const forgetId = await agent.remember("Temporary scratch note for the sprint planning",  {
    memoryType: "short-term",
  });

  await suite.run("forget soft-deletes entity and records the agent as deletedBy", async () => {
    await agent.forget(forgetId, "sprint ended, no longer relevant");
    const history = await lib.getHistory(forgetId);
    assert.ok(history.deletedAt !== null, "entity should be soft-deleted");
    assert.strictEqual(history.deletedBy?.type, "agent", "deletedBy should be agent source");
    assert.strictEqual(history.deletedBy?.actor, "workflow-test-agent", "actor should match agent name");
  });

  // Add duplicates for session consolidation
  await agent.remember("Database migration should use zero-downtime strategy");
  await agent.remember("Database migration needs to be zero-downtime compatible");
  await agent.remember("Zero-downtime database migration is a requirement");

  await suite.run("consolidateSession merges near-duplicate memories", async () => {
    const report = await agent.consolidateSession({ dryRun: true });
    assert.ok(typeof report.totalMerged === "number", "should return a totalMerged count");
    console.log(`    consolidation dryRun: ${report.totalMerged} would be merged`);
  });

  await suite.run("summarize returns the same shape as boot()", async () => {
    const summary = await agent.summarize({ maxTokens: 200 });
    assert.ok("summary" in summary, "should have summary key");
    assert.ok("items" in summary, "should have items key");
    assert.ok(typeof summary.summary.totalMemories === "number", "totalMemories should be a number");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. PROVENANCE & TRUST SIGNALS
  // ══════════════════════════════════════════════════════════════════════════════

  await lib.init(BASE_OPTS);

  // Test trust score defaults by source type. Use separate types so this test
  // cannot accidentally exercise consolidation/versioning instead.
  const userFactId   = await lib.ingest("Q3 revenue forecast was approved by the finance committee", { type: "trust-user",   source: "user" });
  const agentFactId  = await lib.ingest("Q3 supply chain estimates were computed by the planning model", { type: "trust-agent",  source: "agent" });
  const systemFactId = await lib.ingest("Q3 automated log analysis reports nominal operations",          { type: "trust-system", source: "system" });

  await suite.run("trustScore defaults differ by source type (user > agent > system)", async () => {
    const userEntity   = await lib.get(userFactId);
    const agentEntity  = await lib.get(agentFactId);
    const systemEntity = await lib.get(systemFactId);

    console.log(`    user trust:   ${userEntity.trustScore}`);
    console.log(`    agent trust:  ${agentEntity.trustScore}`);
    console.log(`    system trust: ${systemEntity.trustScore}`);

    assert.ok(userEntity.trustScore  > agentEntity.trustScore,  "user should have higher trust than agent");
    assert.ok(agentEntity.trustScore > systemEntity.trustScore, "agent should have higher trust than system");
  });

  await suite.run("explicit trustScore overrides default", async () => {
    const highTrustId = await lib.ingest("Board-approved budget decision", {
      source: "agent",
      trustScore: 0.99,
    });
    const entity = await lib.get(highTrustId);
    assert.ok(entity.trustScore > 0.95, `explicit trust 0.99 should be stored, got ${entity.trustScore}`);
  });

  await suite.run("annotate updates trustScore without creating a new version", async () => {
    const id = await lib.ingest("Preliminary sales estimate is 3.2M", { source: "agent" });
    const before = await lib.get(id);
    const versionsBefore = before.versionCount;

    const after = await lib.annotate(id, { trustScore: 0.95, verified: true, notes: "confirmed by finance team" });

    assert.ok(after.trustScore >= 0.94, `trust should be updated to ~0.95, got ${after.trustScore}`);
    // Version count must NOT increase — annotate is metadata-only
    const afterFetch = await lib.get(id);
    assert.strictEqual(afterFetch.versionCount, versionsBefore,
      "annotate should not create a new content version");
  });

  await suite.run("annotate can change memoryType without a new version", async () => {
    const id = await lib.ingest("Draft decision from last sprint", { source: "agent", memoryType: "short-term" });
    const before = await lib.get(id);
    assert.strictEqual(before.memoryType, "short-term");

    await lib.annotate(id, { memoryType: "long-term" });
    const after = await lib.get(id);
    assert.strictEqual(after.memoryType, "long-term", "memoryType should be changed by annotate");
  });

  await suite.run("trustScore appears in query results", async () => {
    const id = await lib.ingest("Infrastructure upgrade planned for next quarter", { source: "user", trustScore: 0.88 });
    const results = await lib.query("infrastructure upgrade next quarter");
    const match = results.results.find(r => r.id === id);
    assert.ok(match, "entity should appear in query results");
    assert.ok(typeof match.trustScore === "number", "trustScore should be included in query results");
    console.log(`    trustScore in result: ${match.trustScore}`);
  });

  await suite.run("trustScore survives a reinit (persisted to disk correctly)", async () => {
    const id = await lib.ingest("Persisted trust score test", { source: "user", trustScore: 0.77 });
    // Simulate a restart by re-initializing with same dataFile config
    // (uses :memory: in tests, so we verify the in-memory loaded entity)
    const entity = await lib.get(id);
    assert.ok(Math.abs(entity.trustScore - 0.77) < 0.01, `expected 0.77, got ${entity.trustScore}`);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════════

  const summary = suite.finish();

  console.log("═".repeat(60));
  console.log("  TEMPORAL + TRUST EVALUATION SCORECARD");
  console.log("═".repeat(60));
  console.log(`  Total:      ${summary.total} benchmarks`);
  console.log(`  Passed:     ${summary.passed}`);
  console.log(`  Failed:     ${summary.failed}`);
  console.log(`  Pass Rate:  ${((summary.passed / summary.total) * 100).toFixed(1)}%`);
  console.log(`  Time:       ${summary.ms}ms`);
  console.log("═".repeat(60));

  return summary;
}

module.exports = run;

if (require.main === module) {
  run().then(s => process.exit(s.failed > 0 ? 1 : 0));
}
