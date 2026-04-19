#!/usr/bin/env node
// bench/agent-memory/bench-eval-real.js — Eval benchmarks with real embeddings
//
// Runs the same scenarios as bench-eval.js but with OpenAI text-embedding-3-small
// (or any provider via EMBED_URL / EMBED_MODEL env vars).
//
// Usage:
//   OPENAI_API_KEY=sk-... node bench/agent-memory/bench-eval-real.js
//
// Environment:
//   OPENAI_API_KEY   — required (unless EMBED_URL is set)
//   EMBED_URL        — override embedding endpoint (default: OpenAI)
//   EMBED_MODEL      — override model name (default: text-embedding-3-small)
"use strict";

const assert = require("assert/strict");
const lib = require("../../index");

const DAY = 86_400_000;

// ─── Real embedder ──────────────────────────────────────────────────────────

const EMBED_URL   = process.env.EMBED_URL   || "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const API_KEY     = process.env.OPENAI_API_KEY;

if (!API_KEY && !process.env.EMBED_URL) {
  console.error("\n  ERROR: Set OPENAI_API_KEY to run real-embedding benchmarks.\n");
  console.error("  Usage: OPENAI_API_KEY=sk-... node bench/agent-memory/bench-eval-real.js\n");
  process.exit(1);
}

let embedCalls = 0;

async function realEmbedder(text) {
  embedCalls++;
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: String(text).slice(0, 2000) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data[0].embedding;
}

const BASE_OPTS = {
  dataFile: ":memory:",
  embedFn: realEmbedder,
  linkThreshold: 0.72,
  versionThreshold: 0.82,
  minFinalScore: 0.15,
  minSemanticScore: 0.15,
  recencyWeight: 0.15,
  recencyHalfLifeMs: 2 * DAY,
};

// ─── Metrics helpers (same as bench-eval.js) ────────────────────────────────

function recallAtK(results, relevantIds, k) {
  const topK = results.slice(0, k).map(r => r.id);
  const found = relevantIds.filter(id => topK.includes(id));
  return relevantIds.length === 0 ? 1 : found.length / relevantIds.length;
}

function precisionAtK(results, relevantIds, k) {
  const topK = results.slice(0, k).map(r => r.id);
  const relevant = topK.filter(id => relevantIds.includes(id));
  return topK.length === 0 ? 1 : relevant.length / topK.length;
}

function mrr(results, relevantIds) {
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.includes(results[i].id)) return 1 / (i + 1);
  }
  return 0;
}

// ─── Harness ────────────────────────────────────────────────────────────────

const results = [];
let startTime;

