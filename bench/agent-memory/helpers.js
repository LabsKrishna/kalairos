// bench/agent-memory/helpers.js — Shared deterministic test infrastructure
"use strict";

const lib = require("../../index");

// ─── Deterministic bag-of-words embedder ────────────────────────────────────
// Produces identical vectors for identical input — no randomness, no external calls.
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

const DIM = 64;
const DAY = 86_400_000;

const BASE_OPTS = {
  dataFile: ":memory:",
  embeddingDim: DIM,
  embedFn: makeMockEmbedder(DIM),
  linkThreshold: 0.72,
  versionThreshold: 0.82,
  minFinalScore: 0.15,
  minSemanticScore: 0.15,
  recencyWeight: 0.15,
  recencyHalfLifeMs: 2 * DAY,
};

// ─── Benchmark harness ──────────────────────────────────────────────────────

class BenchSuite {
  constructor(name) {
    this.name = name;
    this.results = [];
    this._startTime = null;
  }

  start() {
    this._startTime = Date.now();
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  BENCH: ${this.name}`);
    console.log(`${"═".repeat(60)}\n`);
  }

  /**
   * Run a single named assertion. The test fn may return a numeric metric value
   * (e.g. the measured recall/precision/MRR) which is captured alongside the
   * pass/fail result. When an SLA entry exists for the name, the threshold and
   * comparator are recorded too so downstream consumers (JSON report, dashboards)
   * have a full picture without re-parsing assertion messages.
   *
   * @param {string} name
   * @param {Function} fn — async; may return `number` or `{ measured, ... }`
   * @returns {{ name, pass, error?, ms, measured?, threshold?, comparator? }}
   */
  async run(name, fn) {
    const t0 = Date.now();
    const sla = (this.sla && this.sla[name]) || null;
    try {
      const ret = await fn();
      const ms = Date.now() - t0;
      let measured = null;
      if (typeof ret === "number") measured = ret;
      else if (ret && typeof ret === "object" && typeof ret.measured === "number") measured = ret.measured;
      const entry = { name, pass: true, ms };
      if (measured !== null) entry.measured = measured;
      if (sla) { entry.threshold = sla.threshold; entry.comparator = sla.comparator; entry.metric = sla.metric; }
      this.results.push(entry);
      const measuredStr = measured !== null ? ` [${sla?.metric || "value"}=${measured.toFixed(3)}]` : "";
      console.log(`  PASS  ${name} (${ms}ms)${measuredStr}`);
    } catch (err) {
      const ms = Date.now() - t0;
      const entry = { name, pass: false, error: err.message, ms };
      if (sla) { entry.threshold = sla.threshold; entry.comparator = sla.comparator; entry.metric = sla.metric; }
      this.results.push(entry);
      console.log(`  FAIL  ${name} (${ms}ms)`);
      console.log(`        ${err.message}`);
    }
  }

  /** Attach an SLA table so run() can annotate results with metric/threshold metadata. */
  setSLA(sla) { this.sla = sla || {}; }

  /** Print summary and return { suite, passed, failed, total, ms, results }. */
  finish() {
    const totalMs = Date.now() - this._startTime;
    const passed = this.results.filter(r => r.pass).length;
    const failed = this.results.length - passed;
    console.log(`\n  ${passed}/${this.results.length} passed, ${failed} failed (${totalMs}ms)\n`);
    return {
      suite: this.name,
      passed,
      failed,
      total: this.results.length,
      ms: totalMs,
      results: this.results,
    };
  }
}

module.exports = { lib, makeMockEmbedder, BASE_OPTS, DIM, DAY, BenchSuite };
