// test-markdown-trail.js — markdown export/import round-trip + trail/checkpoint
// Run: node tests/test-markdown-trail.js
//
// Covers the two read-side surfaces extracted out of index.js: markdown.js
// (human-readable export/import, §5 Stage-1 feature) and trail.js (the
// observability projection + checkpoint filtering, §11.7). Tests run through
// the public API where possible; pure-helper edge branches are hit directly.
"use strict";

const assert = require("assert/strict");
const lib    = require("../index");
const { entityToMarkdownLines, renderExport, parseMarkdownFacts } = require("../markdown");
const { matchesWho, normalizeCheckpointFilter, applyCheckpointFilter, collectTrailEvents } = require("../trail");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}\n       ${e.message}`); failed++; }
}

// Bag-of-words mock embedder (digit-stripping, same trick as the supersession
// test: reworded numbers embed identically so updates merge into versions).
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

(async () => {
  console.log("\n── markdown.js pure helpers ─────────────────────────────────────");

  await test("parseMarkdownFacts: empty / whitespace input → mode empty", () => {
    assert.deepEqual(parseMarkdownFacts(""),      { mode: "empty", facts: [] });
    assert.deepEqual(parseMarkdownFacts("   \n"), { mode: "empty", facts: [] });
    assert.deepEqual(parseMarkdownFacts(null),    { mode: "empty", facts: [] });
  });

  await test("parseMarkdownFacts: bullet and plain lines → mode bullets", () => {
    const { mode, facts } = parseMarkdownFacts("- first fact\n* second fact\nthird plain\n# heading skipped\n> quote skipped");
    assert.equal(mode, "bullets");
    assert.deepEqual(facts.map(f => f.text), ["first fact", "second fact", "third plain"]);
  });

  await test("parseMarkdownFacts: structured sections strip metadata/history lines", () => {
    const md = [
      "## [42] FACT",
      "",
      "The API limit is 100 rpm",
      "",
      "- **ID:** 42",
      "### Version History",
      "> old text",
      "---",
    ].join("\n");
    const { mode, facts } = parseMarkdownFacts(md);
    assert.equal(mode, "structured");
    assert.deepEqual(facts, [{ type: "fact", text: "The API limit is 100 rpm" }]);
  });

  await test("parseMarkdownFacts: structured section with no body is skipped", () => {
    const { facts } = parseMarkdownFacts("## [1] TEXT\n- **ID:** 1\n\n## [2] FACT\nreal body");
    assert.deepEqual(facts, [{ type: "fact", text: "real body" }]);
  });

  await test("entityToMarkdownLines: version history renders with changed-text quote", () => {
    const now = Date.now();
    const e = {
      id: 7, type: "fact", text: "new text", tags: ["a"], createdAt: now, updatedAt: now,
      source: { type: "tool", actor: "bot" },
      versions: [ // stored newest-first
        { timestamp: now,     text: "new text", delta: { type: "update", summary: "value changed" } },
        { timestamp: now - 5, text: "old text" },
      ],
    };
    const out = entityToMarkdownLines(e, { includeHistory: true }).join("\n");
    assert.ok(out.includes("### Version History"), "history section missing");
    assert.ok(out.includes("(initial)"), "initial marker missing");
    assert.ok(out.includes("[update] value changed"), "delta summary missing");
    assert.ok(out.includes("> old text"), "changed-text quote missing");
    assert.ok(out.includes("Source:** tool (bot)"), "source actor missing");
  });

  console.log("\n── markdown export/import through the public API ────────────────");
  await lib.init(INIT_OPTS);

  const factId = await lib.ingest("The deploy pipeline requires manual approval",
    { type: "fact", tags: ["ops"], workspaceId: "w1", who: { agent: "agent-1" } });
  await lib.ingest("The deploy pipeline requires manual approval from two reviewers",
    { type: "fact", tags: ["ops"], workspaceId: "w1", who: { agent: "agent-1" }, why: "policy tightened" });
  const noteId = await lib.ingest("Retro notes live in the shared drive",
    { type: "text", tags: ["docs"], workspaceId: "w2", who: { agent: "agent-2" } });

  let exported;
  await test("exportMarkdown renders every alive entity with metadata", async () => {
    exported = await lib.exportMarkdown();
    assert.ok(exported.startsWith("# Kalairos — Memory Export"));
    assert.ok(exported.includes(`## [${factId}] FACT`));
    assert.ok(exported.includes(`## [${noteId}] TEXT`));
    assert.ok(exported.includes("**Workspace:** w2"));
  });

  await test("exportMarkdown honors includeHistory and filter", async () => {
    const withHistory = await lib.exportMarkdown({ includeHistory: true });
    assert.ok(withHistory.includes("### Version History"), "versioned fact must render history");
    const onlyText = await lib.exportMarkdown({ filter: { type: "text" } });
    assert.ok(!onlyText.includes(`## [${factId}]`), "type filter must exclude facts");
    assert.ok(onlyText.includes(`## [${noteId}]`));
  });

  await test("exportMarkdown respects allowedWorkspaces", async () => {
    const w2only = await lib.exportMarkdown({ allowedWorkspaces: ["w2"] });
    assert.ok(!w2only.includes(`## [${factId}]`));
    assert.ok(w2only.includes(`## [${noteId}]`));
  });

  await test("importMarkdown round-trips a structured export into a fresh store", async () => {
    await lib.shutdown();
    await lib.init(INIT_OPTS);
    const { imported, ids } = await lib.importMarkdown(exported, { source: { type: "file", uri: "export.md" } });
    assert.equal(imported, 2, "both sections must import");
    const back = await lib.get(ids[0]);
    assert.ok(back.text.length > 0);
  });

  await test("importMarkdown ingests bullet lists with caller defaults", async () => {
    const { imported, ids } = await lib.importMarkdown("- alpha bullet point memo\n- beta bullet point memo",
      { tags: ["imported"], workspaceId: "w3" });
    assert.equal(imported, 2);
    const e = await lib.get(ids[0]);
    assert.deepEqual(e.tags, ["imported"]);
    assert.equal(e.workspaceId, "w3");
  });

  await test("importMarkdown of empty text is a no-op", async () => {
    assert.deepEqual(await lib.importMarkdown("   "), { imported: 0, ids: [] });
  });

  console.log("\n── trail() projection ───────────────────────────────────────────");
  await lib.shutdown();
  await lib.init(INIT_OPTS);

  const before = Date.now() - 1;
  const aId = await lib.ingest("Service A owns the billing queue",
    { type: "fact", tags: ["billing"], workspaceId: "wa", who: { agent: "agent-a" } });
  await lib.ingest("Service A owns the billing queue and the refund queue",
    { type: "fact", tags: ["billing"], workspaceId: "wa", who: { agent: "agent-a" }, why: "scope grew" });
  const bId = await lib.ingest("Service B owns notifications",
    { type: "fact", tags: ["notify"], workspaceId: "wb", who: { user: "biraj" } });

  await test("trail returns all events sorted by ingestAt", async () => {
    const events = await lib.trail();
    assert.ok(events.length >= 3, `expected >= 3 events, got ${events.length}`);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].ingestAt >= events[i - 1].ingestAt, "must be ascending");
    }
    assert.ok(events.some(ev => ev.action === "remembered"));
  });

  await test("trail filters by entity, workspace, who, action, window, limit", async () => {
    const forA = await lib.trail({ entity: aId });
    assert.ok(forA.length >= 2 && forA.every(ev => ev.entityId === aId));

    const wb = await lib.trail({ workspace: "wb" });
    assert.ok(wb.length >= 1 && wb.every(ev => ev.entityId === bId));

    const byAgent = await lib.trail({ who: { agent: "agent-a" } });
    assert.ok(byAgent.length >= 2 && byAgent.every(ev => ev.who?.agent === "agent-a"));

    const created = await lib.trail({ action: "remembered" });
    assert.ok(created.every(ev => ev.action === "remembered"));

    const windowed = await lib.trail({ since: before, until: Date.now() + 1000 });
    assert.ok(windowed.length >= 3);
    assert.deepEqual(await lib.trail({ since: Date.now() + 60_000 }), []);

    const limited = await lib.trail({ limit: 2 });
    assert.equal(limited.length, 2);
  });

  await test("trail rejects unknown action filters", async () => {
    await assert.rejects(() => lib.trail({ action: "exploded" }), /Unknown action/);
  });

  console.log("\n── checkpoints ──────────────────────────────────────────────────");

  await test("frozen checkpoint captures events at creation and never moves", async () => {
    const cp = await lib.checkpoint("audit-a", { entity: aId, why: "quarterly audit" });
    assert.equal(cp.frozen, true);
    assert.ok(cp.eventIds.length >= 2, "must snapshot entity A's events");
    assert.equal(cp.why, "quarterly audit");

    const snapshotLen = (await lib.trail({ checkpoint: "audit-a" })).length;
    await lib.ingest("Service A owns the billing queue, refunds, and disputes",
      { type: "fact", tags: ["billing"], workspaceId: "wa", who: { agent: "agent-a" } });
    const afterLen = (await lib.trail({ checkpoint: "audit-a" })).length;
    assert.equal(afterLen, snapshotLen, "frozen checkpoint must not absorb later events");
  });

  await test("live checkpoint re-evaluates its filter on read", async () => {
    await lib.checkpoint("live-billing", { live: true, tags: ["billing"] });
    const lenBefore = (await lib.trail({ checkpoint: "live-billing" })).length;
    await lib.ingest("Billing dashboard refresh cadence is hourly",
      { type: "fact", tags: ["billing"], workspaceId: "wa" });
    const lenAfter = (await lib.trail({ checkpoint: "live-billing" })).length;
    assert.ok(lenAfter > lenBefore, "live checkpoint must see new matching events");
  });

  await test("checkpoint validation: empty name, duplicate name, bad during", async () => {
    await assert.rejects(() => lib.checkpoint("  "), /name is required/);
    await assert.rejects(() => lib.checkpoint("audit-a", { entity: aId }), /already exists/);
    await assert.rejects(() => lib.checkpoint("bad-during", { during: "yesterday" }), /\[from, to\] pair/);
  });

  await test("getCheckpoint / listCheckpoints / unknown checkpoint in trail", async () => {
    const cp = await lib.getCheckpoint("audit-a");
    assert.equal(cp.name, "audit-a");
    assert.equal(await lib.getCheckpoint("nope"), null);

    await lib.checkpoint("scoped", { workspace: "wb", action: "remembered" });
    const scoped = await lib.listCheckpoints({ workspace: "wb" });
    assert.deepEqual(scoped.map(c => c.name), ["scoped"]);
    assert.ok((await lib.listCheckpoints()).length >= 3);

    await assert.rejects(() => lib.trail({ checkpoint: "ghost" }), /checkpoint:ghost/);
  });

  console.log("\n── trail.js pure helper edges ───────────────────────────────────");

  await test("matchesWho branch coverage", () => {
    assert.equal(matchesWho(null, null), true);                                  // no filter
    assert.equal(matchesWho(null, { agent: "a" }), false);                       // filter, no who
    assert.equal(matchesWho({ agent: "a" }, { agent: "b" }), false);             // agent mismatch
    assert.equal(matchesWho({ agent: "a", user: "u" }, { user: "x" }), false);   // user mismatch
    assert.equal(matchesWho({ agent: "a", user: "u" }, { agent: "a", user: "u" }), true);
  });

  await test("normalizeCheckpointFilter shapes scalars and arrays", () => {
    const ts = v => Number(v);
    const f = normalizeCheckpointFilter(
      { during: [1, 2], entity: "5", tags: ["x"], workspace: "w", action: "remembered" }, ts);
    assert.deepEqual(f, { during: [1, 2], entity: [5], tags: ["x"], workspace: "w", action: ["remembered"] });
    const g = normalizeCheckpointFilter({ entity: [1, "2"], action: ["a", "b"] }, ts);
    assert.deepEqual(g.entity, [1, 2]);
    assert.deepEqual(g.action, ["a", "b"]);
  });

  await test("applyCheckpointFilter: tags/workspace need the entity lookup", () => {
    const events = [
      { entityId: 1, versionId: "v1", action: "remembered", ingestAt: 10 },
      { entityId: 2, versionId: "v2", action: "updated", ingestAt: 20 },
    ];
    const byId = id => ({ 1: { tags: ["keep"], workspaceId: "w1" }, 2: { tags: [], workspaceId: "w2" } }[id]);
    assert.deepEqual(applyCheckpointFilter(events, { tags: ["keep"] }, byId).map(e => e.versionId), ["v1"]);
    assert.deepEqual(applyCheckpointFilter(events, { workspace: "w2" }, byId).map(e => e.versionId), ["v2"]);
    // Default lookup returns undefined → tag/workspace filters drop everything.
    assert.deepEqual(applyCheckpointFilter(events, { tags: ["keep"] }), []);
    assert.deepEqual(applyCheckpointFilter(events, { during: [15, 25] }).map(e => e.versionId), ["v2"]);
    assert.deepEqual(applyCheckpointFilter(events, { action: ["updated"] }).map(e => e.versionId), ["v2"]);
  });

  await test("collectTrailEvents merges versions and metadata trail events", () => {
    const entity = {
      id: 9, source: { type: "user" },
      versions: [{ versionId: "v2", action: "superseded", timestamp: 20 }, { versionId: "v1", action: "remembered", timestamp: 10 }],
      trailEvents: [{ entityId: 9, versionId: null, action: "contested", ingestAt: 30 }],
    };
    const out = collectTrailEvents(entity);
    assert.deepEqual(out.map(e => e.action), ["remembered", "superseded", "contested"]);
    assert.equal(out[0].ingestAt, 10, "version timestamp fallback must fill ingestAt");
  });

  await test("renderExport counts entities in the banner", () => {
    const doc = renderExport([], {});
    assert.ok(doc.includes("Exported 0 entities"));
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await lib.shutdown();
  process.exit(failed === 0 ? 0 : 1);
})();
