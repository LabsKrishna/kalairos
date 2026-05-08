// test-sqlite-index.js — KAL-102 / KAL-103 / KAL-104 / KAL-105 unit tests
// Run: node test-sqlite-index.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const {
  SqliteIndex,
  applySchemaV1,
  rebuild,
  decideOnBoot,
  replayForward,
  SCHEMA_VERSION,
} = require("./store/sqlite-index");

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

// ── KAL-106 boot decision tree ──────────────────────────────────────────────
console.log("\n── Boot decision tree (KAL-106) ─────────────────────────────────");

// Helper: build a SQLite + JSONL pair in a known IN_SYNC state, then return
// the paths so each branch test can perturb one input and call decideOnBoot.
//
// Default n=20 so the JSONL exceeds 4 KB. The first-4-KB hash check (branch d)
// fires before the size check (branches e/g); using a tiny fixture means a
// trailing append or tail-truncation also changes the first 4 KB and fires d
// instead of the size branches. With 20 rows (~5–7 KB depending on padding)
// the first 4 KB stays stable as a prefix when only the tail changes.
async function freshInSyncPair(label, n = 20) {
  const jsonlPath  = fresh(`${label}.jsonl`);
  const sqlitePath = fresh(`${label}.sqlite`);
  writeFixtureJsonl(jsonlPath, n);
  // Sanity: confirm the fixture is large enough that the first 4 KB is just
  // a prefix. If this assertion ever fires, bump n.
  assert.ok(fs.statSync(jsonlPath).size > 4096,
    `fixture ${label} too small (${fs.statSync(jsonlPath).size}B) — bump n to keep branch e/g tests honest`);
  await rebuild({ jsonlPath, sqlitePath });
  return { jsonlPath, sqlitePath };
}

// Helper: directly mutate the meta row for a key so we can simulate the
// preconditions of the various REBUILD branches.
function setMeta(sqlitePath, key, value) {
  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    idx.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  } finally {
    idx.close();
  }
}

await test("branch (a) — SQLite missing → REBUILD", () => {
  const jsonlPath  = fresh("branch-a.jsonl");
  const sqlitePath = fresh("branch-a.sqlite"); // never created
  writeFixtureJsonl(jsonlPath, 3);
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "sqlite-missing");
});

await test("branch (b) — schema_version mismatch → REBUILD", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-b");
  setMeta(sqlitePath, "schema_version", "999");
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "schema-version-mismatch");
  assert.equal(d.actual, "999");
});

await test("branch (h) — dirty flag set → REBUILD (evaluated before c/d/e/g)", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-h");
  setMeta(sqlitePath, "dirty", "1");
  // Even with everything else aligned, dirty must short-circuit.
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "dirty-flag-set");
});

await test("branch (c) — jsonl_path mismatch → REBUILD", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-c");
  // Also create a different JSONL with the same shape so branches d/e don't fire.
  const otherJsonl = fresh("branch-c-other.jsonl");
  fs.copyFileSync(jsonlPath, otherJsonl);
  const d = decideOnBoot({ jsonlPath: otherJsonl, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "jsonl-path-mismatch");
});

await test("branch (d) — sha256-first-4kb mismatch → REBUILD", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-d");
  // Edit the start of the file (within the first 4kb hash window) without
  // changing its overall size. Branches a/b/h/c all align; only d should fire.
  const buf = fs.readFileSync(jsonlPath);
  buf[0] = buf[0] === 0x7B /* '{' */ ? 0x20 /* space */ : 0x7B;
  fs.writeFileSync(jsonlPath, buf);
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "jsonl-hash-mismatch");
});

await test("branch (e) — JSONL shrunk → REBUILD", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-e");
  // Drop the tail rows but keep enough that the first 4 KB stays unchanged —
  // otherwise branch d (hash mismatch) would fire first and we wouldn't be
  // testing branch e in isolation.
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  const kept  = lines.slice(0, lines.length - 5);
  fs.writeFileSync(jsonlPath, kept.join("\n") + "\n");
  assert.ok(fs.statSync(jsonlPath).size > 4096, "shrunk file must still exceed 4 KB to isolate branch e");
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "jsonl-shrunk");
});

await test("branch (g) — JSONL grew → REPLAY", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-g");
  // Append a valid extra line. Hash of first 4kb unchanged, size grew.
  const extraLine = JSON.stringify({
    id: 9_000_001,
    text: "external append",
    type: "text",
    memoryType: "long-term",
    workspaceId: "default",
    tags: [],
    trustScore: 0.9,
    links: [],
    versions: [{ versionId: "9000001:1", timestamp: 1_700_900_000_000 }],
  }) + "\n";
  fs.appendFileSync(jsonlPath, extraLine);
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REPLAY");
  assert.equal(d.reason, "jsonl-grew");
  assert.ok(d.sizeNow > d.metaSize);
});

await test("branch (f) — in sync → READY", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("branch-f");
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "READY");
  assert.equal(d.reason, "in-sync");
});

