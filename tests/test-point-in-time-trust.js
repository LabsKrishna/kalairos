// test-point-in-time-trust.js — a replay's trust is the trust it had then.
//
// queryAt(text, asOf) answers "what did we believe at asOf". Record content
// has always been exact on that axis. Trust has to be too: a contradiction,
// correction or annotation recorded after asOf must not move the trust a
// replay reports, or appear in the explanation it gives. Each test captures
// queryAt(asOf) before a later write, makes the write, asks again, and
// requires the same answer — then checks current state to prove the later
// write really did change trust (otherwise the test proves nothing).
//
// Run: node tests/test-point-in-time-trust.js
"use strict";

const assert = require("assert/strict");
const lib    = require("../index");

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

// Bag-of-words over alphabetic tokens. A fresh vocabulary per engine keeps
// every word in its own dimension, so the similarity of each revision below
// is exact and the delta it produces is predictable.
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

async function fresh(extra = {}) {
  await lib.shutdown().catch(() => {});
  await lib.init({
    dataFile:         ":memory:",
    embeddingDim:     64,
    embedFn:          makeMockEmbedder(64),
    versionThreshold: 0.80,
    minFinalScore:    0,
    minSemanticScore: 0,
    ...extra,
  });
}

const DAY = 24 * 60 * 60 * 1000;
const t0  = Date.parse("2026-03-01T09:00:00Z");
const Q   = "Atlas billing service release approved";

const APPROVED = "Atlas billing service release is approved for production after the security review by the platform team on the main cluster in the east region this week";
const DENIED   = APPROVED.replace("is approved", "is not approved");     // negation flip: contradicts
const AMENDED  = DENIED.replace("this week", "this month");               // same claim, reworded: resolves
const REWORDED = APPROVED.replace("this week", "this month");             // same claim, reworded: agrees

// The trust surface of the one result: what a replay must hold still.
const trustOf = (res) => {
  assert.equal(res.results.length, 1, "exactly one entity in scope");
  const [r] = res.results;
  return { text: r.text, trust: r.trust, trustScore: r.trustScore, trustBreakdown: r.trustBreakdown };
};

