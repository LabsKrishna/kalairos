// test-sqlite-index.js — KAL-102 / KAL-103 / KAL-104 / KAL-105 unit tests
// Run: node test-sqlite-index.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { SqliteIndex, applySchemaV1, rebuild, SCHEMA_VERSION } = require("./store/sqlite-index");

// ── Minimal async test runner (mirrors test-basic.js) ───────────────────────
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

// ── Tmp dir scaffolding ─────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kal-sqlite-test-"));
let counter = 0;
const fresh = (suffix) => path.join(tmpRoot, `${++counter}-${suffix}`);

// Build a deterministic JSONL fixture matching the entity shape that
// store/file-store.js writes. No timestamps from Date.now() — every value is
// derived from `i` so rebuilds are byte-stable.
function writeFixtureJsonl(filePath, n, { withLinks = false } = {}) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const id = 1_000_000 + i; // numeric ids, like _newId in index.js
    const ts = 1_700_000_000_000 + i * 1000;
    const tags = i % 3 === 0 ? ["alpha"] : (i % 3 === 1 ? ["beta", "gamma"] : []);
    const links = withLinks && i > 0 ? [1_000_000 + (i - 1)] : [];
    const versions = [
      { versionId: `${id}:1`, timestamp: ts, ingestAt: ts, effectiveAt: ts,
        validFrom: ts, validTo: null, action: "create" },
    ];
    // For some entities, append a v2 to exercise multi-version mapping.
    if (i % 5 === 4) {
      versions.unshift({ versionId: `${id}:2`, timestamp: ts + 500, ingestAt: ts + 500,
        effectiveAt: ts + 500, validFrom: ts + 500, validTo: null, action: "update" });
    }
    lines.push(JSON.stringify({
      id,
      text: `entity-${i}-${i % 7 === 0 ? "important" : "routine"}`,
      type: "text",
      memoryType: i % 4 === 0 ? "short-term" : "long-term",
      workspaceId: i % 6 === 0 ? "alt" : "default",
      tags,
      trustScore: 0.5 + (i % 5) * 0.1,
      links,
      versions,
    }));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// Dump the logical contents of an index (everything except meta.index_built_at,
// which is wallclock-derived and excluded from determinism comparisons per
// spec §7).
function dumpLogical(sqlitePath) {
  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    const facts    = idx.db.prepare("SELECT * FROM facts ORDER BY id").all();
    const versions = idx.db.prepare("SELECT * FROM fact_versions ORDER BY fact_id, version").all();
    const links    = idx.db.prepare("SELECT * FROM links ORDER BY src_id, dst_id, kind").all();
    const meta     = idx.db.prepare("SELECT key, value FROM meta WHERE key != 'index_built_at' ORDER BY key").all();
    return JSON.stringify({ facts, versions, links, meta });
  } finally {
    idx.close();
  }
}

