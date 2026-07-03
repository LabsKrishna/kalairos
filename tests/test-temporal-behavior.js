// test-temporal-behavior.js — Behavioral tests for time-aware memory.
//
// These are end-to-end "does the agent remember change correctly?" tests, framed
// the way a user would describe them rather than as unit checks:
//
//   1. Time-based change   — feed an old value then a new value, get the latest.
//   2. Contradiction       — two conflicting facts over time stay inspectable.
//   3. Forgetting          — outdated info stops surfacing unprompted, but the
//                            past belief is still reconstructable (bitemporal).
//   4. Multi-step temporal — connect a fact from one period to state in another.
//
// Run: node test-temporal-behavior.js
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Mock embedder ────────────────────────────────────────────────────────────
// Bag-of-words over the alphabetic tokens only (digits/symbols are invisible to
// the embedder, exactly like test-versioning.js). This means a price like "$150"
// → "$200" leaves the vector untouched, so it is reliably treated as a *version
// update* of the same entity while the delta engine still sees the numeric flip.
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

// Convenience: the top-scoring result for a given entity id (or the overall top).
function topFor(res, id) {
  return id != null ? res.results.find(r => r.id === id) : res.results[0];
}

(async () => {
  console.log("\n── 1. time-based change: latest value wins ──────────────────────");

  await lib.init(INIT_OPTS);

  await test("old then new Apple price → query returns the new price", async () => {
    // Same templated sentence so the two ingests are one entity, two versions.
    const oldId = await lib.ingest("the current apple stock price is $150 per share");
    const newId = await lib.ingest("the current apple stock price is $200 per share");
    assert.strictEqual(oldId, newId, "both prices must be versions of one entity");

    const res = await lib.query("apple stock price");
    const r   = topFor(res, oldId);
    assert.ok(r, "the apple-price entity must be retrievable");
    assert.ok(r.text.includes("$200"), `expected the latest price, got: ${r.text}`);
    assert.ok(!r.text.includes("$150"), "must not surface the stale price as current");
  });

  await test("the stale value still lives in history (it is superseded, not lost)", async () => {
    await lib.init(INIT_OPTS);
    const oldId = await lib.ingest("the current apple stock price is $150 per share");
    await lib.ingest("the current apple stock price is $200 per share");
    const h = await lib.getHistory(oldId);
    assert.strictEqual(h.versionCount, 2, "expected exactly two versions");
    assert.strictEqual(h.current, "the current apple stock price is $200 per share");
    assert.ok(h.versions[0].text.includes("$150"), "v1 must preserve the old price");
  });

  await test("queryAt before the update still returns the old belief", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the current apple stock price is $150 per share");
    await sleep(5);
    const beforeUpdate = Date.now();
    await sleep(5);
    await lib.ingest("the current apple stock price is $200 per share");

    const asThen = await lib.queryAt("apple stock price", beforeUpdate);
    const rThen  = topFor(asThen, id);
    assert.ok(rThen, "entity must exist as of the earlier timestamp");
    assert.ok(rThen.text.includes("$150"), `as-of past must read $150, got: ${rThen.text}`);

    const asNow = await lib.query("apple stock price");
    assert.ok(topFor(asNow, id).text.includes("$200"), "current must read $200");
  });

  console.log("\n── 2. contradiction: conflicting facts over time ────────────────");

  await lib.init(INIT_OPTS);

  await test("a later negation flip is recorded as a contradiction", async () => {
    // Identical wording except the inserted "not" — keeps it one entity (a
    // version), so the polarity reversal registers as a contradiction rather
    // than splitting off into an unrelated memory.
    const id = await lib.ingest("the production database does fully support atomic transactions reliably");
    await lib.ingest("the production database does not fully support atomic transactions reliably");

    const { contradictions, total } = await lib.getContradictions(id);
    assert.ok(total >= 1, `expected at least one contradiction, got ${total}`);
    const flip = contradictions[contradictions.length - 1];
    assert.strictEqual(flip.delta.contradicts, true);
    assert.strictEqual(flip.delta.contradictionSeverity, 1.0,
      "a polarity reversal is a full-severity contradiction");
  });

  await test("both sides of the conflict remain inspectable as one entity's history", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the api rate limit is set to $100 requests per minute");
    await sleep(5);
    const between = Date.now();
    await sleep(5);
    await lib.ingest("the api rate limit is set to $500 requests per minute");

    // What it "knows" now vs. what it believed before — both are answerable.
    const now    = topFor(await lib.query("api rate limit"), id);
    const before = topFor(await lib.queryAt("api rate limit", between), id);
    assert.ok(now.text.includes("$500"),  "current knowledge is the latest assertion");
    assert.ok(before.text.includes("$100"), "the prior conflicting assertion is still queryable");

    const h = await lib.getHistory(id);
    assert.strictEqual(h.versionCount, 2, "the conflict is two versions of one fact");
    assert.ok(h.versions[1].delta.contradicts, "the numeric flip is flagged as contradicting");
  });

  await test("a contested numeric flip leaves an audit-trail breadcrumb", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the server timeout is configured to $30 seconds");
    await lib.ingest("the server timeout is configured to $90 seconds");
    const events = await lib.trail({ entity: id });
    assert.ok(events.some(e => e.action === "contested"),
      "a >=0.7 severity flip must emit a 'contested' trail event");
  });

  console.log("\n── 3. forgetting: outdated info stops surfacing unprompted ───────");

  await lib.init(INIT_OPTS);

  await test("a fact retrieves normally before it is forgotten", async () => {
    const id = await lib.ingest("the office wifi password is currently sunflower meadow valley");
    const res = await lib.query("office wifi password");
    assert.ok(topFor(res, id), "the live fact must surface in a normal query");
  });

  await test("after forget() the stale fact no longer surfaces in a current query", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the office wifi password is currently sunflower meadow valley");
    await lib.forget(id, { reason: "password rotated last month — no longer valid" });

    const res = await lib.query("office wifi password");
    assert.ok(!topFor(res, id), "a forgotten fact must not be brought up unprompted");
    assert.strictEqual(res.count, 0, "no live entity should match after forgetting");
  });

  await test("forgetting is not deletion — history and past belief survive", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the office wifi password is currently sunflower meadow valley");
    await sleep(5);
    const whileValid = Date.now();
    await sleep(5);
    await lib.forget(id, { reason: "password rotated — no longer valid" });

    // The fact is still in the ledger (auditable via the explicit history API) ...
    const h = await lib.getHistory(id);
    assert.ok(h.deletedAt, "forget() must record a deletedAt, not erase the entity");
    assert.ok(h.versions[0].text.includes("sunflower"), "the original text is retained for audit");

    // ... but it is gone from *retrieval* in every mode, including time-travel:
    // a forgotten memory is never surfaced to the agent, even when asking about
    // a window in which it was still valid.
    const asThen = await lib.queryAt("office wifi password", whileValid);
    assert.ok(!topFor(asThen, id),
      "a forgotten fact must not resurface via time-travel query either");
  });

  console.log("\n── 4. multi-step temporal: connect facts across periods ─────────");

  await test("answer 'what was alice's role when Apollo launched?' across time", async () => {
    await lib.init(INIT_OPTS);

    // t0: alice starts as a junior engineer.
    const aliceId = await lib.ingest(
      "alice current role at the company is junior engineer on the platform team");

    await sleep(5);
    const launchTime = Date.now();           // <- the period we will reason back to
    // A separate, dated event in the same period.
    await lib.ingest("the apollo project officially launched into production today");

    await sleep(5);
    // Later periods: alice is promoted twice. Single-word swaps keep this one entity.
    await lib.ingest("alice current role at the company is senior engineer on the platform team");
    await sleep(5);
    await lib.ingest("alice current role at the company is staff engineer on the platform team");

    // Step 1: today, alice is a staff engineer.
    const nowRole = topFor(await lib.query("alice role"), aliceId);
    assert.ok(nowRole.text.includes("staff"), `current role should be staff, got: ${nowRole.text}`);

    // Step 2: connect the launch period to alice's role *as of that period*.
    const roleAtLaunch = topFor(await lib.queryAt("alice role", launchTime), aliceId);
    assert.ok(roleAtLaunch, "alice's role must be reconstructable at launch time");
    assert.ok(roleAtLaunch.text.includes("junior"),
      `at Apollo launch alice was a junior engineer, got: ${roleAtLaunch.text}`);
    assert.ok(!roleAtLaunch.text.includes("staff"),
      "must not leak the present-day role into the past period");
  });

  await test("the full role timeline is recoverable as an ordered chain", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("alice current role at the company is junior engineer on the platform team");
    await sleep(5);
    const t0 = Date.now();   // after she joins, before either promotion
    await sleep(5);
    await lib.ingest("alice current role at the company is senior engineer on the platform team");
    await lib.ingest("alice current role at the company is staff engineer on the platform team");

    // getHistory gives every step in order; this is the substrate the agent
    // reasons over to connect periods.
    const h = await lib.getHistory(id);
    assert.strictEqual(h.versionCount, 3, "three periods → three versions");
    assert.ok(h.versions[0].text.includes("junior"), "oldest version is the junior role");
    assert.ok(h.versions[2].text.includes("staff"),  "newest version is the staff role");

    // getChangeSince reconstructs the same evolution as a change feed.
    const changed = await lib.getChangeSince(t0);
    const entry   = changed.changes.find(c => c.id === id);
    assert.ok(entry, "the evolving role must appear in the change feed");
    assert.strictEqual(entry.changeCount, 2, "two promotions since t0 (v2 and v3)");
  });

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const total = passed + failed;
  console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
  console.log(`${"─".repeat(60)}\n`);

  await lib.shutdown?.();
  process.exit(failed ? 1 : 0);
})();
