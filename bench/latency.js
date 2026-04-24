// bench/latency.js — Query-latency benchmark
//
// Purpose: measure end-to-end `query()` latency at realistic corpus sizes,
// so we can honour the Stage-1 latency budget (p95 < 50ms at 10k entities).
//
// Usage: node bench/latency.js
// Output: prints a table + writes bench/latency-results.json
//
// Uses a deterministic bag-of-words embedder (same shape as bench/agent-memory/helpers.js)
// so numbers are reproducible on any machine without an API key.
"use strict";

const fs = require("fs");
const path = require("path");
const kalairos = require("..");

const DIM = 64;

function makeEmbedder(dim = DIM) {
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

// Deterministic PRNG so corpus and queries don't drift between runs.
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "revenue", "budget", "customer", "ticket", "refund", "deploy", "release", "meeting",
  "agent", "policy", "vendor", "contract", "roadmap", "bug", "feature", "metric",
  "latency", "memory", "cache", "quota", "token", "workspace", "tenant", "audit",
  "compliance", "privacy", "vector", "embedding", "graph", "query", "version", "trust",
  "provenance", "source", "document", "report", "summary", "ingest", "retention",
  "classification", "confidential", "internal", "regulated", "public", "index",
  "search", "hybrid", "scoring", "recency", "importance", "session", "user", "admin",
];

function randomSentence(rand, nWords = 10) {
  const out = [];
  for (let i = 0; i < nWords; i++) {
    out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  }
  return out.join(" ");
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

function fmt(ms) { return ms.toFixed(2).padStart(7); }

async function runScale(n, queryCount) {
  const rand = mulberry32(1234);
  const dataFile = ":memory:";

  await kalairos.init({
    embedFn: makeEmbedder(),
    embeddingDim: DIM,
    dataFile,
    // Keep numbers honest — no LLM path, no recency games.
    minFinalScore: 0.0,
    minSemanticScore: 0.0,
  });

  // ── Seed N entities (timing the ingest too, FYI) ──────────────────────────
  const ingestT0 = Date.now();
  // Use ingest directly to avoid version-merge overhead on identical content.
  for (let i = 0; i < n; i++) {
    await kalairos.ingest(randomSentence(rand, 10));
  }
  const ingestMs = Date.now() - ingestT0;

  // ── Warm-up ──────────────────────────────────────────────────────────────
  for (let i = 0; i < 20; i++) await kalairos.query(randomSentence(rand, 4));

  // ── Measure query latency ────────────────────────────────────────────────
  const samples = [];
  for (let i = 0; i < queryCount; i++) {
    const q = randomSentence(rand, 4);
    const t0 = process.hrtime.bigint();
    await kalairos.query(q, { limit: 10 });
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6); // ms
  }
  samples.sort((a, b) => a - b);

  const result = {
    entities:  n,
    queries:   queryCount,
    ingestMs,
    ingestPerItemMs: Number((ingestMs / n).toFixed(3)),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    max: samples[samples.length - 1],
  };

  await kalairos.shutdown();
  return result;
}

(async () => {
  const scales = [
    { n: 1000,  q: 500 },
    { n: 10000, q: 300 },
  ];

  const results = [];
  console.log("");
  console.log("═".repeat(68));
  console.log("  KALAIROS — QUERY LATENCY BENCHMARK");
  console.log("═".repeat(68));
  console.log("  embedder: deterministic bag-of-words (dim=64)");
  console.log("  store:    in-memory (JSONL path-equivalent; no disk I/O)");
  console.log("  node:    ", process.version);
  console.log("");
  console.log("  entities  queries     p50       p95       p99       mean      max");
  console.log("  ──────── ────────  ───────── ───────── ───────── ───────── ─────────");

  for (const { n, q } of scales) {
    const r = await runScale(n, q);
    results.push(r);
    console.log(
      `  ${String(n).padStart(8)} ${String(q).padStart(8)}  ` +
      `${fmt(r.p50)}ms ${fmt(r.p95)}ms ${fmt(r.p99)}ms ${fmt(r.mean)}ms ${fmt(r.max)}ms`
    );
  }

  const outPath = path.join(__dirname, "latency-results.json");
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    node:  process.version,
    platform: process.platform,
    arch: process.arch,
    embedder: "deterministic bag-of-words, dim=64",
    results,
  }, null, 2));
  console.log("");
  console.log(`  Wrote ${outPath}`);
  console.log("");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