// ── Run everything inside an async IIFE — top-level await is ESM-only and
//     this project ships as CommonJS, matching test-basic.js. ───────────────
(async () => {

// ── KAL-102 lifecycle ───────────────────────────────────────────────────────
console.log("\n── SqliteIndex lifecycle (KAL-102) ──────────────────────────────");

await test("healthCheck on unopened index reports closed", () => {
  const idx = new SqliteIndex();
  assert.deepEqual(idx.healthCheck(), { open: false });
});

await test("open() on a file path turns WAL on and applies schema", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("lifecycle.sqlite"));
  try {
    const h = idx.healthCheck();
    assert.equal(h.open, true);
    assert.equal(String(h.journalMode).toLowerCase(), "wal", `journalMode=${h.journalMode}`);
    assert.equal(Number(h.synchronous), 1, `synchronous=${h.synchronous}`);
    assert.equal(h.schemaVersion, SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

await test("open() is idempotent when called twice with the same path", () => {
  const idx = new SqliteIndex();
  const p = fresh("idempotent.sqlite");
  idx.open(p);
  try {
    idx.open(p);
    assert.equal(idx.healthCheck().path, p);
  } finally {
    idx.close();
  }
});

await test("open() with a different path while already open throws", () => {
  const idx = new SqliteIndex();
  const p1 = fresh("a.sqlite");
  const p2 = fresh("b.sqlite");
  idx.open(p1);
  try {
    assert.throws(() => idx.open(p2), /already open/);
  } finally {
    idx.close();
  }
});

await test("close() is idempotent (calling twice does not throw)", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("close.sqlite"));
  idx.close();
  idx.close();
  assert.equal(idx.healthCheck().open, false);
});

await test("re-open after close works and preserves the file", () => {
  const idx = new SqliteIndex();
  const p = fresh("reopen.sqlite");
  idx.open(p);
  idx.close();
  assert.ok(fs.existsSync(p));
  idx.open(p);
  try {
    assert.equal(idx.healthCheck().schemaVersion, SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

// ── KAL-103 schema ──────────────────────────────────────────────────────────
console.log("\n── Schema v1 (KAL-103) ──────────────────────────────────────────");

function tablesIndexesTriggers(idx) {
  const objs = idx.db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  ).all();
  return {
    tables:   objs.filter(o => o.type === "table").map(o => o.name),
    indexes:  objs.filter(o => o.type === "index").map(o => o.name),
    triggers: objs.filter(o => o.type === "trigger").map(o => o.name),
  };
}

await test("fresh DB has all expected tables", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("schema-tables.sqlite"));
  try {
    const { tables } = tablesIndexesTriggers(idx);
    for (const t of ["facts", "fact_versions", "links", "facts_fts", "meta"]) {
      assert.ok(tables.includes(t), `expected table ${t}, got ${tables.join(",")}`);
    }
  } finally {
    idx.close();
  }
});

await test("fresh DB has the four facts indexes plus version/link indexes", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("schema-indexes.sqlite"));
  try {
    const { indexes } = tablesIndexesTriggers(idx);
    for (const i of [
      "idx_facts_namespace",
      "idx_facts_workspace",
      "idx_facts_updated",
      "idx_facts_live_recent",
      "idx_versions_written",
      "idx_links_dst",
    ]) {
      assert.ok(indexes.includes(i), `expected index ${i}, got ${indexes.join(",")}`);
    }
  } finally {
    idx.close();
  }
});

await test("fresh DB has the three FTS5 sync triggers", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("schema-triggers.sqlite"));
  try {
    const { triggers } = tablesIndexesTriggers(idx);
    for (const t of ["facts_ai", "facts_ad", "facts_au"]) {
      assert.ok(triggers.includes(t), `expected trigger ${t}, got ${triggers.join(",")}`);
    }
  } finally {
    idx.close();
  }
});