await test("decideOnBoot is pure — does not mutate SQLite or JSONL", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("purity");
  const sqlBefore   = fs.readFileSync(sqlitePath);
  const jsonlBefore = fs.readFileSync(jsonlPath);
  decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.ok(sqlBefore.equals(fs.readFileSync(sqlitePath)),  "SQLite should not change");
  assert.ok(jsonlBefore.equals(fs.readFileSync(jsonlPath)), "JSONL should not change");
});

await test("corrupt SQLite → REBUILD with sqlite-open-failed reason", () => {
  const jsonlPath  = fresh("corrupt.jsonl");
  const sqlitePath = fresh("corrupt.sqlite");
  writeFixtureJsonl(jsonlPath, 3);
  fs.writeFileSync(sqlitePath, "not actually a sqlite database");
  const d = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(d.action, "REBUILD");
  assert.equal(d.reason, "sqlite-open-failed");
});

// ── KAL-107 replay-forward ──────────────────────────────────────────────────
console.log("\n── Replay-forward (KAL-107) ─────────────────────────────────────");

await test("replayForward applies only the new lines, leaving prior rows untouched", async () => {
  const jsonlPath  = fresh("replay.jsonl");
  const sqlitePath = fresh("replay.sqlite");
  writeFixtureJsonl(jsonlPath, 100);
  await rebuild({ jsonlPath, sqlitePath });

  // Append 10 more rows out-of-band — the canonical "external tool wrote
  // to JSONL between sessions" scenario from §6.2 case g.
  const extras = [];
  for (let i = 100; i < 110; i++) {
    extras.push(JSON.stringify({
      id: 1_000_000 + i,
      text: `replayed-${i}`,
      type: "text",
      memoryType: "long-term",
      workspaceId: "default",
      tags: [],
      trustScore: 0.7,
      links: [],
      versions: [{ versionId: `${1_000_000 + i}:1`, timestamp: 1_700_000_000_000 + i * 1000 }],
    }));
  }
  fs.appendFileSync(jsonlPath, extras.join("\n") + "\n");

  // Decide: should be REPLAY.
  const decision = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
  assert.equal(decision.action, "REPLAY");

  // Replay.
  const result = await replayForward({ jsonlPath, sqlitePath });
  assert.equal(result.rowsApplied, 10);

  // Verify final state.
  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    const total = idx.db.prepare("SELECT COUNT(*) AS c FROM facts").get().c;
    assert.equal(total, 110, "should have all 100 original + 10 new rows");
    const lastIds = idx.db.prepare(
      "SELECT id FROM facts WHERE id >= ? ORDER BY id"
    ).all(String(1_000_100)).map(r => r.id);
    assert.deepEqual(lastIds, Array.from({ length: 10 }, (_, i) => String(1_000_100 + i)));

    // After replay, decideOnBoot should report READY.
    idx.close();
    const next = decideOnBoot({ jsonlPath, sqlitePath, quiet: true });
    assert.equal(next.action, "READY");
  } finally {
    if (idx.db) idx.close();
  }
});

// True end-to-end transactionality (BEGIN IMMEDIATE / ROLLBACK on a real
// crash mid-replay) requires fault injection that's intrusive to expose
// from test code. KAL-110's fuzz harness — which spawns a child process,
// sends SIGKILL at random points, and checks convergence on restart — owns
// that verification. Here we just structurally test the per-line skip path
// already covered by the malformed-line case below.

await test("replayForward skips malformed JSONL lines and still updates meta", async () => {
  const jsonlPath  = fresh("replay-malformed.jsonl");
  const sqlitePath = fresh("replay-malformed.sqlite");
  writeFixtureJsonl(jsonlPath, 3);
  await rebuild({ jsonlPath, sqlitePath });

  // Append: bad line, good line.
  const goodLine = JSON.stringify({
    id: 9_000_003,
    text: "good replay row",
    type: "text",
    memoryType: "long-term",
    workspaceId: "default",
    tags: [],
    trustScore: 0.7,
    links: [],
    versions: [{ versionId: "9000003:1", timestamp: 1_700_999_999_999 }],
  });
  fs.appendFileSync(jsonlPath, "{ broken json\n" + goodLine + "\n");

  const origWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await replayForward({ jsonlPath, sqlitePath });
  } finally {
    console.warn = origWarn;
  }

  assert.equal(result.rowsApplied, 1, "only the good line should apply");
  const idx = new SqliteIndex();
  idx.open(sqlitePath);
  try {
    const c = idx.db.prepare("SELECT COUNT(*) AS c FROM facts").get().c;
    assert.equal(c, 4, "3 original + 1 newly replayed");
    assert.equal(idx._meta("last_jsonl_offset"), String(fs.statSync(jsonlPath).size));
  } finally {
    idx.close();
  }
});

await test("replayForward is a no-op when JSONL hasn't grown", async () => {
  const { jsonlPath, sqlitePath } = await freshInSyncPair("replay-noop");
  const before = dumpLogical(sqlitePath);
  const result = await replayForward({ jsonlPath, sqlitePath });
  assert.equal(result.rowsApplied, 0);
  const after = dumpLogical(sqlitePath);
  assert.equal(after, before, "no-op replay should not touch the index");
});

// ── Cleanup + results ───────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);

})();
