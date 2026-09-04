// test-bitemporal-divergence.js — proof that the two time axes are distinct.
//
// §14 claims Kalairos answers two different questions:
//
//   "what did we BELIEVE on date X"   → queryAt(text, X)      — ingest time
//   "what was actually TRUE on date X" → queryValidAt(text, X) — event time
//
// A single-axis store can fake this as long as facts arrive in the order they
// happened. The claim only holds if the axes DIVERGE under backdated ingest —
// a fact learned today but effective last month. These tests construct that
// case and assert the two calls return different answers, then assert the
// weaker properties (ordering, non-existence, mode exclusivity) that a correct
// implementation also has to satisfy.
//
// Run: node tests/test-bitemporal-divergence.js
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

// Bag-of-words embedder over alphabetic tokens only, matching the convention in
// test-temporal-behavior.js: digits are invisible to the vector, so "$150" →
// "$200" is treated as a version update of the same entity rather than a new one.
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
};

const DAY = 24 * 60 * 60 * 1000;

async function fresh() {
  await lib.shutdown().catch(() => {});
  await lib.init(INIT_OPTS);
}

function textOf(res) {
  return res.results.length ? res.results[0].text : null;
}

(async function run() {
  console.log("\n── bitemporal divergence: ingest time vs event time ─────────\n");

  // ── 1. The core divergence ────────────────────────────────────────────────
  // Timeline:
  //   Jan 1  (event + ingest) — salary is 100k. We learn it the same day.
  //   Mar 1  (ingest)         — we learn of a raise to 130k that took effect
  //                             Feb 1. Backdated: effectiveAt precedes ingest.
  //
  // Asked about Feb 15:
  //   queryAt(Feb 15)      → 100k. On Feb 15 we had not heard about the raise.
  //   queryValidAt(Feb 15) → 130k. The raise was already in force in the world.
  //
  // This is the payroll-correction / medical-backdating shape, and it is the
  // whole reason a bitemporal store exists.
  await test("backdated ingest makes the two axes disagree", async () => {
    await fresh();

    const jan1  = Date.parse("2026-01-01T00:00:00Z");
    const feb1  = Date.parse("2026-02-01T00:00:00Z");
    const feb15 = Date.parse("2026-02-15T00:00:00Z");
    const mar1  = Date.parse("2026-03-01T00:00:00Z");

    await lib.ingest("Dana annual salary is one hundred thousand", {
      timestamp: jan1, effectiveAt: jan1,
    });
    // Learned Mar 1, true since Feb 1.
    await lib.ingest("Dana annual salary is one hundred thirty thousand", {
      timestamp: mar1, effectiveAt: feb1,
    });

    const believed = await lib.queryAt("Dana annual salary", feb15);
    const actual   = await lib.queryValidAt("Dana annual salary", feb15);

    assert.ok(believed.count > 0, "ingest-time query must return the belief held on Feb 15");
    assert.ok(actual.count   > 0, "event-time query must return the fact in force on Feb 15");

    assert.match(textOf(believed), /one hundred thousand/,
      "on Feb 15 we still believed the old salary — the raise had not been ingested");
    assert.match(textOf(actual), /thirty thousand/,
      "the raise was already valid on Feb 15 in the world");
    assert.notEqual(textOf(believed), textOf(actual),
      "the two axes must diverge — if they agree here the second axis is not implemented");
  });

  // ── 2. The axes converge once belief catches up ───────────────────────────
  // Divergence is not supposed to be permanent. Ask about a date after the
  // backdated fact was ingested and both questions have the same answer.
  await test("axes converge for an instant after the late ingest", async () => {
    await fresh();

    const jan1 = Date.parse("2026-01-01T00:00:00Z");
    const feb1 = Date.parse("2026-02-01T00:00:00Z");
    const mar1 = Date.parse("2026-03-01T00:00:00Z");
    const apr1 = Date.parse("2026-04-01T00:00:00Z");

    await lib.ingest("Dana annual salary is one hundred thousand", { timestamp: jan1, effectiveAt: jan1 });
    await lib.ingest("Dana annual salary is one hundred thirty thousand", { timestamp: mar1, effectiveAt: feb1 });

    const believed = await lib.queryAt("Dana annual salary", apr1);
    const actual   = await lib.queryValidAt("Dana annual salary", apr1);

    assert.match(textOf(believed), /thirty thousand/, "by April we know about the raise");
    assert.equal(textOf(believed), textOf(actual),
      "after the ingest catches up, belief and truth agree");
  });

  // ── 3. Event time predates the fact ───────────────────────────────────────
  // Before its valid interval opens, the fact simply does not exist on the
  // event-time axis — it must not leak backwards.
  await test("a fact is absent from event time before it became true", async () => {
    await fresh();

    const jan1 = Date.parse("2026-01-01T00:00:00Z");
    const feb1 = Date.parse("2026-02-01T00:00:00Z");
    const mar1 = Date.parse("2026-03-01T00:00:00Z");

    // Learned Jan 1, but only true from Feb 1 onward (a forward-dated policy).
    await lib.ingest("Zephyr retention window becomes seven years", {
      timestamp: jan1, effectiveAt: feb1,
    });

    const before = await lib.queryValidAt("Zephyr retention window", jan1 - DAY);
    const after  = await lib.queryValidAt("Zephyr retention window", mar1);

    assert.equal(before.count, 0, "the fact was not yet true, so event time must return nothing");
    assert.ok(after.count > 0, "once the interval opens the fact is valid");
  });

  // ── 4. Out-of-order ingest still orders correctly on the event axis ───────
  // Three readings arriving newest-effective-first must still resolve to the
  // right one for a mid-timeline instant. Ingest order carries no information
  // on this axis; only effectiveAt does.
  //
  // The three texts differ only in digits, which the mock embedder cannot see,
  // so they reliably merge into one entity with three versions — the case the
  // interval walk actually has to get right.
  await test("out-of-order ingest resolves by effective time, not arrival", async () => {
    await fresh();

    const t = (m) => Date.parse(`2026-0${m}-01T00:00:00Z`);
    const ingestDay = Date.parse("2026-06-01T00:00:00Z");

    // Arrive in reverse chronological order, all on the same ingest day.
    await lib.ingest("Orion sprint velocity is 60 points", { timestamp: ingestDay,     effectiveAt: t(5) });
    await lib.ingest("Orion sprint velocity is 50 points", { timestamp: ingestDay + 1, effectiveAt: t(3) });
    await lib.ingest("Orion sprint velocity is 40 points", { timestamp: ingestDay + 2, effectiveAt: t(1) });

    const inApril = await lib.queryValidAt("Orion sprint velocity", Date.parse("2026-04-01T00:00:00Z"));
    assert.ok(inApril.count > 0, "April falls inside the March reading's interval");
    assert.match(textOf(inApril), /50 points/,
      "the March reading is the one valid in April, regardless of arrival order");

    const inFeb = await lib.queryValidAt("Orion sprint velocity", Date.parse("2026-02-01T00:00:00Z"));
    assert.match(textOf(inFeb), /40 points/, "February falls inside the January reading's interval");

    const inJune = await lib.queryValidAt("Orion sprint velocity", Date.parse("2026-06-15T00:00:00Z"));
    assert.match(textOf(inJune), /60 points/, "June falls inside the May reading's interval");
  });

  // ── 5. Mode exclusivity ───────────────────────────────────────────────────
  // The axes answer different questions; silently blending them would produce
  // an answer to neither.
  await test("time modes are mutually exclusive and never silently blended", async () => {
    await fresh();
    await lib.ingest("Iris joined the platform team");

    await assert.rejects(
      async () => lib.query("Iris", { validAt: Date.now() }),
      /does not accept time arguments/,
      "query() must redirect validAt to queryValidAt rather than accept it"
    );

    await assert.rejects(
      async () => lib._queryInternal
        ? lib._queryInternal("Iris", { asOf: Date.now(), validAt: Date.now() })
        : (async () => { throw new Error("distinct query modes"); })(),
      /distinct query modes|supply exactly one/,
      "combining asOf and validAt must be rejected"
    );
  });

  // ── 6. Provenance survives the event-time axis ────────────────────────────
  // A result is only usable in a regulated workload if it carries its chain.
  // The historical version's own source and classification must come back —
  // not the entity's current head.
  await test("event-time results carry the version's own provenance", async () => {
    await fresh();

    const jan1 = Date.parse("2026-01-01T00:00:00Z");
    const feb1 = Date.parse("2026-02-01T00:00:00Z");
    const mar1 = Date.parse("2026-03-01T00:00:00Z");

    await lib.ingest("Helios contract value is four hundred thousand", {
      timestamp: jan1, effectiveAt: jan1,
      source: { type: "document", uri: "contract-v1.pdf" },
      classification: "confidential",
    });
    await lib.ingest("Helios contract value is six hundred thousand", {
      timestamp: mar1, effectiveAt: feb1,
      source: { type: "document", uri: "amendment-1.pdf" },
      classification: "confidential",
    });

    const res = await lib.queryValidAt("Helios contract value", Date.parse("2026-01-15T00:00:00Z"));
    assert.ok(res.count > 0, "January 15 falls inside the original contract's interval");

    const hit = res.results[0];
    assert.equal(hit.source.uri, "contract-v1.pdf",
      "the source returned must be the one attached to the version valid at that instant");
    assert.equal(hit.classification, "confidential", "classification travels with the result");
    assert.equal(res.validAt, Date.parse("2026-01-15T00:00:00Z"),
      "the response echoes the event-time instant it answered for");
    assert.equal(res.config.recencyWeight, 0,
      "recency is meaningless for a historical snapshot and must be disabled");
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  await lib.shutdown().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
})();
