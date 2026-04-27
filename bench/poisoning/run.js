// bench/poisoning/run.js — Memory-poisoning benchmark runner
//
// Claim under test: Kalairos does not magically reject poisoned memory. What it
// DOES guarantee is that poisoned writes leave a durable, queryable trail:
//
//   1. The contradiction is flagged on the affected version (`delta.contradicts`)
//   2. Trust breakdown reduces the poisoned entity's trust score
//   3. Version history preserves the pre-poison truth
//   4. A time-travel query (`asOf: before_poison`) recovers the original
//
// Each fixture ingests ground_truth, then poison, and asserts the four defense
// signals above. Failures mean the engine silently lost the defense we claim in
// CLAUDE.md §15.
//
// Usage: node bench/poisoning/run.js
"use strict";

const fs = require("fs");
const path = require("path");
const kalairos = require("../..");
const { FIXTURES } = require("./fixtures");

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

async function runFixture(fx) {
  await kalairos.init({
    embedFn: makeEmbedder(),
    embeddingDim: DIM,
    dataFile: ":memory:",
    minFinalScore: 0.0,
    minSemanticScore: 0.0,
    // Bag-of-words test embedder produces lower similarity than a neural model.
    // Production versionThreshold is 0.82 for neural embeddings; we relax it to
    // 0.35 so contradicting updates merge into the same entity here too.
    versionThreshold: 0.35,
    // Trust weight must be > 0 for trust to influence ranking.
    trustWeight: 0.4,
  });

  // Capture timestamp between ground_truth and poison for asOf recovery.
  const truthIds = [];
  for (const g of fx.ground_truth) {
    truthIds.push(await kalairos.ingest(g.text, { source: g.source }));
  }
  const truthSnapshot = Date.now();
  // Small delay so asOf < poison timestamps
  await new Promise(r => setTimeout(r, 10));

  const poisonIds = [];
  for (const p of fx.poison) {
    poisonIds.push(await kalairos.ingest(p.text, { source: p.source, trustScore: p.trustScore }));
  }

  // ── Defense signal 1 + 2: contradiction flag + trust breakdown ─────────────
  const touchedIds = Array.from(new Set([...truthIds, ...poisonIds]));
  const entities = [];
  for (const id of touchedIds) {
    const h = await kalairos.getHistory(id);
    if (h) entities.push(h);
  }

  let contradictionFlagged = false;
  let cumulativeSeverity = 0;
  for (const e of entities) {
    for (const v of e.versions || []) {
      if (v?.delta?.contradicts) {
        contradictionFlagged = true;
        cumulativeSeverity += (v.delta.contradictionSeverity || 0);
      }
    }
  }

  // Trust at current time — use query to get computed breakdown
  const { results } = await kalairos.query(fx.query, { limit: 10 });
  // Consider the trust of the entity whose current text matches a poison string
  const poisonTexts = new Set(fx.poison.map(p => p.text));
  const truthTexts  = new Set(fx.ground_truth.map(g => g.text));

  let poisonEntityTrust = null;
  let truthSurvivesInQuery = false;
  let topText = null;
  if (results.length > 0) topText = results[0].text;
  for (const r of results) {
    // `r.trust` is the composite multi-signal trust used for scoring
    // (`r.trustScore` is the stored scalar prior and ignores contradictions).
    const composite = typeof r.trust === "number" ? r.trust : r.trustScore;
    if (poisonTexts.has(r.text)) {
      if (poisonEntityTrust === null) poisonEntityTrust = composite;
      else poisonEntityTrust = Math.min(poisonEntityTrust, composite);
    }
    if (truthTexts.has(r.text)) truthSurvivesInQuery = true;
  }

  // ── Defense signal 3: history preserves truth ──────────────────────────────
  let historyPreservesTruth = false;
  for (const e of entities) {
    const vtexts = (e.versions || []).map(v => v.text);
    if (vtexts.some(t => truthTexts.has(t))) historyPreservesTruth = true;
  }

  // ── Defense signal 4: asOf(before-poison) recovers truth ───────────────────
  let asOfRecoversTruth = false;
  const past = await kalairos.queryAt(fx.query, truthSnapshot, { limit: 10 });
  for (const r of past.results || []) {
    if (truthTexts.has(r.text)) { asOfRecoversTruth = true; break; }
  }

  await kalairos.shutdown();

  // ── Verdict ────────────────────────────────────────────────────────────────
  const checks = {
    contradictionFlagged,
    trustPenaltyApplied: poisonEntityTrust !== null && poisonEntityTrust < 0.9,
    historyPreservesTruth,
    asOfRecoversTruth,
  };
  const failures = [];
  if (!checks.contradictionFlagged)     failures.push("no contradiction flag on any version");
  if (!checks.trustPenaltyApplied)      failures.push(`trust not penalised (poisonEntityTrust=${poisonEntityTrust})`);
  if (!checks.historyPreservesTruth)    failures.push("ground truth not preserved in version history");
  if (!checks.asOfRecoversTruth)        failures.push("queryAt(before-poison) did not return ground truth");

  return {
    fixture: fx.id,
    description: fx.description,
    stats: {
      entities: entities.length,
      contradictionFlagged,
      cumulativeSeverity: +cumulativeSeverity.toFixed(2),
      poisonEntityTrust,
      truthSurvivesInQuery,
      topText,
    },
    checks,
    failures,
    passed: failures.length === 0,
  };
}

(async () => {
  console.log("");
  console.log("═".repeat(72));
  console.log("  KALAIROS — MEMORY POISONING BENCHMARK");
  console.log("═".repeat(72));
  console.log("  Claim under test: poisoned writes are detected, penalised, and");
  console.log("  recoverable — not silently overwritten.");
  console.log("  Attacks: indirect injection · source spoofing · repetition ·");
  console.log("           drip-poison · trust override");
  console.log("");

  const reports = [];
  for (const fx of FIXTURES) {
    const r = await runFixture(fx);
    reports.push(r);
    const status = r.passed ? "DEFENDED" : "COMPROMISED";
    const tag = r.passed ? "✓" : "✗";
    console.log(`  [${status}]  ${tag} ${r.fixture}`);
    const c = r.checks;
    console.log(
      `              contradict=${c.contradictionFlagged ? "yes" : "no "}  ` +
      `trust-penalty=${c.trustPenaltyApplied ? "yes" : "no "}  ` +
      `history=${c.historyPreservesTruth ? "yes" : "no "}  ` +
      `asOf-recovery=${c.asOfRecoversTruth ? "yes" : "no "}`
    );
    if (r.stats.poisonEntityTrust !== null) {
      console.log(`              poison trust = ${r.stats.poisonEntityTrust.toFixed(2)}, severity sum = ${r.stats.cumulativeSeverity}`);
    }
    for (const f of r.failures) console.log(`              ! ${f}`);
  }

  const passed = reports.filter(r => r.passed).length;
  const total  = reports.length;
  console.log("");
  console.log(`  ${passed}/${total} attacks defended`);

  const outPath = path.join(__dirname, "results.json");
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    passed,
    total,
    reports,
  }, null, 2));
  console.log(`  Wrote ${outPath}`);
  console.log("");

  if (passed < total) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
