// test-embed-cache.js — the embedding cache
//
// Embedding is the one expensive step on both hot paths and it is pure, so the
// cache is easy to justify and easy to get subtly wrong. What is pinned here is
// the set of ways it could silently corrupt recall rather than merely fail to
// help: caching a failed embed, collapsing two types onto one key, or surviving
// an init() that swapped the embedder underneath it.
"use strict";

const assert = require("assert/strict");
const lib    = require("../index");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}`); console.log(`       ${e.message}`); failed++; }
}

const DIM = 16;

/** An embedder that counts its calls, and can be told to fail the next one. */
function counting({ fill = 1 } = {}) {
  const fn = async (text, type) => {
    fn.calls++;
    if (fn.failNext) { fn.failNext = false; throw new Error("embedder unavailable"); }
    const v = new Array(DIM).fill(0);
    v[0] = fill;
    v[1] = String(text).length % 7;
    v[2] = type === "image" ? 1 : 0;
    return v;
  };
  fn.calls = 0;
  fn.failNext = false;
  return fn;
}

const boot = (embedFn, over = {}) => lib.init({
  dataFile: ":memory:", embedFn, embeddingDim: DIM, strictEmbeddings: false, ...over,
});

(async () => {
  console.log("\n── reuse ──────────────────────────────────────────────────────────");

  await test("identical text is embedded once, not twice", async () => {
    const embed = counting();
    await boot(embed);
    await lib.query("where does the deploy runbook live");
    await lib.query("where does the deploy runbook live");
    assert.equal(embed.calls, 1, `embedFn ran ${embed.calls} times`);
  });

  await test("a re-ingest of identical content does not pay for it twice", async () => {
    const embed = counting();
    await boot(embed);
    await lib.ingest("the runbook lives in DEPLOY.md");
    const after = embed.calls;
    await lib.ingest("the runbook lives in DEPLOY.md");
    assert.equal(embed.calls, after, "the idempotent re-ingest re-embedded");
  });

  await test("different text still reaches the embedder", async () => {
    const embed = counting();
    await boot(embed);
    await lib.query("first question");
    await lib.query("second question");
    assert.equal(embed.calls, 2);
  });

  console.log("\n── ways it could return the WRONG vector ──────────────────────────");

  // embedFn receives (text, type) and is allowed to dispatch per type. Keying
  // on text alone would hand an image embedder's vector back for the same
  // string of text.
  await test("the same text under a different type is not a hit", async () => {
    const embed = counting();
    await boot(embed);
    await lib.ingest("a caption", { type: "text" });
    await lib.ingest("a caption", { type: "image" });
    assert.equal(embed.calls, 2, "the type was not part of the key");
  });

  // The key joins type and text with a NUL. Without a separator that cannot
  // appear in either half, one text could impersonate another type's key.
  await test("text cannot forge another type's cache key", async () => {
    const embed = counting();
    await boot(embed);
    await lib.ingest("image a caption", { type: "text" });
    await lib.ingest("a caption", { type: "image" });
    assert.equal(embed.calls, 2, "two distinct keys collided");
  });

  // The nastiest failure available: one transient outage pins an empty vector
  // to a piece of text, and every later ingest of it silently stores the dud.
  await test("a failed embed is never cached, so a retry is a real retry", async () => {
    const embed = counting();
    await boot(embed);
    embed.failNext = true;
    const dud = await lib.ingest("a fact worth keeping");   // fails -> zero vector
    assert.equal(embed.calls, 1);

    await lib.ingest("a fact worth keeping", { forceNew: true }); // must retry
    assert.equal(embed.calls, 2, "the failure was served from cache");
    assert.ok(dud);
  });

  // A new embedFn or embeddingDim makes every entry wrong, not merely stale.
  await test("init() with a different embedder drops the old vectors", async () => {
    const first = counting({ fill: 1 });
    await boot(first);
    await lib.query("same words either way");

    const second = counting({ fill: 9 });
    await boot(second);
    await lib.query("same words either way");
    assert.equal(second.calls, 1, "the new embedder was never consulted");
  });

  console.log("\n── bounds ─────────────────────────────────────────────────────────");

  await test("the oldest entry is evicted once the bound is reached", async () => {
    const embed = counting();
    await boot(embed, { embedCacheSize: 2 });
    await lib.query("alpha");   // 1
    await lib.query("beta");    // 2
    await lib.query("gamma");   // 3 — evicts alpha
    assert.equal(embed.calls, 3);
    await lib.query("gamma");   // still cached
    assert.equal(embed.calls, 3);
    await lib.query("alpha");   // evicted, so a real call
    assert.equal(embed.calls, 4);
  });

  await test("a hit refreshes an entry's place in the eviction order", async () => {
    const embed = counting();
    await boot(embed, { embedCacheSize: 2 });
    await lib.query("alpha");
    await lib.query("beta");
    await lib.query("alpha");   // hit — alpha is now the NEWER of the two
    await lib.query("gamma");   // evicts beta, not alpha
    assert.equal(embed.calls, 3);
    await lib.query("alpha");
    assert.equal(embed.calls, 3, "alpha was evicted despite being used most recently");
  });

  await test("embedCacheSize 0 switches it off entirely", async () => {
    const embed = counting();
    await boot(embed, { embedCacheSize: 0 });
    await lib.query("same question");
    await lib.query("same question");
    assert.equal(embed.calls, 2);
    const status = await lib.getStatus();
    assert.equal(status.embedCache.max, 0);
    assert.equal(status.embedCache.size, 0);
  });

  console.log("\n── reporting ──────────────────────────────────────────────────────");

  await test("getStatus reports hits, misses and the rate", async () => {
    const embed = counting();
    await boot(embed);
    await lib.query("one");
    await lib.query("two");
    await lib.query("one");
    const { embedCache } = await lib.getStatus();
    assert.equal(embedCache.misses, 2);
    assert.equal(embedCache.hits, 1);
    assert.equal(embedCache.hitRate, 0.3333);
    assert.equal(embedCache.size, 2);
  });

  await test("hitRate is null before anything has been embedded", async () => {
    await boot(counting());
    const { embedCache } = await lib.getStatus();
    assert.equal(embedCache.hitRate, null);
  });

  console.log("\n── the answer must not change ─────────────────────────────────────");

  await test("a cached query returns exactly what a fresh one did", async () => {
    const embed = counting();
    await boot(embed, { minFinalScore: 0, minSemanticScore: 0 });
    await lib.ingest("the deploy runbook lives in DEPLOY.md");
    await lib.ingest("kalairos stores memories as jsonl");

    const fresh  = await lib.query("deploy runbook", { limit: 5 });
    const cached = await lib.query("deploy runbook", { limit: 5 });
    assert.deepEqual(
      cached.results.map(r => [r.id, r.score]),
      fresh.results.map(r => [r.id, r.score]),
      "the cached path scored differently",
    );
  });

  await lib.shutdown();
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed ? "❌" : "✅"}`);
  console.log("────────────────────────────────────────────────────────────\n");
  process.exit(failed ? 1 : 0);
})();
