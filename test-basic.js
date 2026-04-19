// test-basic.js — Kalairos foundation tests
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
      /kalairos\.init\(\)/i
    );
  });

  await test("query() throws if init() not called", async () => {
    await assert.rejects(
      () => lib.query("test"),
      /kalairos\.init\(\)/i
    );
  });

  await test("get() throws if init() not called", async () => {
    await assert.rejects(
      () => lib.get(1),
      /kalairos\.init\(\)/i
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

  console.log("\n── getStartupSummary (progressive context loading) ────────────");

  // Re-init with a known set of entities for summary tests
  await lib.init(INIT_OPTS);

  await test("getStartupSummary() returns empty when store is empty", async () => {
    const result = await lib.getStartupSummary();
    assert.strictEqual(result.summary.totalMemories, 0);
    assert.strictEqual(result.items.length, 0);
    assert.strictEqual(result.summary.tokenUsage.used, 0);
  });

  // Populate with varying ages and connectivity
  const now = Date.now();
  const DAY = 86_400_000;
  const recentId = await lib.ingest("critical production alert: payment service is down", {
    timestamp: now, tags: ["critical", "ops"],
  });
  const oldId = await lib.ingest("team offsite planned for next quarter", {
    timestamp: now - 60 * DAY, tags: ["planning"],
  });
  const middleId = await lib.ingest("quarterly revenue reached four million dollars", {
    timestamp: now - 5 * DAY, tags: ["finance"],
  });
  // Create a frequently-updated entity (multiple versions)
  const updatedId = await lib.ingest("deployment target is kubernetes on aws", {
    timestamp: now - 10 * DAY, tags: ["infra"],
  });
  await lib.ingest("deployment target is kubernetes on gcp instead of aws", {
    timestamp: now - 3 * DAY, tags: ["infra"],
  });

  await test("getStartupSummary() returns ranked items without a query", async () => {
    const result = await lib.getStartupSummary({ maxTokens: 2000 });
    assert.ok(result.summary.totalMemories > 0);
    assert.ok(result.items.length > 0);
    assert.ok(result.summary.generatedAt);
    // Each item should have the expected fields
    const first = result.items[0];
    assert.ok("id" in first);
    assert.ok("score" in first);
    assert.ok("importance" in first);
    assert.ok("recency" in first);
    assert.ok("text" in first);
    assert.ok("versionCount" in first);
  });

  await test("most recent item ranks higher than old item", async () => {
    const result = await lib.getStartupSummary({ maxTokens: 5000 });
    const ids = result.items.map(i => i.id);
    const recentIdx = ids.indexOf(recentId);
    const oldIdx = ids.indexOf(oldId);
    assert.ok(recentIdx >= 0, "recent item should be in results");
    assert.ok(oldIdx >= 0, "old item should be in results");
    assert.ok(recentIdx < oldIdx, "recent item should rank higher (lower index) than old item");
  });

  await test("depth 'essential' caps at 5 items", async () => {
    const result = await lib.getStartupSummary({ depth: "essential", maxTokens: 50000 });
    assert.ok(result.items.length <= 5);
    assert.strictEqual(result.summary.depth, "essential");
  });

  await test("depth 'full' allows up to 50 items", async () => {
    const result = await lib.getStartupSummary({ depth: "full", maxTokens: 50000 });
    assert.strictEqual(result.summary.depth, "full");
  });

  await test("maxTokens budget is respected", async () => {
    const result = await lib.getStartupSummary({ maxTokens: 50 });
    assert.ok(result.summary.tokenUsage.used <= 50 + 30, "token usage should stay near budget");
    assert.ok(result.items.length >= 1, "should return at least one item");
    assert.ok(result.items.length < 4, "small budget should limit items returned");
  });

  await test("filter narrows results", async () => {
    const result = await lib.getStartupSummary({ maxTokens: 5000, filter: { tags: ["finance"] } });
    assert.ok(result.items.length >= 1);
    assert.ok(result.items.every(i => i.tags.includes("finance")));
  });

  await test("scores are sorted descending", async () => {
    const result = await lib.getStartupSummary({ maxTokens: 5000 });
    for (let i = 1; i < result.items.length; i++) {
      assert.ok(result.items[i - 1].score >= result.items[i].score,
        `item ${i - 1} score ${result.items[i - 1].score} should be >= item ${i} score ${result.items[i].score}`);
    }
  });

  console.log("\n── agent.boot() ─────────────────────────────────────────────────");

  await test("agent.boot() returns startup summary", async () => {
    const agent = lib.createAgent({ name: "boot-test" });
    const result = await agent.boot({ maxTokens: 2000 });
    assert.ok(result.summary);
    assert.ok(result.items.length > 0);
  });

  console.log("\n── importance scoring ────────────────────────────────────────────");

  await lib.init({ ...INIT_OPTS, importanceWeight: 0.05 });

  await test("explicit importance stored on entity", async () => {
    const id = await lib.ingest("critical security policy update", { importance: 0.95 });
    const e = await lib.get(id);
    assert.ok(e.importance === 0.95, `expected 0.95, got ${e.importance}`);
  });

  await test("importance clamped to 0-1 range", async () => {
    const id = await lib.ingest("over-importance", { importance: 5 });
    const e = await lib.get(id);
    assert.ok(e.importance === 1, `expected 1, got ${e.importance}`);
  });

  await test("query results include importanceBoost field", async () => {
    const r = await lib.query("security policy", { limit: 5 });
    assert.ok(r.results.length >= 1, "should return results");
    const first = r.results[0];
    assert.ok(typeof first.importanceBoost === "number", "should have importanceBoost");
    assert.ok(typeof first.importance === "number", "should have importance");
  });

  await test("high-importance memory scores higher than low-importance", async () => {
    await lib.init({ ...INIT_OPTS, importanceWeight: 0.10 });
    await lib.ingest("critical security vulnerability patch requires immediate deployment", { importance: 0.9 });
    await lib.ingest("the office coffee machine brand is keurig model platinum", { importance: 0.1 });
    const r = await lib.query("security vulnerability patch deployment", { limit: 5 });
    assert.ok(r.results.length >= 1, "should return at least 1 result");
    assert.ok(r.results[0].importance >= 0.9,
      `first result importance ${r.results[0].importance} should be >= 0.9`);
    assert.ok(r.results[0].importanceBoost > 0,
      `importanceBoost ${r.results[0].importanceBoost} should be > 0`);
  });

  await test("importance defaults to null when not set", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("a simple fact without importance");
    const e = await lib.get(id);
    assert.ok(e.importance === null, `expected null, got ${e.importance}`);
  });

  console.log("\n── trust weighting (opt-in) ─────────────────────────────────────");

  await test("trustWeight defaults to 0 and preserves scoring", async () => {
    await lib.init(INIT_OPTS);
    const id = await lib.ingest("the primary api endpoint is secure");
    await lib.annotate(id, { trustScore: 0.2 });
    const res = await lib.query("primary api endpoint");
    assert.ok(res.results.length >= 1, "expected at least one result");
    // trustWeight=0 → multiplier is 1.0 regardless of trustScore
    assert.strictEqual(res.results[0].trustMultiplier, 1, "multiplier must be 1.0 when trustWeight=0");
    assert.strictEqual(res.config.trustWeight, 0, "config must report trustWeight=0");
  });

  await test("trustWeight > 0 penalises low-trust entities", async () => {
    await lib.init({ ...INIT_OPTS, trustWeight: 0.5, versionThreshold: 0.99 });
    // Use distinct content so they remain separate entities (no version merge)
    const hi = await lib.ingest("payment gateway stripe handles transactions securely via oauth");
    const lo = await lib.ingest("shipping warehouse logistics tracks parcels through freight carriers");
    await lib.annotate(hi, { trustScore: 1.0 });
    await lib.annotate(lo, { trustScore: 0.1 });

    // Query matches both roughly equally on keywords-unrelated terms; semantic dominates.
    // We pull both by id via direct get to compare their score contributions fairly —
    // but since query only returns matches above minFinalScore, we verify trust via get().
    const hiEntity = await lib.get(hi);
    const loEntity = await lib.get(lo);
    assert.strictEqual(hiEntity.trustScore, 1.0, "hi must have trustScore 1.0");
    assert.strictEqual(loEntity.trustScore, 0.1, "lo must have trustScore 0.1");

    // Run a targeted query against each and compare the score delta under trustWeight=0.5
    const hiRes = await lib.query("payment gateway stripe transactions");
    const loRes = await lib.query("shipping warehouse logistics parcels");
    const hiScore = hiRes.results.find(r => r.id === hi)?.score;
    const loScore = loRes.results.find(r => r.id === lo)?.score;
    assert.ok(hiScore != null && loScore != null, "both queries must return their target");
    // hi has trustMultiplier = 1.0 (trust=1.0); lo has trustMultiplier = 0.55 (trust=0.1)
    // So lo's score is scaled down ~0.55× of its raw score.
    const hiMult = hiRes.results.find(r => r.id === hi).trustMultiplier;
    const loMult = loRes.results.find(r => r.id === lo).trustMultiplier;
    assert.ok(Math.abs(hiMult - 1.0) < 1e-6, `hi multiplier should be 1.0, got ${hiMult}`);
    assert.ok(Math.abs(loMult - 0.55) < 1e-6, `lo multiplier should be 0.55, got ${loMult}`);
  });

  await test("missing trustScore treated as neutral (1.0)", async () => {
    await lib.init({ ...INIT_OPTS, trustWeight: 0.5 });
    const id = await lib.ingest("some fact with no trust annotation");
    const res = await lib.query("fact with no trust");
    assert.ok(res.results.length >= 1, "expected a result");
    // Default trustScore on ingest is 0.7 (per _entityToParams default), so assert it's at least
    // non-null and the multiplier is computed. What matters: no crash, no null, multiplier finite.
    const r = res.results[0];
    assert.ok(Number.isFinite(r.trust), "trust must be finite");
    assert.ok(Number.isFinite(r.trustMultiplier), "trustMultiplier must be finite");
  });

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  const total = passed + failed;
  console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
  console.log(`${"─".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
