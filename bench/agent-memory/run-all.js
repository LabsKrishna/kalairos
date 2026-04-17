#!/usr/bin/env node
// bench/agent-memory/run-all.js — Benchmark runner + Constitution Goal Scorecard
//
// Usage: node bench/agent-memory/run-all.js
"use strict";

const budgetDrift      = require("./bench-budget-drift");
const contradictions   = require("./bench-contradictions");
const crossSession     = require("./bench-cross-session");
const metadataEvol     = require("./bench-metadata-evolution");
const evalBench        = require("./bench-eval");
const { lib }          = require("./helpers");
const temporalTrust    = require("./bench-temporal-trust");

// ─── Constitution Goal Mapping ──────────────────────────────────────────────
// Each assertion maps to a CLAUDE.md goal. The scorecard tracks coverage.

const GOALS = {
  "time-aware-recall":     { label: "Time-Aware Recall (asOf + recency)",         tests: [] },
  "provenance":            { label: "Provenance & Audit Trail",                   tests: [] },
  "contradiction":         { label: "Contradiction Detection & Visibility",       tests: [] },
  "classification":        { label: "Classification & Compliance",                tests: [] },
  "agent-memory":          { label: "Agent-Friendly Durable Memory",              tests: [] },
  "cross-session":         { label: "Cross-Session Recall",                       tests: [] },
  "workspace-isolation":   { label: "Workspace / Tenant Isolation",               tests: [] },
  "soft-delete":           { label: "Soft Delete & GDPR Purge",                   tests: [] },
  "error-signals":         { label: "Error → Signal → Learning Loop",             tests: [] },
  "metadata-evolution":    { label: "Metadata & Tag Evolution",                   tests: [] },
};

// Maps test names (substrings) → goal keys
const TEST_GOAL_MAP = [
  [/time.travel|asOf|day \d|temporal|historical|getChangeSince|changedAt|cutoff/i, "time-aware-recall"],
  [/provenance|source|actor|trust|annotate|verified|trustScore/i,                  "provenance"],
  [/contradict|negation|negat|cannot|not online|negate/i,                          "contradiction"],
  [/classif|confidential|compliance/i,                                             "classification"],
  [/cross.session|planner|across.*agent|both.*agent/i,                             "cross-session"],
  [/stable.identity|remember|agent|recall|latest|MRR|precision|token.budget|promote|forget|working.memory|consolidate|summarize/i, "agent-memory"],
  [/workspace|isolat/i,                                                            "workspace-isolation"],
  [/soft.delet|purg|double.delete|gone/i,                                          "soft-delete"],
  [/signal|error.*type|getSignal/i,                                                "error-signals"],
  [/tag|retention|metadata|status|cross.domain|noise|version.history|drift/i,      "metadata-evolution"],
];

function classifyResults(suiteResults) {
  for (const r of suiteResults) {
    for (const [re, goal] of TEST_GOAL_MAP) {
      if (re.test(r.name)) {
        GOALS[goal].tests.push(r);
        break;
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log("\n" + "█".repeat(60));
  console.log("  DATABASE X — AGENT MEMORY BENCHMARK SUITE");
  console.log("█".repeat(60));

  const suites = [
    { name: "budget-drift",       fn: budgetDrift.run },
    { name: "contradictions",     fn: contradictions.run },
    { name: "cross-session",      fn: crossSession.run },
    { name: "metadata-evolution", fn: metadataEvol.run },
    { name: "eval-metrics",       fn: evalBench },
    { name: "temporal-trust",     fn: temporalTrust },
  ];

  const summaries = [];
  for (const s of suites) {
    try {
      const result = await s.fn();
      summaries.push(result);
      classifyResults(result.results);
    } catch (err) {
      console.error(`\n  SUITE CRASH: ${s.name} — ${err.message}\n`);
      summaries.push({ suite: s.name, passed: 0, failed: 1, total: 1, ms: 0, results: [] });
    }
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────

  const totalPassed = summaries.reduce((s, r) => s + r.passed, 0);
  const totalFailed = summaries.reduce((s, r) => s + r.failed, 0);
  const totalMs     = summaries.reduce((s, r) => s + r.ms, 0);

  console.log("\n" + "═".repeat(60));
  console.log("  AGGREGATE RESULTS");
  console.log("═".repeat(60));
  for (const s of summaries) {
    const status = s.failed === 0 ? "PASS" : "FAIL";
    console.log(`  ${status}  ${s.suite.padEnd(25)} ${s.passed}/${s.total}  (${s.ms}ms)`);
  }
  console.log(`\n  TOTAL: ${totalPassed}/${totalPassed + totalFailed} passed (${totalMs}ms)`);

  // ─── Constitution Goal Scorecard ───────────────────────────────────────────

  console.log("\n" + "═".repeat(60));
  console.log("  CONSTITUTION GOAL SCORECARD");
  console.log("═".repeat(60));

  let goalsPassed = 0;
  let goalsTotal = 0;

  for (const [key, goal] of Object.entries(GOALS)) {
    goalsTotal++;
    const tests = goal.tests;
    if (tests.length === 0) {
      console.log(`  ○  ${goal.label.padEnd(45)} NO COVERAGE`);
      continue;
    }
    const passed = tests.filter(t => t.pass).length;
    const all    = tests.length;
    const ok     = passed === all;
    if (ok) goalsPassed++;
    const icon   = ok ? "●" : "◐";
    console.log(`  ${icon}  ${goal.label.padEnd(45)} ${passed}/${all}`);
  }

  const pct = ((goalsPassed / goalsTotal) * 100).toFixed(0);
  console.log(`\n  SCORE: ${goalsPassed}/${goalsTotal} goals fully passing (${pct}%)`);

  // ─── Exit code ─────────────────────────────────────────────────────────────

  console.log("\n" + "█".repeat(60));
  if (totalFailed > 0) {
    console.log(`  ${totalFailed} FAILURES — see above for details`);
    console.log("█".repeat(60) + "\n");
    await lib.shutdown();
    process.exit(1);
  } else {
    console.log("  ALL BENCHMARKS PASSED");
    console.log("█".repeat(60) + "\n");
    await lib.shutdown();
  }
})();