async function run(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name, pass: true, ms });
    console.log(`  PASS  ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    results.push({ name, pass: false, error: err.message, ms });
    console.log(`  FAIL  ${name} (${ms}ms)`);
    console.log(`        ${err.message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("\n" + "═".repeat(60));
  console.log("  REAL EMBEDDING EVAL — " + EMBED_MODEL);
  console.log("═".repeat(60) + "\n");
  startTime = Date.now();

  // ── Scenario 1: Basic Recall ────────────────────────────────────────────

  await lib.init(BASE_OPTS);

  const topicA = []; // finance
  const topicB = []; // engineering
  const topicC = []; // health

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

  // noise
  await lib.ingest("the weather in tokyo is partly cloudy with a high of 22 celsius");
  await lib.ingest("recipe for chocolate cake requires cocoa butter and vanilla extract");
  await lib.ingest("the history of roman architecture spans several centuries");
  await lib.ingest("jazz music originated in new orleans in the early twentieth century");
  await lib.ingest("the migration patterns of monarch butterflies cover thousands of miles");

  await run("recall@5 for finance queries >= 0.75", async () => {
    const r = await lib.query("quarterly revenue budget expenses financial", { limit: 5 });
    const recall = recallAtK(r.results, topicA, 5);
    console.log(`    recall@5 = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.75, `recall@5 was ${recall}, expected >= 0.75`);
  });

  await run("recall@5 for engineering queries >= 0.75", async () => {
    const r = await lib.query("kubernetes database deployment engineering infrastructure", { limit: 5 });
    const recall = recallAtK(r.results, topicB, 5);
    console.log(`    recall@5 = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.75, `recall@5 was ${recall}, expected >= 0.75`);
  });

  await run("precision@3 for health queries >= 0.67", async () => {
    const r = await lib.query("patient health clinical treatment hospital", { limit: 3 });
    const precision = precisionAtK(r.results, topicC, 3);
    console.log(`    precision@3 = ${(precision * 100).toFixed(1)}%`);
    assert.ok(precision >= 0.67, `precision@3 was ${precision}, expected >= 0.67`);
  });

  await run("MRR for targeted finance query >= 1.0", async () => {
    const r = await lib.query("revenue million dollars quarterly projection", { limit: 10 });
    const score = mrr(r.results, topicA);
    console.log(`    MRR = ${score.toFixed(3)}`);
    assert.ok(score >= 1.0, `MRR was ${score}, expected >= 1.0`);
  });

  await run("noise separation: zero noise in top-3 finance results", async () => {
    const noise = [];
    const r = await lib.query("quarterly revenue budget expenses financial", { limit: 3 });
    const financeInTop3 = r.results.filter(x => topicA.includes(x.id)).length;
    console.log(`    finance in top 3 = ${financeInTop3}/3`);
    assert.ok(financeInTop3 === 3, `expected 3 finance entities in top 3, got ${financeInTop3}`);
  });

  // ── Scenario 2: Temporal Recall Accuracy ──────────────────────────────────

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

  await run("asOf returns correct version (stock price 30 days ago)", async () => {
    const r = await lib.queryAt("stock price", now - 25 * DAY, { limit: 1 });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("150"), `expected '150', got: ${r.results[0].text}`);
  });

  await run("asOf returns correct version (stock price 10 days ago)", async () => {
    const r = await lib.queryAt("stock price", now - 10 * DAY, { limit: 1 });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("175"), `expected '175', got: ${r.results[0].text}`);
  });

  await run("current query returns latest version", async () => {
    const r = await lib.query("stock price", { limit: 1 });
    assert.ok(r.results.length >= 1, "should find stock price");
    assert.ok(r.results[0].text.includes("162"), `expected '162', got: ${r.results[0].text}`);
  });

  await run("version history tracks all changes", async () => {
    const h = await lib.getHistory(priceId);
    assert.ok(h.versions.length >= 3, `expected >= 3 versions, got ${h.versions.length}`);
  });

  await run("contradiction detection flags value changes", async () => {
    const h = await lib.getHistory(priceId);
    const contradictions = h.versions.filter(v => v.delta?.contradicts);
    assert.ok(contradictions.length >= 1, "should detect at least one contradiction");
  });

  // ── Scenario 3: Token-Budget Efficiency ───────────────────────────────────

  await lib.init(BASE_OPTS);

  await lib.ingest("quarterly earnings report shows strong performance in all segments");
  await lib.ingest("the new product launch exceeded initial sales projections by 40 percent");
  await lib.ingest("customer satisfaction scores improved across all regions this quarter");
  await lib.ingest("supply chain costs were reduced by 8 percent through vendor renegotiation");
  await lib.ingest("employee retention rate increased to 94 percent after benefits restructuring");

  await run("token budget limits results correctly", async () => {
    const small = await lib.query("business performance", { maxTokens: 100, limit: 10 });
    const large = await lib.query("business performance", { maxTokens: 5000, limit: 10 });
    console.log(`    small: ${small.results.length} results (${small.tokenUsage.used} tokens)`);
    console.log(`    large: ${large.results.length} results (${large.tokenUsage.used} tokens)`);
    assert.ok(large.results.length >= small.results.length, "larger budget should fit more results");
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  const totalMs = Date.now() - startTime;
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log("\n" + "═".repeat(60));
  console.log("  REAL EMBEDDING SCORECARD");
  console.log("═".repeat(60));
  console.log(`  Model:      ${EMBED_MODEL}`);
  console.log(`  Total:      ${results.length} benchmarks`);
  console.log(`  Passed:     ${passed}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Pass Rate:  ${((passed / results.length) * 100).toFixed(1)}%`);
  console.log(`  Time:       ${totalMs}ms`);
  console.log(`  API calls:  ${embedCalls}`);
  console.log("═".repeat(60) + "\n");

  await lib.shutdown();
  process.exit(failed > 0 ? 1 : 0);
})();
