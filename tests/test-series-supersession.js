// test-series-supersession.js — Metric/series supersession ≠ contradiction
// Run: node tests/test-series-supersession.js
//
// Core belief under test (CLAUDE.md §0, §14): a value that changes over time is
// not a lie. "Apple stock price is 200" on Jun-22 and "...190" on Jun-23 are
// BOTH true — the new reading retires the old into a closed valid interval. For
// metric/series entities this must produce NO contradiction signal and NO trust
// penalty, while text/fact entities keep full poisoning-defense behavior.
"use strict";

const assert = require("assert/strict");
const lib    = require("../index");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}\n       ${e.message}`); failed++; }
}

// Bag-of-words mock embedder. Strips digits, so "...200 dollars" and
// "...190 dollars" embed identically → they merge as a version update, and the
// numeric flip is detected by the text-diff inside buildDelta (not the vector).
function makeMockEmbedder(dim = 64) {
  const vocab = new Map();
  return async function embed(text) {
    const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
    const vec   = new Array(dim).fill(0);
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
      vec[vocab.get(w) % dim]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

const INIT_OPTS = {
  dataFile:         ":memory:",
  embeddingDim:     64,
  embedFn:          makeMockEmbedder(64),
  versionThreshold: 0.80,
  linkThreshold:    0.72,
  minFinalScore:    0.20,
  trustWeight:      0.4, // so trust influences query ranking/score
};

const JUN22 = Date.parse("2026-06-22T00:00:00Z");
const JUN23 = Date.parse("2026-06-23T00:00:00Z");
const feed  = { type: "tool", uri: "http://feed.example/aapl", actor: "price-feed" };

(async () => {
  console.log("\n── metric series supersession ───────────────────────────────────");
  await lib.init(INIT_OPTS);

  // Seed a 2-point metric series on the same entity.
  const id1 = await lib.ingest("Apple stock price is 200 dollars",
    { type: "metric", source: feed, effectiveAt: JUN22 });
  const id2 = await lib.ingest("Apple stock price is 190 dollars",
    { type: "metric", source: feed, effectiveAt: JUN23 });

  await test("forward-in-time reading merges into the same series entity", () => {
    assert.strictEqual(id1, id2, "second reading must version the same entity");
  });

  const h = await lib.getHistory(id1);
  const v2 = h.versions[1]; // oldest-first; [1] is the 190 update

  await test("supersession carries NO contradiction signal", () => {
    assert.equal(v2.delta.contradicts, false, "must not be flagged as a contradiction");
    assert.equal(v2.delta.contradictionSeverity, 0, "severity must be 0");
    assert.equal(v2.delta.supersedes, true, "must be marked as supersession");
  });

  await test("prior reading's valid interval is closed at the new effectiveAt", () => {
    assert.equal(h.versions[0].validTo, JUN23, "old interval must end where new one begins");
    assert.equal(h.versions[1].validTo, null, "newest reading stays open-ended");
  });

  await test("no 'contested' breadcrumb is written for a clean supersession", () => {
    const contested = (h.trailEvents || []).filter(e => e.action === "contested");
    assert.equal(contested.length, 0, `expected 0 contested events, got ${contested.length}`);
  });

  await test("trust is NOT penalized by legitimate change", async () => {
    const { results } = await lib.query("Apple stock price", { limit: 5 });
    const r = results.find(x => x.id === id1);
    assert.ok(r, "series entity must be retrievable");
    // tool base 0.80, recency ~1, no contradiction → ~0.80. The old (broken)
    // behavior subtracted 0.3×0.7×0.80 = 0.168, dropping it to ~0.63.
    assert.ok(r.trust > 0.75, `trust should stay high, got ${r.trust}`);
  });

  console.log("\n── guards: contradiction still fires when it should ─────────────");

  await test("metric: a SAME-time conflicting value IS a contradiction", async () => {
    // Assert a different value for a time we already have (Jun-23) → not a new
    // interval, a genuine conflict ("was it 210 on Jun-23?").
    const id3 = await lib.ingest("Apple stock price is 210 dollars",
      { type: "metric", source: feed, effectiveAt: JUN23 });
    const hist = await lib.getHistory(id3);
    const last = hist.versions[hist.versions.length - 1];
    assert.equal(last.delta.contradicts, true, "same-time value conflict must be flagged");
    assert.ok(last.delta.contradictionSeverity > 0, "severity must be > 0");
  });

  await test("text/fact: numeric flip STILL contradicts (poisoning defense intact)", async () => {
    const fId = await lib.ingest("API rate limit is 100 requests per minute",
      { source: { type: "user", actor: "eng-lead" } });
    await lib.ingest("API rate limit is 10000 requests per minute",
      { source: { type: "tool", uri: "http://evil.example" } });
    const fh = await lib.getHistory(fId);
    const flip = fh.versions[fh.versions.length - 1];
    assert.equal(flip.delta.contradicts, true, "text numeric flip must stay a contradiction");
    assert.ok(flip.delta.contradictionSeverity >= 0.7, "severity must be full-strength");
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await lib.shutdown();
  process.exit(failed === 0 ? 0 : 1);
})();
