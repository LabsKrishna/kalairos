// bench/agent-memory/bench-eval.js — Memory evaluation benchmarks
// Measures recall@k, precision@k, MRR, temporal accuracy, and token-budget efficiency.
// These are the numbers that differentiate DBX from generic vector stores.
"use strict";

const assert = require("assert/strict");
const { lib, BASE_OPTS, DAY, BenchSuite } = require("./helpers");

// ─── Metrics helpers ────────────────────────────────────────────────────────

/** Recall@k: fraction of relevant items found in top-k results */
function recallAtK(results, relevantIds, k) {
  const topK = results.slice(0, k).map(r => r.id);
  const found = relevantIds.filter(id => topK.includes(id));
  return relevantIds.length === 0 ? 1 : found.length / relevantIds.length;
}

/** Precision@k: fraction of top-k results that are relevant */
function precisionAtK(results, relevantIds, k) {
  const topK = results.slice(0, k).map(r => r.id);
  const relevant = topK.filter(id => relevantIds.includes(id));
  return topK.length === 0 ? 1 : relevant.length / topK.length;
}

/** MRR: reciprocal rank of the first relevant result */
function mrr(results, relevantIds) {
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.includes(results[i].id)) return 1 / (i + 1);
  }
  return 0;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

async function run() {
  const suite = new BenchSuite("Memory Evaluation Benchmarks");
  suite.start();

  // ── Scenario 1: Basic Recall ──────────────────────────────────────────────
  // Store 20 diverse memories, query for specific topics, measure recall@5

  await lib.init(BASE_OPTS);

  const topicA = []; // finance
  const topicB = []; // engineering
  const topicC = []; // health
  const noise  = []; // unrelated

  topicA.push(await lib.ingest("Q2 revenue is projected at 2.4 million dollars", { type: "fact", tags: ["finance"] }));
  topicA.push(await lib.ingest("operating expenses increased by 12 percent this quarter", { type: "fact", tags: ["finance"] }));
  topicA.push(await lib.ingest("gross margin improved to 68 percent year over year", { type: "fact", tags: ["finance"] }));
  topicA.push(await lib.ingest("annual budget allocation approved by board of directors", { type: "fact", tags: ["finance"] }));

  topicB.push(await lib.ingest("kubernetes cluster scaled to 50 nodes for production deployment", { type: "fact", tags: ["engineering"] }));
  topicB.push(await lib.ingest("database migration from postgres to distributed storage completed", { type: "fact", tags: ["engineering"] }));
  topicB.push(await lib.ingest("CI pipeline now runs integration tests in parallel reducing build time", { type: "fact", tags: ["engineering"] }));
  topicB.push(await lib.ingest("API latency p99 reduced from 800ms to 120ms after caching layer", { type: "fact", tags: ["engineering"] }));

  topicC.push(await lib.ingest("patient blood pressure readings stable at 120 over 80", { type: "fact", tags: ["health"] }));
  topicC.push(await lib.ingest("new clinical trial for diabetes treatment started phase two", { type: "fact", tags: ["health"] }));
  topicC.push(await lib.ingest("hospital readmission rates decreased by 15 percent", { type: "fact", tags: ["health"] }));

  noise.push(await lib.ingest("the weather in tokyo is partly cloudy with a high of 22 celsius"));
  noise.push(await lib.ingest("recipe for chocolate cake requires cocoa butter and vanilla extract"));
  noise.push(await lib.ingest("the history of roman architecture spans several centuries"));
  noise.push(await lib.ingest("jazz music originated in new orleans in the early twentieth century"));
  noise.push(await lib.ingest("the migration patterns of monarch butterflies cover thousands of miles"));

  await suite.run("recall@5 for finance queries >= 0.50", async () => {
    const r = await lib.query("quarterly revenue budget expenses financial", { limit: 5 });
    const recall = recallAtK(r.results, topicA, 5);
    console.log(`    recall@5 = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.50, `recall@5 was ${recall}, expected >= 0.50`);
  });

  await suite.run("recall@5 for engineering queries >= 0.50", async () => {
    const r = await lib.query("kubernetes database deployment engineering infrastructure", { limit: 5 });
    const recall = recallAtK(r.results, topicB, 5);
    console.log(`    recall@5 = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.50, `recall@5 was ${recall}, expected >= 0.50`);
  });

  await suite.run("precision@3 for health queries >= 0.33", async () => {
    const r = await lib.query("patient health clinical treatment hospital", { limit: 3 });
    const precision = precisionAtK(r.results, topicC, 3);
    console.log(`    precision@3 = ${(precision * 100).toFixed(1)}%`);
    assert.ok(precision >= 0.33, `precision@3 was ${precision}, expected >= 0.33`);
  });

  await suite.run("MRR for targeted finance query >= 0.50", async () => {
    const r = await lib.query("revenue million dollars quarterly projection", { limit: 10 });
    const score = mrr(r.results, topicA);
    console.log(`    MRR = ${score.toFixed(3)}`);
    assert.ok(score >= 0.50, `MRR was ${score}, expected >= 0.50`);
  });

  await suite.run("noise separation: finance query ranks finance above noise", async () => {
    const r = await lib.query("quarterly revenue budget expenses financial", { limit: 5 });
    // At least half the top-5 should be finance entities, not noise
    const financeInTop5 = r.results.filter(x => topicA.includes(x.id)).length;
    console.log(`    finance in top 5 = ${financeInTop5}/5`);
    assert.ok(financeInTop5 >= 2, `expected >= 2 finance entities in top 5, got ${financeInTop5}`);
  });

  // ── Scenario 2: Temporal Recall Accuracy ──────────────────────────────────
  // Store evolving facts with timestamps, verify asOf queries return correct versions

  await lib.init(BASE_OPTS);
  const now = Date.now();

  const priceId = await lib.ingest("stock price is 150 dollars per share", {
    type: "metric", timestamp: now - 30 * DAY,
  });
  await lib.ingest("stock price is 175 dollars per share", {
    type: "metric", timestamp: now - 15 * DAY,
  });
  await lib.ingest("stock price is 162 dollars per share", {
    type: "metric", timestamp: now - 1 * DAY,
  });

  const headcountId = await lib.ingest("team headcount is 45 engineers", {
    type: "metric", timestamp: now - 20 * DAY,
  });
  await lib.ingest("team headcount is 52 engineers after hiring sprint", {
    type: "metric", timestamp: now - 5 * DAY,
  });

  await suite.run("asOf returns correct historical version (stock price 30 days ago)", async () => {
    const r = await lib.query("stock price", { limit: 1, asOf: now - 25 * DAY });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("150"), `expected '150' in text, got: ${r.results[0].text}`);
  });

  await suite.run("asOf returns correct version (stock price 10 days ago)", async () => {
    const r = await lib.query("stock price", { limit: 1, asOf: now - 10 * DAY });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("175"), `expected '175' in text, got: ${r.results[0].text}`);
  });

  await suite.run("current query returns latest version", async () => {
    const r = await lib.query("stock price", { limit: 1 });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("162"), `expected '162' in text, got: ${r.results[0].text}`);
  });

  await suite.run("version history tracks all temporal changes", async () => {
    const h = await lib.getHistory(priceId);
    assert.ok(h.versions.length >= 3, `expected >= 3 versions, got ${h.versions.length}`);
  });

  await suite.run("contradiction detection flags value changes", async () => {
    const h = await lib.getHistory(priceId);
    const contradictions = h.versions.filter(v => v.delta?.contradicts);
    assert.ok(contradictions.length >= 1, "should detect at least one contradiction");
  });

  // ── Scenario 3: Token-Budget Efficiency ───────────────────────────────────

  await lib.init(BASE_OPTS);

  // Ingest a corpus of varied-length memories
  const lengths = [50, 100, 200, 400, 800];
  for (const len of lengths) {
    const words = [];
    for (let i = 0; i < len; i++) words.push("memory");
    words.push("important fact about system performance");
    await lib.ingest(words.join(" "), { type: "fact" });
  }

  await suite.run("token budget returns tokenUsage metadata", async () => {
    const r = await lib.query("system performance memory", { maxTokens: 2000 });
    assert.ok(r.tokenUsage, "should include tokenUsage");
    assert.ok(r.tokenUsage.budget === 2000, "budget should match input");
    assert.ok(typeof r.tokenUsage.used === "number", "used should be a number");
    assert.ok(typeof r.tokenUsage.resultsDropped === "number", "should report dropped count");
  });

  await suite.run("small token budget returns fewer results than large", async () => {
    const small = await lib.query("system performance memory", { maxTokens: 200, limit: 10 });
    const large = await lib.query("system performance memory", { maxTokens: 10000, limit: 10 });
    console.log(`    small: ${small.results.length} results (${small.tokenUsage.used} tokens)`);
    console.log(`    large: ${large.results.length} results (${large.tokenUsage.used} tokens)`);
    assert.ok(large.results.length >= small.results.length, "larger budget should fit more results");
  });

  await suite.run("token budget preserves score ordering", async () => {
    const r = await lib.query("system performance memory", { maxTokens: 5000, limit: 10 });
    for (let i = 1; i < r.results.length; i++) {
      assert.ok(r.results[i - 1].score >= r.results[i].score, "results must be sorted by score desc");
    }
  });

  // ── Scenario 4: Cross-Domain Separation ───────────────────────────────────

  await lib.init(BASE_OPTS);

  const domainA = await lib.ingest("the machine learning model achieved 95 percent accuracy on test set");
  const domainB = await lib.ingest("the contract renewal deadline is next friday for the vendor agreement");

  await suite.run("cross-domain: ML query ranks ML fact first", async () => {
    const r = await lib.query("machine learning model accuracy", { limit: 2 });
    assert.ok(r.results.length >= 1, "should return results");
    assert.strictEqual(r.results[0].id, domainA, "ML entity should rank first");
  });

  await suite.run("cross-domain: contract query ranks contract fact first", async () => {
    const r = await lib.query("contract renewal vendor deadline agreement", { limit: 2 });
    assert.ok(r.results.length >= 1, "should return results");
    assert.strictEqual(r.results[0].id, domainB, "contract entity should rank first");
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  const summary = suite.finish();

  console.log("═".repeat(60));
  console.log("  EVALUATION SCORECARD");
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
