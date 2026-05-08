// test-sqlite-index.js — KAL-102 + KAL-103 unit tests
// Run: node test-sqlite-index.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { SqliteIndex, applySchemaV1, SCHEMA_VERSION } = require("./store/sqlite-index");

// ── Minimal test runner (mirrors test-basic.js) ─────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
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
let dbCounter = 0;
function freshDbPath() {
  return path.join(tmpRoot, `index-${++dbCounter}.sqlite`);
}

// ── Lifecycle (KAL-102) ─────────────────────────────────────────────────────
console.log("\n── SqliteIndex lifecycle (KAL-102) ──────────────────────────────");

test("healthCheck on unopened index reports closed", () => {
  const idx = new SqliteIndex();
  assert.deepEqual(idx.healthCheck(), { open: false });
});

test("open() on a file path turns WAL on and applies schema", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const h = idx.healthCheck();
    assert.equal(h.open, true);
    // WAL on file-backed DBs reports "wal"; some drivers/platforms uppercase it.
    assert.equal(String(h.journalMode).toLowerCase(), "wal", `journalMode=${h.journalMode}`);
    // synchronous=NORMAL is integer 1 in SQLite's pragma reply.
    assert.equal(Number(h.synchronous), 1, `synchronous=${h.synchronous}`);
    assert.equal(h.schemaVersion, SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

test("open() is idempotent when called twice with the same path", () => {
  const idx = new SqliteIndex();
  const p = freshDbPath();
  idx.open(p);
  try {
    // Should not throw, should not reopen, should leave state stable.
    idx.open(p);
    assert.equal(idx.healthCheck().path, p);
  } finally {
    idx.close();
  }
});

test("open() with a different path while already open throws", () => {
  const idx = new SqliteIndex();
  const p1 = freshDbPath();
  const p2 = freshDbPath();
  idx.open(p1);
  try {
    assert.throws(() => idx.open(p2), /already open/);
  } finally {
    idx.close();
  }
});

test("close() is idempotent (calling twice does not throw)", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  idx.close();
  idx.close();
  assert.equal(idx.healthCheck().open, false);
});

test("re-open after close works and preserves WAL files on disk", () => {
  const idx = new SqliteIndex();
  const p = freshDbPath();
  idx.open(p);
  idx.close();
  assert.ok(fs.existsSync(p), "DB file should exist after first close");
  idx.open(p);
  try {
    assert.equal(idx.healthCheck().schemaVersion, SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

// ── Schema v1 (KAL-103) ─────────────────────────────────────────────────────
console.log("\n── Schema v1 (KAL-103) ──────────────────────────────────────────");

function tablesAndIndexesOf(idx) {
  const objects = idx.db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  ).all();
  const tables  = objects.filter(o => o.type === "table").map(o => o.name);
  const indexes = objects.filter(o => o.type === "index").map(o => o.name);
  const triggers = objects.filter(o => o.type === "trigger").map(o => o.name);
  return { tables, indexes, triggers };
}

test("fresh DB has all expected tables", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const { tables } = tablesAndIndexesOf(idx);
    for (const t of ["facts", "fact_versions", "links", "facts_fts", "meta"]) {
      assert.ok(tables.includes(t), `expected table ${t}, got ${tables.join(",")}`);
    }
  } finally {
    idx.close();
  }
});

test("fresh DB has the four facts indexes plus version/link indexes", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const { indexes } = tablesAndIndexesOf(idx);
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

test("fresh DB has the three FTS5 sync triggers", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const { triggers } = tablesAndIndexesOf(idx);
    for (const t of ["facts_ai", "facts_ad", "facts_au"]) {
      assert.ok(triggers.includes(t), `expected trigger ${t}, got ${triggers.join(",")}`);
    }
  } finally {
    idx.close();
  }
});

test("re-applying schema on an existing DB is idempotent", () => {
  const idx = new SqliteIndex();
  const p = freshDbPath();
  idx.open(p);
  try {
    // open() already applied the schema. Apply again directly — must not throw.
    applySchemaV1(idx.db);
    applySchemaV1(idx.db);
    assert.equal(idx._meta("schema_version"), SCHEMA_VERSION);
  } finally {
    idx.close();
  }
});

test("FTS5 sync triggers index inserted facts", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const now = Date.now();
    idx.db.prepare(`
      INSERT INTO facts (id, text, namespace, created_at, updated_at, jsonl_offset)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("f1", "the quick brown fox jumps over the lazy dog", "history", now, now, 0);

    const hits = idx.db.prepare(
      "SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?"
    ).all("fox");
    assert.equal(hits.length, 1, "FTS should find the row by token 'fox'");
  } finally {
    idx.close();
  }
});

test("FTS5 sync triggers reflect updates and deletes", () => {
  const idx = new SqliteIndex();
  idx.open(freshDbPath());
  try {
    const now = Date.now();
    idx.db.prepare(`
      INSERT INTO facts (id, text, namespace, created_at, updated_at, jsonl_offset)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("f1", "alpha bravo", "history", now, now, 0);

    // Update path: old token gone, new token present.
    idx.db.prepare("UPDATE facts SET text = ?, updated_at = ? WHERE id = ?")
      .run("charlie delta", now + 1, "f1");
    let alpha   = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("alpha");
    let charlie = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("charlie");
    assert.equal(alpha.length,   0, "old token 'alpha' should no longer match after update");
    assert.equal(charlie.length, 1, "new token 'charlie' should match after update");

    // Delete path: token gone entirely.
    idx.db.prepare("DELETE FROM facts WHERE id = ?").run("f1");
    charlie = idx.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("charlie");
    assert.equal(charlie.length, 0, "FTS should be empty after row delete");
  } finally {
    idx.close();
  }
});

test("applySchemaV1 can be called on a bare better-sqlite3 connection", () => {
  // KAL-104 rebuild path will use this directly on a tmp DB without
  // going through SqliteIndex.open(). Verify the contract holds.
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

// ── Cleanup + results ───────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