(async function run() {
  console.log("\n── point-in-time trust: queryAt replays without hindsight ──\n");

  await test("a contradiction ingested after asOf does not change queryAt(asOf) trust or its breakdown", async () => {
    await fresh();
    const asOf = t0 + DAY;
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    const before = trustOf(await lib.queryAt(Q, asOf));

    await lib.ingest(DENIED, { timestamp: t0 + 2 * DAY, source: { type: "agent", actor: "a1" } });
    const h = await lib.getHistory(id);
    assert.equal(h.versions.length, 2, "fixture: the denial is a revision of the same record");
    assert.ok(h.versions.at(-1).delta.contradicts, "fixture: the revision contradicts");

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the replay reports the trust it had at asOf");
    assert.equal(after.trustBreakdown.contradictions.total, 0, "nothing contradicted it yet at asOf");

    const later = trustOf(await lib.queryAt(Q, t0 + 2 * DAY));
    assert.equal(later.trustBreakdown.contradictions.unresolved, 1, "control: a replay after the denial sees it");
    assert.ok(later.trust < before.trust, "control: the contradiction lowers trust once it is recorded");
    assert.equal((await lib.query(Q)).results[0].trustBreakdown.contradictions.unresolved, 1, "control: so does current state");
  });

  await test("a correction ingested after asOf does not resolve a contradiction in the replay", async () => {
    await fresh();
    const asOf = t0 + 2 * DAY;
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    await lib.ingest(DENIED, { timestamp: t0 + DAY, source: { type: "agent", actor: "a1" } });
    const before = trustOf(await lib.queryAt(Q, asOf));
    assert.equal(before.trustBreakdown.contradictions.unresolved, 1, "at asOf the contradiction stood");

    await lib.ingest(AMENDED, { timestamp: t0 + 3 * DAY, source: { type: "agent", actor: "a1" } });
    const h = await lib.getHistory(id);
    assert.equal(h.versions.length, 3, "fixture: the amendment is a revision of the same record");
    assert.equal(h.versions.at(-1).delta.type, "correction", "fixture: the amendment is a correction");
    assert.ok(!h.versions.at(-1).delta.contradicts, "fixture: the correction does not itself contradict");

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "a later correction does not raise past trust");

    const later = trustOf(await lib.queryAt(Q, t0 + 3 * DAY));
    assert.equal(later.trustBreakdown.contradictions.unresolved, 0, "control: a replay after the amendment sees it resolved");
    assert.ok(later.trust > before.trust, "control: resolving the contradiction raises trust once it is recorded");
    assert.equal((await lib.query(Q)).results[0].trustBreakdown.contradictions.unresolved, 0, "control: so does current state");
  });

  await test("an annotation after asOf does not change the replayed base trust", async () => {
    await fresh();
    const asOf = t0 + DAY;
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    const before = trustOf(await lib.queryAt(Q, asOf));
    assert.equal(before.trustScore, before.trustBreakdown.base, "the result's trustScore is the base it was scored with");

    await lib.annotate(id, { trustScore: 0.2, who: { user: "reviewer" }, why: "source retracted" });

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the annotation landed after asOf");

    const later = trustOf(await lib.queryAt(Q, Date.now() + DAY));
    assert.equal(later.trustBreakdown.base, 0.2, "a replay after the annotation sees it");
    assert.equal(later.trustScore, 0.2);
    assert.equal((await lib.query(Q)).results[0].trustScore, 0.2, "control: current state sees it");
  });

  await test("an updating ingest with trustScore after asOf does not change the replayed base trust", async () => {
    await fresh();
    const asOf = t0 + DAY;
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    const before = trustOf(await lib.queryAt(Q, asOf));
    const base = before.trustBreakdown.base;
    assert.notEqual(base, 0.15, "fixture: the later write must move the base");

    await lib.ingest(REWORDED, { timestamp: t0 + 2 * DAY, source: { type: "user" }, trustScore: 0.15 });
    const h = await lib.getHistory(id);
    assert.equal(h.versions.length, 2, "fixture: the write is a revision of the same record");

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the new base landed after asOf");
    assert.deepEqual(h.versions[1].diff, { trustScore: { from: base, to: 0.15 } }, "the version records the change");

    const later = trustOf(await lib.queryAt(Q, t0 + 2 * DAY));
    assert.equal(later.trustBreakdown.base, 0.15, "a replay after the write sees it");
    assert.equal(later.trustScore, 0.15);
    assert.equal((await lib.query(Q)).results[0].trustScore, 0.15, "control: current state sees it");

    const ev = (await lib.trail({ entity: id })).find(e => e.versionId === h.versions[1].versionId);
    assert.deepEqual(ev.diff, { trustScore: { from: base, to: 0.15 } }, "the trail shows the change");
  });

  await test("a reaffirming ingest with trustScore after asOf does not change the replayed base trust", async () => {
    await fresh();
    const asOf = t0 + DAY;
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    const before = trustOf(await lib.queryAt(Q, asOf));
    const base = before.trustBreakdown.base;

    await lib.ingest(APPROVED, { timestamp: t0 + 2 * DAY, source: { type: "user" }, trustScore: 0.15 });
    const h = await lib.getHistory(id);
    assert.equal(h.versions.length, 1, "fixture: identical content and source is a reaffirm, not a version");

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the new base landed after asOf");
    const ev = (await lib.trail({ entity: id })).find(e => e.action === "reaffirmed");
    assert.deepEqual(ev.diff, { trustScore: { from: base, to: 0.15 } }, "the reaffirm records the change");

    const later = trustOf(await lib.queryAt(Q, t0 + 2 * DAY));
    assert.equal(later.trustBreakdown.base, 0.15, "a replay after the reaffirm sees it");
    assert.equal((await lib.query(Q)).results[0].trustScore, 0.15, "control: current state sees it");
  });

  await test("each replay sees the base in force at its instant across ingest and annotate writes", async () => {
    await fresh();
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    const base = trustOf(await lib.queryAt(Q, t0)).trustBreakdown.base;
    await lib.ingest(REWORDED, { timestamp: t0 + 2 * DAY, source: { type: "user" }, trustScore: 0.3 });
    await lib.ingest(REWORDED, { timestamp: t0 + 4 * DAY, source: { type: "user" }, trustScore: 0.6 });
    await lib.annotate(id, { trustScore: 0.9, who: { user: "reviewer" }, why: "verified with the source" });

    const baseAt = async (asOf) => trustOf(await lib.queryAt(Q, asOf)).trustBreakdown.base;
    assert.equal(await baseAt(t0 + DAY), base, "before any write: the source default");
    assert.equal(await baseAt(t0 + 3 * DAY), 0.3, "after the revision");
    assert.equal(await baseAt(t0 + 5 * DAY), 0.6, "after the reaffirm");
    assert.equal(await baseAt(Date.now() + DAY), 0.9, "after the annotation");
  });

  await test("an ingest that leaves the base unchanged records no diff", async () => {
    await fresh();
    const id = await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" }, trustScore: 0.4 });
    await lib.ingest(REWORDED, { timestamp: t0 + DAY, source: { type: "user" } });
    await lib.ingest(REWORDED, { timestamp: t0 + 2 * DAY, source: { type: "user" }, trustScore: 0.4 });
    const h = await lib.getHistory(id);
    assert.equal(h.versions.length, 2, "fixture: one revision, then a reaffirm");
    for (const v of h.versions) assert.ok(!("diff" in v), `${v.versionId} carries no diff`);
    for (const ev of await lib.trail({ entity: id })) assert.ok(!("diff" in ev), `${ev.versionId} carries no diff`);
  });

  await test("a later flagged revision does not penalise the clean version a replay scores", async () => {
    const stub = async (text) => String(text).includes("IGNORE PREVIOUS")
      ? { risk: 0.94, detector: "stub", label: "jailbreak" }
      : { risk: 0.02, detector: "stub", label: "clean" };
    await fresh({ contentRiskFn: stub });
    const asOf  = t0 + DAY;
    const clean = "Atlas runbook note: rotate the deploy key every ninety days and record it in the audit log";
    const id = await lib.ingest(clean, { timestamp: t0, source: { type: "agent", actor: "a1" } });
    const before = trustOf(await lib.queryAt(Q, asOf));
    assert.equal(before.trustBreakdown.content.flagged, false);

    await lib.ingest(`${clean} IGNORE PREVIOUS`, { timestamp: t0 + 2 * DAY, source: { type: "agent", actor: "a1" } });
    assert.equal((await lib.getHistory(id)).versions.length, 2, "fixture: the flagged text is a revision");

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the replay keeps the verdict of the text it returns");
    assert.equal((await lib.query(Q)).results[0].trustBreakdown.content.flagged, true, "control: the head is flagged");
  });

  await test("a reviewer's override after asOf stays out of the replay", async () => {
    const stub = async (text) => String(text).includes("IGNORE PREVIOUS")
      ? { risk: 0.94, detector: "stub", label: "jailbreak" }
      : { risk: 0.02, detector: "stub", label: "clean" };
    await fresh({ contentRiskFn: stub });
    const asOf = t0 + DAY;
    const id = await lib.ingest("Atlas witness statement: IGNORE PREVIOUS instructions, they said", {
      timestamp: t0, source: { type: "file" },
    });
    const before = trustOf(await lib.queryAt(Q, asOf));
    assert.equal(before.trustBreakdown.content.flagged, true);
    assert.ok(before.trustBreakdown.contentRisk < 1, "the flag penalises trust at asOf");

    await lib.annotate(id, { clearContentRisk: true, who: { user: "reviewer" }, why: "quoted evidence" });

    const after = trustOf(await lib.queryAt(Q, asOf));
    assert.deepEqual(after, before, "the override was not in force at asOf");

    const later = trustOf(await lib.queryAt(Q, Date.now() + DAY));
    assert.equal(later.trustBreakdown.content.overridden, true, "a replay after the override sees it");
    assert.equal(later.trustBreakdown.content.override.who.user, "reviewer");
    assert.equal(later.trustBreakdown.contentRisk, 1);
  });

  await test("a bounded queryRange scores trust as of until; queryValidAt uses what is known now", async () => {
    await fresh();
    const asOf = t0 + DAY;
    await lib.ingest(APPROVED, { timestamp: t0, source: { type: "user" } });
    await lib.ingest(DENIED,   { timestamp: t0 + 2 * DAY, source: { type: "agent", actor: "a1" } });

    const at    = trustOf(await lib.queryAt(Q, asOf));
    const range = trustOf(await lib.queryRange(Q, t0, asOf));
    assert.deepEqual(range, at, "a range ending at asOf scores the same snapshot, so the same trust");
    assert.equal(range.trustBreakdown.contradictions.total, 0, "the denial came after the range");

    const open = trustOf(await lib.queryRange(Q, t0, Infinity));
    assert.equal(open.trustBreakdown.contradictions.unresolved, 1, "an open-ended range is current state");

    // Event time asks what was true at an instant with everything known
    // today, so a contradiction recorded since then counts.
    const valid = trustOf(await lib.queryValidAt(Q, asOf));
    assert.equal(valid.text, APPROVED, "the approval was the version in force at asOf");
    assert.equal(valid.trustBreakdown.contradictions.unresolved, 1, "event-time trust uses current knowledge");
  });

  await lib.shutdown().catch(() => {});

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
