// bench/prior-auth/run.js — prior-authorization replay benchmark.
//
// Claim under test: when a reviewer's decision is replayed later — by an
// appeal, an auditor, a state regulator — Kalairos answers two different
// questions and neither borrows from hindsight:
//
//   queryAt(decisionAt)      — what the reviewer HAD. Nothing received later.
//   queryValidAt(decisionAt) — what was TRUE. Including records that existed
//                              but arrived late; nothing that became true later.
//
// Plus: the payer policy in force on the request date (not its later
// revision), a frozen determination record, and authorship that still says
// the assistant recommended and a named clinician decided.
//
// Workload: the reference case PA-0001 (see case.js) plus N seeded synthetic
// cases across three payer policies. See README.md for the method.
//
// Usage: node bench/prior-auth/run.js [--cases 300] [--seed 114]
"use strict";

const fs   = require("fs");
const path = require("path");
const F    = require("./fixtures");
const R    = require("./replay");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(4));

(async () => {
  const n    = arg("cases", 300);
  const seed = arg("seed", 114);
  const cases = [F.REFERENCE_CASE, ...F.generateCases(n, seed)];

  console.log("");
  console.log("═".repeat(72));
  console.log("  KALAIROS — PRIOR-AUTHORIZATION REPLAY BENCHMARK");
  console.log("═".repeat(72));
  console.log("  Claim under test: a decision replayed later shows what the reviewer");
  console.log("  had, and separately what was true — with no hindsight in either.");
  console.log(`  Workload: reference case + ${n} synthetic cases (seed ${seed})`);
  console.log("");

  const startedAt = performance.now();
  const { scores, summary, identityMisses } = await R.runReplay(cases);
  const elapsedMs = +(performance.now() - startedAt).toFixed(1);

  if (identityMisses.length) {
    console.log(`  FIXTURE ERROR: ${identityMisses.length} revision(s) did not land on their own record.`);
    for (const m of identityMisses.slice(0, 5)) {
      console.log(`    ${m.workspace} ${m.key}: expected entity ${m.expected}, got ${m.got}`);
    }
    console.log("  Time metrics are meaningless until identity holds. Fix the fixture texts.");
    process.exit(1);
  }

  const checks = R.checkFloors(summary);
  const width = Math.max(...checks.map(c => c.label.length));
  for (const c of checks) {
    const floor = `${c.op} ${c.value}`;
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.label.padEnd(width)}  ${fmt(c.actual).padStart(6)}   floor ${floor}`);
  }
  console.log("");
  console.log("  Coverage:");
  console.log(`    ${summary.coverage.lateRecords} cases with a record that arrived after the decision (${summary.lateEvidenceRecords} records)`);
  console.log(`    ${summary.coverage.revisedAfterDecision} cases with a record revised after the decision (reversal or correction)`);
  console.log(`    ${summary.coverage.policyRevisedByReview} cases whose policy was revised between request and review`);
  console.log(`    ${summary.controlCases} cases with post-decision writes (control set)`);
  console.log("");
  console.log(`  ${cases.length} cases replayed in ${elapsedMs} ms`);

  const failed = checks.filter(c => !c.ok);
  for (const f of failed) {
    const offenders = scores.filter(s => {
      switch (f.metric) {
        case "hindsightLeakage":    return s.leaked.length > 0;
        case "decisionTimeRecall":  return s.knownFound < s.knownExpected;
        case "replayDrift":         return s.drift;
        case "trustDrift":          return s.trustDelta > 1e-9;
        case "trustCitesLater":     return s.trustCitesLater;
        case "eventTimeRecall":     return s.truthFound < s.truthExpected;
        case "lateEvidenceRecall":  return s.lateFound < s.lateExpected;
        case "forwardLeakage":      return s.forward.length > 0;
        case "criteriaInForce":     return !s.criteriaOk;
        case "frozenRecord":        return !s.frozenOk;
        case "authorshipPreserved": return !s.authorshipOk;
        case "controlDetection":    return s.hasLaterWrites && !s.naiveLeaked;
        default:                    return false;
      }
    });
    console.log(`  ! ${f.label}: ${offenders.length} case(s), e.g. ${offenders.slice(0, 3).map(s => s.id).join(", ")}`);
  }

  const outPath = path.join(__dirname, "results.json");
  fs.writeFileSync(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    cases: cases.length,
    seed,
    elapsedMs,
    summary,
    floors: checks.map(({ metric, op, value, actual, ok }) => ({ metric, op, value, actual, ok })),
    reference: scores[0],
  }, null, 2) + "\n");
  console.log(`  Wrote ${outPath}`);
  console.log("");

  if (failed.length) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
