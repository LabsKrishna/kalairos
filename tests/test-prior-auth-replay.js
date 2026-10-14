// test-prior-auth-replay.js — the prior-auth replay benchmark can see failures.
//
// bench/prior-auth/ publishes exact floors (zero hindsight leakage, full
// late-evidence recall, …). A floor is only worth publishing if the metric
// behind it moves when the engine is wrong. These tests run the reference
// case for real, confirm it scores clean, then inject each kind of failure
// into the observations and assert the scorer catches it — the same
// sensitivity discipline as the observability benchmark (BENCH.md).
//
// Run: node tests/test-prior-auth-replay.js
"use strict";

const assert = require("assert/strict");
const lib    = require("../index");
const F      = require("../bench/prior-auth/fixtures");
const R      = require("../bench/prior-auth/replay");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

const C = F.REFERENCE_CASE;
const D = C.decisionAt;
const textOf = (pattern) => C.writes.find(w => pattern.test(w.text)).text;
const clone  = (o) => JSON.parse(JSON.stringify(o));

(async function run() {
  console.log("\n── prior-auth replay benchmark: the metrics can see failures ──\n");

  const unmute = R.muteEngineLog();
  let live, obs, entityIds;
  try {
    await R.initEngine();
    const loaded = await R.load([C]);
    entityIds = loaded.entityIds;
    live = loaded.live.get(C.id);
    obs  = await R.observe(C);
    assert.equal(loaded.identityMisses.length, 0, "every revision must land on its own record");
  } finally {
    await lib.shutdown().catch(() => {});
    unmute();
  }

  const score = (o = obs, l = live) => R.scoreCase(C, l, o, entityIds);

  await test("the reference case scores clean on every gated metric", async () => {
    const s = score();
    assert.deepEqual(s.leaked, [], "nothing received after the decision is in the replay");
    assert.equal(s.knownFound, s.knownExpected, "everything the reviewer had is in the replay");
    assert.equal(s.drift, false, "the replay matches the decision-day answer");
    assert.equal(s.lateExpected, 1, "the MRI is the one record true but not yet received");
    assert.equal(s.lateFound, 1, "event time surfaces the late MRI");
    assert.deepEqual(s.forward, [], "nothing that became true later is in the event-time answer");
    assert.ok(s.criteriaOk, "the policy in force on the request date comes back");
    assert.ok(s.frozenOk, "the frozen record holds exactly the decision-day writes");
    assert.ok(s.authorshipOk, "assistant and clinician authorship survive the replay");
    assert.ok(s.naiveLeaked, "current-state query shows post-decision records (the control)");
    const failing = R.checkFloors(R.summarize([s])).filter(f => !f.ok).map(f => f.metric);
    assert.deepEqual(failing, [], "every published floor holds on the reference case");
  });

  await test("a record received after the decision counts as leakage", async () => {
    const o = clone(obs);
    o.replayKnown.push({ id: 999, text: textOf(/MRI report/), trust: 1, source: { type: "file" }, contradictionTimes: [] });
    assert.equal(score(o).leaked.length, 1);
  });

  await test("a later version of a known record counts as leakage", async () => {
    const o = clone(obs);
    const det = o.replayKnown.find(r => /denied/.test(r.text));
    det.text = textOf(/reconsideration/);
    const s = score(o);
    assert.equal(s.leaked.length, 1, "the reversal was not available on the decision day");
    assert.equal(s.drift, true, "and the replay no longer matches the decision-day answer");
    assert.ok(s.knownFound < s.knownExpected, "and the denial the reviewer issued is missing");
  });

  await test("a replay that drops a record fails recall and drift", async () => {
    const o = clone(obs);
    o.replayKnown = o.replayKnown.filter(r => !/physical therapy/.test(r.text));
    const s = score(o);
    assert.ok(s.knownFound < s.knownExpected);
    assert.equal(s.drift, true);
  });

  await test("a missing late record fails late-evidence recall", async () => {
    const o = clone(obs);
    o.replayTrue = o.replayTrue.filter(r => !/MRI report/.test(r.text));
    const s = score(o);
    assert.equal(s.lateFound, 0);
    assert.ok(s.truthFound < s.truthExpected);
  });

  await test("a record that became true after the decision counts as forward leakage", async () => {
    const o = clone(obs);
    o.replayTrue.push({ id: 998, text: textOf(/scheduling/), trust: 1, source: { type: "tool" }, contradictionTimes: [] });
    assert.equal(score(o).forward.length, 1);
  });

  await test("the current policy in place of the request-date policy fails criteria", async () => {
    const o = clone(obs);
    o.criteria[0].text = F.policyWrites().filter(w => w.key === C.policy).at(-1).text;
    assert.equal(score(o).criteriaOk, false);
  });

  await test("a frozen record that gained a later event fails", async () => {
    const o = clone(obs);
    o.frozen.push({ ...o.frozen[0], ingestAt: D + F.DAY });
    assert.equal(score(o).frozenOk, false);
  });

  await test("a determination attributed to the agent fails authorship", async () => {
    const o = clone(obs);
    o.replayKnown.find(r => /determination/.test(r.text)).source = { type: "agent", actor: "um-assistant" };
    assert.equal(score(o).authorshipOk, false);
  });

  await test("a control that shows nothing later fails control detection", async () => {
    const o = clone(obs);
    o.naive = o.replayKnown;
    const s = score(o);
    assert.equal(s.naiveLeaked, false);
    assert.equal(R.summarize([s]).controlDetection, 0);
  });

  await test("a trust explanation citing a later contradiction is reported", async () => {
    const o = clone(obs);
    o.replayKnown.forEach(r => { r.contradictionTimes = []; });
    assert.equal(score(o).trustCitesLater, false);
    o.replayKnown[0].contradictionTimes = [D + F.HOUR];
    assert.equal(score(o).trustCitesLater, true);
  });

  await test("ground truth: a correction replaces what it corrects on the event axis", async () => {
    const original  = { text: "a", ingestAt: 10, effectiveAt: 5 };
    const corrected = { text: "b", ingestAt: 20, effectiveAt: 5 };
    assert.equal(F.trueAt([original, corrected], 15).text, "b", "true at 15: the corrected version");
    assert.equal(F.knownAt([original, corrected], 15).text, "a", "known at 15: only the original");
    assert.equal(F.trueAt([original, corrected], 4), null, "nothing was true before the event");
  });

  await test("the full runner meets every floor on generated cases", async () => {
    const { summary, identityMisses } = await R.runReplay([C, ...F.generateCases(25, 3)]);
    assert.deepEqual(identityMisses, [], "every revision lands on its own record");
    const failing = R.checkFloors(summary).filter(f => !f.ok).map(f => f.metric);
    assert.deepEqual(failing, [], "every published floor holds end to end");
    assert.equal(summary.cases, 26);
  });

  await test("a revision that lands on the wrong record is reported, not scored", async () => {
    // Same key, unrelated text: nothing is similar enough to merge into, so
    // the engine creates a second record. The harness must flag that instead
    // of letting a broken fixture pass as a time-travel result.
    const t = Date.parse("2026-05-01T09:00:00Z");
    const broken = {
      id: "PA-9999", policy: "MP-114", requestAt: t, decisionAt: t + F.DAY, reviewAt: t + 30 * F.DAY,
      writes: [
        { key: "imaging", role: "evidence", text: "Case PA-9999 lumbar MRI report: disc herniation compressing the left nerve root.",
          ingestAt: t, effectiveAt: t - F.DAY, source: { type: "file" }, who: { agent: "intake" } },
        { key: "imaging", role: "evidence", text: "Quarterly parking garage access badge audit completed without findings.",
          ingestAt: t + 2 * F.DAY, effectiveAt: t - F.DAY, source: { type: "file" }, who: { agent: "intake" } },
      ],
    };
    const unmuteLocal = R.muteEngineLog();
    try {
      await R.initEngine();
      const { identityMisses } = await R.load([broken]);
      assert.equal(identityMisses.length, 1, "the forked revision is caught");
      assert.equal(identityMisses[0].key, "imaging");
      assert.notEqual(identityMisses[0].got, identityMisses[0].expected);
    } finally {
      await lib.shutdown().catch(() => {});
      unmuteLocal();
    }
  });

  await test("muting engine chatter lets every other error through", async () => {
    const original = console.error;
    const seen = [];
    console.error = (...args) => seen.push(args.join(" "));
    const unmuteLocal = R.muteEngineLog();
    try {
      console.error("[kalairos] Created entity 1 [text]");
      console.error("something actually went wrong");
    } finally {
      unmuteLocal();
      console.error = original;
    }
    assert.deepEqual(seen, ["something actually went wrong"]);
  });

  await test("the generator is deterministic per seed", async () => {
    const a = F.generateCases(20, 7), b = F.generateCases(20, 7), c = F.generateCases(20, 8);
    assert.deepEqual(a, b, "same seed, same cases");
    assert.notDeepEqual(a, c, "different seed, different cases");
    for (const k of a) {
      const texts = k.writes.map(w => w.text);
      assert.equal(new Set(texts).size, texts.length, `${k.id}: every write text is unique within its case`);
      assert.ok(k.writes.every(w => w.ingestAt >= w.effectiveAt || w.role === "policy"),
        `${k.id}: nothing is received before it happened`);
    }
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
