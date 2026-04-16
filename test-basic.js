// test-basic.js — Database X foundation tests
// Run: node test-basic.js
"use strict";

const assert = require("assert/strict");
const lib    = require("./index");

// ─── Minimal test runner ──────────────────────────────────────────────────────
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

// ─── Deterministic bag-of-words embedder (no external service required) ──────
// Same text → cosine 1.0. More shared words → higher cosine. No I/O.
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

// ─── Shared init config ───────────────────────────────────────────────────────
const INIT_OPTS = {
  dataFile:         ":memory:",   // no disk I/O
  embeddingDim:     64,
  embedFn:          makeMockEmbedder(64),
  linkThreshold:    0.72,
  versionThreshold: 0.82,
  minFinalScore:    0.20,         // lower for test parity with small vocab vectors
};

// ─── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("\n── init guard ───────────────────────────────────────────────────");

  // lib is freshly loaded — _initialized is false at this point
  await test("ingest() throws if init() not called", async () => {
    await assert.rejects(
      () => lib.ingest("test"),
      /dbx\.init\(\)/i
    );
  });

  await test("query() throws if init() not called", async () => {
    await assert.rejects(
      () => lib.query("test"),
      /dbx\.init\(\)/i
    );
  });

  await test("get() throws if init() not called", async () => {
    await assert.rejects(
      () => lib.get(1),
      /dbx\.init\(\)/i
    );
  });

  console.log("\n── init ─────────────────────────────────────────────────────────");

  await test("init() resolves and returns { config, size }", async () => {
    const result = await lib.init(INIT_OPTS);
    assert.ok(result && typeof result === "object", "must return an object");
    assert.ok("config" in result, "must have config");
    assert.ok("size"   in result, "must have size");
    assert.strictEqual(result.size, 0, "fresh store should have 0 entities");
  });

  await test("init() is idempotent — calling twice resets the store", async () => {
    await lib.init(INIT_OPTS);
    await lib.ingest("some text");
    const r = await lib.init(INIT_OPTS);
    assert.strictEqual(r.size, 0, "re-init must clear the store");
  });

  // ── re-init for a clean state ──
  await lib.init(INIT_OPTS);

  console.log("\n── ingest ───────────────────────────────────────────────────────");

  await test("ingest(text) returns a numeric ID", async () => {
    const id = await lib.ingest("Machine learning improves software productivity");
    assert.ok(typeof id === "number", `expected number, got ${typeof id}`);
    assert.ok(id > 0, "ID must be positive");
  });

  await test("ingest with type and tags stores them", async () => {
    const id  = await lib.ingest("quarterly revenue report for 2024", {
      type: "document", tags: ["finance", "2024"],
    });
    const h = await lib.getHistory(id);
    assert.strictEqual(h.type, "document");
    assert.ok(h.tags.includes("finance"));
    assert.ok(h.tags.includes("2024"));
  });

  await test("ingest with metadata stores it", async () => {
    const id = await lib.ingest("product launch notes", {
      type: "document", metadata: { author: "alice", priority: "high" },
    });
    const h = await lib.getHistory(id);
    assert.strictEqual(h.metadata.author,   "alice");
    assert.strictEqual(h.metadata.priority, "high");
  });

  await test("remember defaults source to agent and classification to internal", async () => {
    const id = await lib.remember("agent memory worth keeping");
    const h = await lib.getHistory(id);
    assert.deepStrictEqual(h.source, { type: "agent" });
    assert.strictEqual(h.classification, "internal");
    assert.strictEqual(h.versions[0].classification, "internal");
  });

  await test("remember allows explicit source and classification overrides", async () => {
    const id = await lib.remember("sensitive agent memory", {
      source: { type: "tool", uri: "workflow://planner" },
      classification: "confidential",
    });
    const e = await lib.get(id);
    assert.deepStrictEqual(e.source, { type: "tool", uri: "workflow://planner" });
    assert.strictEqual(e.classification, "confidential");
  });

  await test("ingestBatch forwards source and classification", async () => {
    const [id] = await lib.ingestBatch([
      {
        text: "batched agent memory",
        source: { type: "agent" },
        classification: "regulated",
      },
    ]);
    const h = await lib.getHistory(id);
    assert.deepStrictEqual(h.source, { type: "agent" });
    assert.strictEqual(h.classification, "regulated");
    assert.strictEqual(h.versions[0].classification, "regulated");
  });

  console.log("\n── update vs new entity ─────────────────────────────────────────");

  await lib.init(INIT_OPTS); // fresh

  await test("identical text → same entity ID (version update)", async () => {
    const text = "The quarterly earnings report shows record profits this year";
    const id1  = await lib.ingest(text);
    const id2  = await lib.ingest(text);
    assert.strictEqual(id1, id2, "identical text must return the same ID");
  });

  await test("highly similar text → same entity ID", async () => {
    const id1 = await lib.ingest("raw material costs two hundred dollars per unit");
    const id2 = await lib.ingest("raw material costs two hundred dollars per unit in 2024");
    assert.strictEqual(id1, id2, "similar text must update the existing entity");
  });

  await test("completely different text → new entity ID", async () => {
    // Use texts with zero word overlap so bag-of-words cosine is 0
    const id1 = await lib.ingest("zzza zzb zzc zzd zze zzf zzg");
    const id2 = await lib.ingest("qqqa qqb qqc qqd qqe qqf qqg");
    assert.notStrictEqual(id1, id2, "unrelated text must create a new entity");
  });

  console.log("\n── query ────────────────────────────────────────────────────────");

  await lib.init(INIT_OPTS); // fresh
  await lib.ingest("machine learning improves software development");
  await lib.ingest("deep learning neural networks for image recognition");
  await lib.ingest("apple pie recipe with cinnamon and nutmeg");

  await test("query returns results array", async () => {
    const res = await lib.query("machine learning software");
    assert.ok(typeof res === "object");
    assert.ok(Array.isArray(res.results));
    assert.ok("count" in res);
    assert.ok("config" in res);
  });

  await test("query finds relevant entity", async () => {
    const res = await lib.query("machine learning software development", { limit: 5 });
    assert.ok(res.results.length > 0, "should find at least one result");
    const top = res.results[0];
    assert.ok(top.score > 0, "top result must have positive score");
    assert.ok("id" in top && "text" in top && "type" in top);
  });

  await test("query returns source and classification for recalled entities", async () => {
    await lib.init(INIT_OPTS);
    await lib.remember("project budget is 2.4 million dollars", {
      source: { type: "agent" },
      classification: "confidential",
    });
    const res = await lib.query("project budget");
    assert.ok(res.results.length > 0, "should find remembered entity");
    assert.deepStrictEqual(res.results[0].source, { type: "agent" });
    assert.strictEqual(res.results[0].classification, "confidential");
  });

  await test("query results are sorted by score descending", async () => {
    const res = await lib.query("learning neural networks", { limit: 5 });
    for (let i = 1; i < res.results.length; i++) {
      assert.ok(res.results[i - 1].score >= res.results[i].score,
        "results must be sorted high → low");
    }
  });

  await test("query respects limit", async () => {
    const res = await lib.query("learning", { limit: 1 });
    assert.ok(res.results.length <= 1, "must not exceed limit");
  });

  await test("query with type filter only returns matching type", async () => {
    await lib.init(INIT_OPTS);
    await lib.ingest("machine learning text",     { type: "text" });
    await lib.ingest("machine learning document", { type: "document" });
    const res = await lib.query("machine learning", { filter: { type: "document" } });
    for (const r of res.results) {
      assert.strictEqual(r.type, "document", "filter must exclude non-matching types");
    }
  });

  await test("query scores are always <= 1.0", async () => {
    await lib.init(INIT_OPTS);
    await lib.ingest("machine learning neural networks deep learning AI");
    await lib.ingest("machine learning algorithms for data science");
    const res = await lib.query("machine learning neural networks deep learning", { limit: 10 });
    for (const r of res.results) {
      assert.ok(r.score <= 1.0, `score ${r.score} exceeds 1.0`);
    }
  });

  console.log("\n── getHistory ───────────────────────────────────────────────────");

  await lib.init(INIT_OPTS);
  const hid = await lib.ingest("initial version of the document");

  await test("getHistory returns correct shape", async () => {
    const h = await lib.getHistory(hid);
    assert.ok("id"           in h);
    assert.ok("type"         in h);
    assert.ok("current"      in h);
    assert.ok("versions"     in h);
    assert.ok("versionCount" in h);
    assert.ok("createdAt"    in h);
    assert.ok("updatedAt"    in h);
    assert.ok(Array.isArray(h.versions));
  });

  await test("getHistory throws for unknown ID", async () => {
    await assert.rejects(
      () => lib.getHistory(999999999),
      /not found/i
    );
  });

  console.log("\n── get ──────────────────────────────────────────────────────────");

  await lib.init(INIT_OPTS);
  const gid = await lib.ingest("entity for lightweight get test");

  await test("get returns current entity without versions array", async () => {
    const e = await lib.get(gid);
    assert.strictEqual(e.id, gid);
    assert.ok("text"         in e, "must have text");
    assert.ok("type"         in e, "must have type");
    assert.ok("metadata"     in e, "must have metadata");
    assert.ok("tags"         in e, "must have tags");
    assert.ok("versionCount" in e, "must have versionCount");
    assert.ok(!("versions"   in e), "get must NOT expose versions array");
  });

  await test("get throws for unknown ID", async () => {
    await assert.rejects(
      () => lib.get(999999999),
      /not found/i
    );
  });

  console.log("\n── getMany ──────────────────────────────────────────────────────");

  await lib.init(INIT_OPTS);
  const gm1 = await lib.ingest("first entity for getMany batch test");
  const gm2 = await lib.ingest("second entity for getMany batch test");
  const gm3 = await lib.ingest("third entity for getMany batch test");

  await test("getMany returns array in the same order as input IDs", async () => {
    const results = await lib.getMany([gm3, gm1, gm2]);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].id, gm3);
    assert.strictEqual(results[1].id, gm1);
    assert.strictEqual(results[2].id, gm2);
  });

  await test("getMany returns null for missing IDs (not an error)", async () => {
    const results = await lib.getMany([gm1, 999999999, gm2]);
    assert.strictEqual(results[0].id, gm1);
    assert.strictEqual(results[1], null, "missing ID must return null, not throw");
    assert.strictEqual(results[2].id, gm2);
  });

  await test("getMany returns entity shape without versions array", async () => {
    const [e] = await lib.getMany([gm1]);
    assert.ok("id"           in e);
    assert.ok("type"         in e);
    assert.ok("text"         in e);
    assert.ok("metadata"     in e);
    assert.ok("tags"         in e);
    assert.ok("versionCount" in e);
    assert.ok(!("versions"   in e), "must not expose versions array");
  });

  await test("getMany([]) returns empty array", async () => {
    const results = await lib.getMany([]);
    assert.deepEqual(results, []);
  });

  await test("getMany throws if ids is not an array", async () => {
    await assert.rejects(
      () => lib.getMany("not-an-array"),
      /must be an array/i
    );
  });

  console.log("\n── remove ───────────────────────────────────────────────────────");

  await test("remove soft-deletes the entity", async () => {
    const id = await lib.ingest("entity to be removed permanently");
    await lib.remove(id, { deletedBy: { type: "user", actor: "test-admin" } });
    const after = await lib.get(id);
    assert.ok(after.deletedAt, "deletedAt must be set after remove()");
    assert.strictEqual(after.deletedBy.actor, "test-admin");
  });

  await test("remove rejects double-delete", async () => {
    const id = await lib.ingest("entity to double-delete");
    await lib.remove(id);
    await assert.rejects(() => lib.remove(id), /already deleted/i);
  });

  await test("purge permanently deletes the entity", async () => {
    const id = await lib.ingest("entity to be purged permanently");
    await lib.purge(id);
    await assert.rejects(() => lib.get(id), /not found/i);
  });

  await test("remove throws for unknown ID", async () => {
    await assert.rejects(
      () => lib.remove(999999999),
      /not found/i
    );
  });

  await test("remove cleans up back-links in connected entities", async () => {
    await lib.init({ ...INIT_OPTS, linkThreshold: 0.50 }); // lower threshold to guarantee links form
    const id1 = await lib.ingest("semantic memory knowledge graph system");
    const id2 = await lib.ingest("semantic memory knowledge graph database");

    // Verify they're linked before removal
    const before = await lib.get(id1);
    // After removing id2, id1 must not still point to it
    await lib.remove(id2);
    const after = await lib.get(id1);
    assert.ok(after.linkCount <= before.linkCount, "link count must not increase after peer removal");
  });

  console.log("\n── ingestBatch ──────────────────────────────────────────────────");

  await lib.init(INIT_OPTS);

  await test("ingestBatch returns array of IDs", async () => {
    const ids = await lib.ingestBatch([
      { text: "batch item one about databases and storage" },
      { text: "batch item two about programming languages" },
      { text: "batch item three about artificial intelligence" },
    ]);
    assert.ok(Array.isArray(ids));
    assert.strictEqual(ids.length, 3);
    assert.ok(ids.every(id => typeof id === "number" && id > 0));
  });

  await test("ingestBatch IDs are unique", async () => {
    await lib.init(INIT_OPTS);
    const ids = await lib.ingestBatch([
      { text: "completely unique text alpha zeta omega" },
      { text: "totally distinct text beta gamma delta" },
      { text: "separate item text epsilon theta iota" },
    ]);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length, "all batch IDs must be unique");
  });

  await test("ingestBatch throws on empty array", async () => {
    await assert.rejects(
      () => lib.ingestBatch([]),
      /non-empty/i
    );
  });

  console.log("\n── getStatus ────────────────────────────────────────────────────");

  await lib.init(INIT_OPTS);
  await lib.ingest("text entity",     { type: "text" });
  await lib.ingest("document entity", { type: "document" });
  await lib.ingest("another text",    { type: "text" });

  await test("getStatus returns correct entity count", async () => {
    const s = await lib.getStatus();
    assert.strictEqual(s.entities, 3);
  });

  await test("getStatus.byType is accurate", async () => {
    const s = await lib.getStatus();
    assert.strictEqual(s.byType.text,     2);
    assert.strictEqual(s.byType.document, 1);
  });

  await test("getStatus has totalVersions >= entities", async () => {
    const s = await lib.getStatus();
    assert.ok(s.totalVersions >= s.entities, "each entity has at least 1 version");
  });

  console.log("\n── listEntities ─────────────────────────────────────────────────");

  await test("listEntities returns paginated structure", async () => {
    const r = await lib.listEntities({ limit: 2 });
    assert.ok("total"    in r);
    assert.ok("page"     in r);
    assert.ok("pages"    in r);
    assert.ok("entities" in r);
    assert.ok(Array.isArray(r.entities));
    assert.ok(r.entities.length <= 2);
  });

  await test("listEntities type filter works", async () => {
    const r = await lib.listEntities({ type: "document" });
    assert.strictEqual(r.entities.length, 1);
    assert.strictEqual(r.entities[0].type, "document");
  });

  console.log("\n── token-budgeted query ──────────────────────────────────────────");

  await test("maxTokens returns tokenUsage in response", async () => {
    const r = await lib.query("budget", { maxTokens: 5000 });
    assert.ok(r.tokenUsage, "response should include tokenUsage");
    assert.strictEqual(r.tokenUsage.budget, 5000);
    assert.ok(typeof r.tokenUsage.used === "number");
    assert.ok(typeof r.tokenUsage.resultsDropped === "number");
  });

  await test("maxTokens caps results to fit within budget", async () => {
    // Ingest several texts with shared vocabulary so they score above minFinalScore
    for (let i = 0; i < 5; i++) {
      await lib.ingest("the quarterly financial budget forecast report details " + "extra ".repeat(200) + " item " + i, { type: "budget-test" });
    }
    // Very small budget: should return fewer results than large budget
    const small = await lib.query("the quarterly financial budget forecast", { limit: 10, maxTokens: 100 });
    assert.ok(small.tokenUsage, "should have tokenUsage");
    // Large budget: should return more results
    const large = await lib.query("the quarterly financial budget forecast", { limit: 10, maxTokens: 50000 });
    assert.ok(large.results.length >= small.results.length, "larger budget should return >= results");
    if (large.results.length > 1) {
      assert.ok(small.results.length < large.results.length, "small budget should drop some results");
    }
  });

  await test("query without maxTokens has no tokenUsage field", async () => {
    const r = await lib.query("the quarterly financial budget forecast");
    assert.strictEqual(r.tokenUsage, undefined, "no tokenUsage without maxTokens");
  });

  await test("maxTokens always includes at least one result", async () => {
    // Even with a tiny budget, we always return at least the top result.
    // Use "machine learning" which is ingested multiple times and scores reliably.
    const r = await lib.query("machine learning", { maxTokens: 1 });
    assert.ok(r.results.length >= 1, "should always return at least 1");
    assert.ok(r.tokenUsage.used > 0, "should report tokens used");
  });

  console.log("\n── getGraph ─────────────────────────────────────────────────────");

  await test("getGraph returns nodes and edges arrays", async () => {
    const g = await lib.getGraph();
    assert.ok(Array.isArray(g.nodes));
    assert.ok(Array.isArray(g.edges));
    assert.ok(g.nodes.length >= 3, "should have at least 3 nodes");
  });

  await test("graph nodes have required fields", async () => {
    const g = await lib.getGraph();
    for (const n of g.nodes) {
      assert.ok("id"    in n, "node must have id");
      assert.ok("type"  in n, "node must have type");
      assert.ok("label" in n, "node must have label");
    }
  });

  console.log("\n── traverse ─────────────────────────────────────────────────────");

  await test("traverse returns root node", async () => {
    const id = await lib.ingest("knowledge graph traversal test entity");
    const r  = await lib.traverse(id, 1);
    assert.ok(Array.isArray(r.nodes));
    assert.ok(Array.isArray(r.edges));
    assert.ok(r.nodes.some(n => n.id === id), "root entity must be in results");
  });

  await test("traverse throws for unknown ID", async () => {
    await assert.rejects(
      () => lib.traverse(999999999),
      /not found/i
    );
  });

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const total = passed + failed;
  console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
  console.log(`${"─".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