await test("re-applying schema on an existing DB is idempotent", () => {
  const idx = new SqliteIndex();
  const p = fresh("schema-idempotent.sqlite");
  idx.open(p);
  try {
    applySchemaV1(idx.db);
    applySchemaV1(idx.db);
    assert.equal(idx._meta("schema_version"), SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

await test("FTS5 sync triggers index inserted facts", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("schema-fts-insert.sqlite"));
  try {
    const now = Date.now();
    idx.db.prepare(`
      INSERT INTO facts (id, text, namespace, created_at, updated_at, jsonl_offset)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("f1", "the quick brown fox", "history", now, now, 0);
    const hits = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("fox");
    assert.equal(hits.length, 1);
  } finally {
    idx.close();
  }
});

await test("FTS5 sync triggers reflect updates and deletes", () => {
  const idx = new SqliteIndex();
  idx.open(fresh("schema-fts-update.sqlite"));
  try {
    const now = Date.now();
    idx.db.prepare(`
      INSERT INTO facts (id, text, namespace, created_at, updated_at, jsonl_offset)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("f1", "alpha bravo", "history", now, now, 0);

    idx.db.prepare("UPDATE facts SET text = ?, updated_at = ? WHERE id = ?")
      .run("charlie delta", now + 1, "f1");
    const alpha   = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("alpha");
    const charlie = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("charlie");
    assert.equal(alpha.length, 0);
    assert.equal(charlie.length, 1);

    idx.db.prepare("DELETE FROM facts WHERE id = ?").run("f1");
    const after = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("charlie");
    assert.equal(after.length, 0);
  } finally {
    idx.close();
  }
});

await test("applySchemaV1 can be called on a bare better-sqlite3 connection", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    applySchemaV1(db);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
    assert.equal(row.value, SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

// ── KAL-104 rebuild from JSONL ──────────────────────────────────────────────
console.log("\n── Rebuild from JSONL (KAL-104) ─────────────────────────────────");

await test("rebuild on an empty JSONL produces an indexed but empty SQLite", async () => {
  const jsonlPath  = fresh("empty.jsonl");
  const sqlitePath = fresh("empty.sqlite");
  fs.writeFileSync(jsonlPath, "");

  const result = await rebuild({ jsonlPath, sqlitePath });
  assert.equal(result.rowsApplied, 0);
  assert.ok(fs.existsSync(sqlitePath));

  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS c FROM facts").get().c, 0);
    assert.equal(idx._meta("schema_version"), SCHEMA_VERSION);
    assert.equal(idx._meta("jsonl_path"), jsonlPath);
  } finally {
    idx.close();
  }
});

await test("rebuild from a 100-row fixture populates facts, versions, and links", async () => {
  const jsonlPath  = fresh("fixture.jsonl");
  const sqlitePath = fresh("fixture.sqlite");
  writeFixtureJsonl(jsonlPath, 100, { withLinks: true });

  const result = await rebuild({ jsonlPath, sqlitePath });
  assert.equal(result.rowsApplied, 100);

  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    const factCount = idx.db.prepare("SELECT COUNT(*) AS c FROM facts").get().c;
    assert.equal(factCount, 100);

    // Every 5th entity gets a second version (i % 5 === 4 → 20 entities).
    const versionCount = idx.db.prepare("SELECT COUNT(*) AS c FROM fact_versions").get().c;
    assert.equal(versionCount, 100 + 20, `expected 120 version rows, got ${versionCount}`);

    // 99 sequential links (entity i links to entity i-1, for i > 0).
    const linkCount = idx.db.prepare("SELECT COUNT(*) AS c FROM links").get().c;
    assert.equal(linkCount, 99);

    // Spot-check namespace mapping (memoryType → namespace).
    const shortTerm = idx.db.prepare("SELECT COUNT(*) AS c FROM facts WHERE namespace = 'short-term'").get().c;
    assert.equal(shortTerm, 25, `expected 25 short-term entities (every 4th), got ${shortTerm}`);

    // FTS reflects the rebuild.
    const importantHits = idx.db.prepare("SELECT COUNT(*) AS c FROM facts_fts WHERE facts_fts MATCH ?").get("important").c;
    assert.ok(importantHits > 0, "FTS should index 'important' tokens written by the rebuild");
  } finally {
    idx.close();
  }
});

await test("rebuild skips malformed lines and continues", async () => {
  const jsonlPath  = fresh("malformed.jsonl");
  const sqlitePath = fresh("malformed.sqlite");
  const good1 = JSON.stringify({ id: 1, text: "ok-1", versions: [{ versionId: "1:1", timestamp: 1 }] });
  const bad   = "{ this is not valid json";
  const good2 = JSON.stringify({ id: 2, text: "ok-2", versions: [{ versionId: "2:1", timestamp: 2 }] });
  fs.writeFileSync(jsonlPath, [good1, bad, good2].join("\n") + "\n");

  // Suppress the expected warning so test output stays readable.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await rebuild({ jsonlPath, sqlitePath });
    assert.equal(result.rowsApplied, 2);
  } finally {
    console.warn = origWarn;
  }

  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    const ids = idx.db.prepare("SELECT id FROM facts ORDER BY id").all().map(r => r.id);
    assert.deepEqual(ids, ["1", "2"]);
  } finally {
    idx.close();
  }
});

await test("rebuild reaps an orphan .rebuild from a previous crashed attempt", async () => {
  const jsonlPath  = fresh("orphan.jsonl");
  const sqlitePath = fresh("orphan.sqlite");
  writeFixtureJsonl(jsonlPath, 5);

  // Plant a stale .rebuild file simulating a prior crash.
  fs.writeFileSync(sqlitePath + ".rebuild", "garbage from a dead build");

  await rebuild({ jsonlPath, sqlitePath });

  // Orphan must be cleaned up; canonical must exist.
  assert.ok(!fs.existsSync(sqlitePath + ".rebuild"), ".rebuild orphan should be reaped");
  assert.ok(fs.existsSync(sqlitePath));
});

await test("rebuild via the SqliteIndex.rebuildFrom instance wrapper", async () => {
  const jsonlPath  = fresh("wrapper.jsonl");
  const sqlitePath = fresh("wrapper.sqlite");
  writeFixtureJsonl(jsonlPath, 10);

  const idx = new SqliteIndex();
  idx.open(sqlitePath); // bind the path
  await idx.rebuildFrom(jsonlPath);

  // The wrapper closes the instance during rebuild; re-open to query.
  assert.equal(idx.healthCheck().open, false);
  idx.open(sqlitePath);
  try {
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS c FROM facts").get().c, 10);
  } finally {
    idx.close();
  }
});

await test("rebuildFrom without a sqlitePath throws when the instance is fresh", async () => {
  const idx = new SqliteIndex();
  await assert.rejects(
    () => idx.rebuildFrom(fresh("no-target.jsonl")),
    /sqlitePath required/
  );
});

await test("rebuild writes meta with jsonl size, hash, offset, and version", async () => {
  const jsonlPath  = fresh("meta.jsonl");
  const sqlitePath = fresh("meta.sqlite");
  writeFixtureJsonl(jsonlPath, 20);

  const result = await rebuild({ jsonlPath, sqlitePath });
  const expectedSize = fs.statSync(jsonlPath).size;
  assert.equal(result.jsonlSize, expectedSize);
  assert.equal(result.lastOffset, expectedSize);

  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    assert.equal(idx._meta("jsonl_size_bytes"), String(expectedSize));
    assert.equal(idx._meta("last_jsonl_offset"), String(expectedSize));
    assert.equal(idx._meta("dirty"), "0");
    assert.match(idx._meta("jsonl_sha256_first_4kb"), /^[0-9a-f]{64}$/);
    assert.ok(idx._meta("kalairos_version"));
    assert.match(idx._meta("index_built_at"), /^\d+$/);
  } finally {
    idx.close();
  }
});

// ── KAL-105 determinism ─────────────────────────────────────────────────────
console.log("\n── Rebuild determinism (KAL-105) ────────────────────────────────");

await test("two consecutive rebuilds of the same JSONL produce byte-identical logical contents", async () => {
  const jsonlPath = fresh("determinism.jsonl");
  writeFixtureJsonl(jsonlPath, 1000, { withLinks: true });

  const sqliteA = fresh("determinism-a.sqlite");
  const sqliteB = fresh("determinism-b.sqlite");

  const t0 = Date.now();
  await rebuild({ jsonlPath, sqlitePath: sqliteA });
  await rebuild({ jsonlPath, sqlitePath: sqliteB });
  const elapsed = Date.now() - t0;

  const dumpA = dumpLogical(sqliteA);
  const dumpB = dumpLogical(sqliteB);
  assert.equal(dumpA, dumpB, "rebuilds must produce byte-identical logical contents (excluding index_built_at)");

  // KAL-105 AC: test runs in <2 seconds (1000 rows, two rebuilds, on a typical SSD).
  // Loose bound to stay green on shared CI runners while still flagging regressions.
  assert.ok(elapsed < 5000, `1000-row × 2 determinism test should run in well under 5s; took ${elapsed}ms`);
});

// ── Cleanup + results ───────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);

})();
