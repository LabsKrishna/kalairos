// test-entity-normalizer.js — store/entity-normalizer.js unit tests
// Run: node tests/test-entity-normalizer.js
"use strict";

const assert = require("assert/strict");

const {
  defaultTrustScore,
  normalizeClassification,
  normalizeRetention,
  normalizeMemoryType,
  normalizeWorkspaceId,
  makeVersionId,
  normalizeRaw,
} = require("../store/entity-normalizer");

// ─── Minimal test runner (mirrors test-basic.js / test-sqlite-index.js) ───────
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

(async () => {

// ── defaultTrustScore ───────────────────────────────────────────────────────
console.log("\n── defaultTrustScore ─────────────────────────────────────────────");

await test("returns the documented default for each known source type", () => {
  assert.equal(defaultTrustScore("user"),   0.90);
  assert.equal(defaultTrustScore("agent"),  0.75);
  assert.equal(defaultTrustScore("tool"),   0.80);
  assert.equal(defaultTrustScore("file"),   0.70);
  assert.equal(defaultTrustScore("system"), 0.60);
});

await test("falls back to 0.70 for an unknown source type", () => {
  assert.equal(defaultTrustScore("bogus"), 0.70);
});

await test("falls back to 0.70 for undefined/empty input", () => {
  assert.equal(defaultTrustScore(undefined), 0.70);
  assert.equal(defaultTrustScore(""), 0.70);
});

// ── normalizeClassification ─────────────────────────────────────────────────
console.log("\n── normalizeClassification ───────────────────────────────────────");

await test("empty/falsy input defaults to 'internal'", () => {
  assert.equal(normalizeClassification(""), "internal");
  assert.equal(normalizeClassification(null), "internal");
  assert.equal(normalizeClassification(undefined), "internal");
  assert.equal(normalizeClassification(0), "internal");
});

await test("whitespace-only input defaults to 'internal'", () => {
  assert.equal(normalizeClassification("   "), "internal");
  assert.equal(normalizeClassification("\t\n"), "internal");
});

await test("trims and lowercases mixed-case input", () => {
  assert.equal(normalizeClassification("  Confidential  "), "confidential");
  assert.equal(normalizeClassification("REGULATED"), "regulated");
});

await test("preserves unicode content through trim/lowercase", () => {
  assert.equal(normalizeClassification("  Confidential — 機密  "), "confidential — 機密");
});

// ── normalizeRetention ──────────────────────────────────────────────────────
console.log("\n── normalizeRetention ────────────────────────────────────────────");

await test("null/undefined default to { policy: 'keep', expiresAt: null }", () => {
  assert.deepEqual(normalizeRetention(null),      { policy: "keep", expiresAt: null });
  assert.deepEqual(normalizeRetention(undefined), { policy: "keep", expiresAt: null });
});

await test("non-object input (string, number) also defaults", () => {
  assert.deepEqual(normalizeRetention("purge"), { policy: "keep", expiresAt: null });
  assert.deepEqual(normalizeRetention(42),      { policy: "keep", expiresAt: null });
});

await test("an array is typeof 'object' and passes through as a default-shaped policy", () => {
  // Arrays are truthy and typeof "object", so they take the object branch;
  // array.policy/.expiresAt are both undefined, so the result is still the
  // default shape. Documents the actual (slightly surprising) behavior.
  assert.deepEqual(normalizeRetention([1, 2, 3]), { policy: "keep", expiresAt: null });
});

await test("normalizes policy casing/whitespace and preserves a finite expiresAt", () => {
  assert.deepEqual(
    normalizeRetention({ policy: "  Purge  ", expiresAt: 123456 }),
    { policy: "purge", expiresAt: 123456 }
  );
});

await test("non-finite expiresAt (NaN, Infinity, missing) normalizes to null", () => {
  assert.equal(normalizeRetention({ expiresAt: NaN }).expiresAt, null);
  assert.equal(normalizeRetention({ expiresAt: Infinity }).expiresAt, null);
  assert.equal(normalizeRetention({}).expiresAt, null);
});

// ── normalizeMemoryType ─────────────────────────────────────────────────────
console.log("\n── normalizeMemoryType ───────────────────────────────────────────");

await test("accepts each of the three valid memory types", () => {
  assert.equal(normalizeMemoryType("short-term"), "short-term");
  assert.equal(normalizeMemoryType("long-term"),  "long-term");
  assert.equal(normalizeMemoryType("working"),    "working");
});

await test("is case/whitespace-insensitive for valid types", () => {
  assert.equal(normalizeMemoryType("  Working  "), "working");
  assert.equal(normalizeMemoryType("SHORT-TERM"), "short-term");
});

await test("falls back to 'long-term' for empty or unrecognized input", () => {
  assert.equal(normalizeMemoryType(""), "long-term");
  assert.equal(normalizeMemoryType(null), "long-term");
  assert.equal(normalizeMemoryType("bogus"), "long-term");
});

// ── normalizeWorkspaceId ────────────────────────────────────────────────────
console.log("\n── normalizeWorkspaceId ──────────────────────────────────────────");

await test("empty/falsy input defaults to 'default'", () => {
  assert.equal(normalizeWorkspaceId(""), "default");
  assert.equal(normalizeWorkspaceId(null), "default");
  assert.equal(normalizeWorkspaceId(undefined), "default");
});

await test("whitespace-only input defaults to 'default'", () => {
  assert.equal(normalizeWorkspaceId("   "), "default");
});

await test("trims but does not lowercase (workspace IDs are case-sensitive)", () => {
  assert.equal(normalizeWorkspaceId("  Team-Legal  "), "Team-Legal");
});

await test("preserves unicode workspace IDs", () => {
  assert.equal(normalizeWorkspaceId("  日本語ワークスペース  "), "日本語ワークスペース");
});

// ── makeVersionId ────────────────────────────────────────────────────────────
console.log("\n── makeVersionId ─────────────────────────────────────────────────");

await test("formats as `${entityId}:${ordinal}`", () => {
  assert.equal(makeVersionId(123, 1), "123:1");
  assert.equal(makeVersionId("abc", 2), "abc:2");
});

await test("is deterministic — same input always produces the same output", () => {
  const calls = Array.from({ length: 20 }, () => makeVersionId(42, 7));
  assert.ok(calls.every(v => v === "42:7"), "every call with identical args must match");
});

await test("distinguishes ordinals and entity ids independently", () => {
  assert.notEqual(makeVersionId(1, 1), makeVersionId(1, 2));
  assert.notEqual(makeVersionId(1, 1), makeVersionId(2, 1));
});

await test("handles ordinal 0 and unicode entity ids without special-casing", () => {
  assert.equal(makeVersionId(5, 0), "5:0");
  assert.equal(makeVersionId("実体-7", 3), "実体-7:3");
});

// ── normalizeRaw — bare defaults ────────────────────────────────────────────
console.log("\n── normalizeRaw: defaults on minimal/empty input ─────────────────");

await test("an entirely empty object gets every default field", () => {
  const out = normalizeRaw({});
  assert.equal(out.type, "text");
  assert.deepEqual(out.metadata, {});
  assert.deepEqual(out.tags, []);
  assert.ok(out.links instanceof Set);
  assert.equal(out.links.size, 0);
  assert.deepEqual(out.versions, []);
  assert.deepEqual(out.source, { type: "user" });
  assert.equal(out.classification, "internal");
  assert.deepEqual(out.retention, { policy: "keep", expiresAt: null });
  assert.equal(out.deletedAt, null);
  assert.equal(out.deletedBy, null);
  assert.equal(out.memoryType, "long-term");
  assert.equal(out.workspaceId, "default");
  assert.deepEqual(out.llmKeywords, []);
  assert.equal(out.importance, null);
  assert.equal(out.trustScore, 0.90); // default source is "user" → 0.90
  assert.equal(out.contentRisk, null);
  assert.deepEqual(out.trailEvents, []);
});

await test("mutates the input object in place and returns the same reference", () => {
  const raw = { id: 1, text: "hello" };
  const out = normalizeRaw(raw);
  assert.equal(out, raw, "normalizeRaw must return the same object it was given");
  assert.equal(raw.type, "text", "the original object should itself be mutated");
});

await test("existing links array is converted to a deduplicated Set", () => {
  const out = normalizeRaw({ id: 1, links: [1, 1, 2, 3, 3, 3] });
  assert.deepEqual([...out.links].sort(), [1, 2, 3]);
});

// ── normalizeRaw — blank/whitespace text and tags ───────────────────────────
console.log("\n── normalizeRaw: blank input on optional fields ──────────────────");

await test("empty string text is left as-is (not replaced with a default)", () => {
  // Only `type`/`tags`/`metadata`/`links`/`versions` get falsy-based defaults;
  // `text` itself passes through untouched.
  const out = normalizeRaw({ id: 1, text: "" });
  assert.equal(out.text, "");
});

await test("empty tags array stays empty; falsy tags become []", () => {
  assert.deepEqual(normalizeRaw({ id: 1, tags: [] }).tags, []);
  assert.deepEqual(normalizeRaw({ id: 1, tags: null }).tags, []);
});

// ── normalizeRaw — zero is not "missing" ────────────────────────────────────
console.log("\n── normalizeRaw: 0 is a real value, not treated as absent ────────");

await test("explicit 0 for contentRisk/importance/trustScore is preserved, not defaulted", () => {
  const out = normalizeRaw({ id: 1, versions: [], contentRisk: 0, importance: 0, trustScore: 0 });
  assert.equal(out.contentRisk, 0, "contentRisk=0 (assessed-clean) must not become null");
  assert.equal(out.importance, 0);
  assert.equal(out.trustScore, 0);
});

await test("missing contentRisk/importance backfill to null, not 0", () => {
  const out = normalizeRaw({ id: 1, versions: [] });
  assert.equal(out.contentRisk, null);
  assert.equal(out.importance, null);
});

// ── normalizeRaw — llmKeywords ──────────────────────────────────────────────
console.log("\n── normalizeRaw: llmKeywords backfill ─────────────────────────────");

await test("pulls llmKeywords from metadata.llm.keywords when missing", () => {
  const out = normalizeRaw({ id: 1, versions: [], metadata: { llm: { keywords: ["alpha", "beta"] } } });
  assert.deepEqual(out.llmKeywords, ["alpha", "beta"]);
});

await test("defaults llmKeywords to [] when neither field is present", () => {
  const out = normalizeRaw({ id: 1, versions: [] });
  assert.deepEqual(out.llmKeywords, []);
});

await test("an existing llmKeywords array is left untouched, even if metadata disagrees", () => {
  const out = normalizeRaw({
    id: 1, versions: [],
    llmKeywords: ["preset"],
    metadata: { llm: { keywords: ["other"] } },
  });
  assert.deepEqual(out.llmKeywords, ["preset"]);
});

// ── normalizeRaw — source/classification inheritance from versions ─────────
console.log("\n── normalizeRaw: source/classification inherited from versions ───");

await test("raw.source/classification fall back to the first version that carries them", () => {
  const out = normalizeRaw({
    id: 1,
    versions: [
      { timestamp: 200 },
      { timestamp: 100, source: { type: "file" }, classification: "confidential" },
    ],
  });
  assert.deepEqual(out.source, { type: "file" });
  assert.equal(out.classification, "confidential");
  // trustScore should follow the inherited source type's default.
  assert.equal(out.trustScore, defaultTrustScore("file"));
});

await test("every version without its own source inherits raw.source after normalization", () => {
  const out = normalizeRaw({
    id: 1,
    source: { type: "tool" },
    versions: [{ timestamp: 1 }, { timestamp: 2 }],
  });
  for (const v of out.versions) assert.deepEqual(v.source, { type: "tool" });
});

// ── normalizeRaw — deletedAt / soft delete ──────────────────────────────────
console.log("\n── normalizeRaw: soft-delete (deletedAt) handling ─────────────────");

await test("no deletedAt → deletedAt/deletedBy both stay null", () => {
  const out = normalizeRaw({ id: 1, versions: [] });
  assert.equal(out.deletedAt, null);
  assert.equal(out.deletedBy, null);
});

await test("deletedAt is coerced to a Number and deletedBy defaults to null", () => {
  const out = normalizeRaw({ id: 1, versions: [{ timestamp: 1 }], deletedAt: "555" });
  assert.equal(out.deletedAt, 555);
  assert.equal(out.deletedBy, null);
});

await test("a positive deletedAt closes the latest version's open validTo", () => {
  const out = normalizeRaw({ id: 1, versions: [{ timestamp: 500 }], deletedAt: 999 });
  assert.equal(out.versions[0].validTo, 999);
});

await test("deletedAt does not override a validTo the version already had", () => {
  const out = normalizeRaw({
    id: 1,
    versions: [{ timestamp: 500, validTo: 700 }],
    deletedAt: 999,
  });
  assert.equal(out.versions[0].validTo, 700, "explicit validTo must win over deletedAt backfill");
});

await test("BUGFIX: deletedAt=0 (a legitimate epoch timestamp) still closes validTo", () => {
  // Regression test for a truthy-check bug: `if (raw.deletedAt && ...)` treated
  // deletedAt=0 as "not deleted" and left validTo open. Fixed to `!== null`.
  const out = normalizeRaw({ id: 1, versions: [{ timestamp: 100 }], deletedAt: 0 });
  assert.equal(out.deletedAt, 0, "deletedAt itself must be preserved as 0, not defaulted");
  assert.equal(out.versions[0].validTo, 0, "validTo must be closed at deletedAt=0, not left open");
});

// ── normalizeRaw — version chain backfill (single version) ─────────────────
console.log("\n── normalizeRaw: version chain backfill (single version) ─────────");

await test("a lone legacy version gets versionId/ingestAt/effectiveAt/validFrom/action synthesized", () => {
  const out = normalizeRaw({ id: 77, versions: [{ timestamp: 1000 }] });
  const v = out.versions[0];
  assert.equal(v.versionId, "77:1");
  assert.equal(v.ingestAt, 1000);
  assert.equal(v.effectiveAt, 1000);
  assert.equal(v.validFrom, 1000);
  assert.equal(v.validTo, null, "the only (latest) version stays open-ended");
  assert.equal(v.previousVersionId, null);
  assert.equal(v.who, null);
  assert.equal(v.why, null);
  assert.equal(v.action, "remembered", "first-ever version synthesizes to 'remembered'");
});

// ── normalizeRaw — version chain backfill (multi-version) ──────────────────
console.log("\n── normalizeRaw: version chain backfill (multi-version) ──────────");

await test("a 3-version chain gets correctly linked previousVersionId and closed validTo", () => {
  const out = normalizeRaw({
    id: 20,
    versions: [
      { timestamp: 300 }, // newest
      { timestamp: 200 },
      { timestamp: 100 }, // oldest
    ],
  });
  const [v3, v2, v1] = out.versions; // still newest-first in the output array

  assert.equal(v1.versionId, "20:1");
  assert.equal(v2.versionId, "20:2");
  assert.equal(v3.versionId, "20:3");

  assert.equal(v1.previousVersionId, null);
  assert.equal(v2.previousVersionId, "20:1");
  assert.equal(v3.previousVersionId, "20:2");

  // Each closed version's validTo is the next version's effectiveAt.
  assert.equal(v1.validTo, 200);
  assert.equal(v2.validTo, 300);
  assert.equal(v3.validTo, null, "latest version stays open");

  assert.equal(v1.action, "remembered");
  assert.equal(v2.action, "superseded");
  assert.equal(v3.action, "superseded");
});

await test("validTo backfill uses the next version's effectiveAt, not its timestamp, when they differ", () => {
  const out = normalizeRaw({
    id: 21,
    versions: [
      { timestamp: 300, effectiveAt: 310 }, // newest — explicit effectiveAt differs from timestamp
      { timestamp: 200 },                    // oldest
    ],
  });
  const [, vOldest] = out.versions; // still newest-first: index 1 is the older one
  assert.equal(vOldest.validTo, 310, "validTo must follow the closing version's effectiveAt, not its timestamp");
});

await test("a delta.type of 'correction' synthesizes the 'corrected' action", () => {
  const out = normalizeRaw({
    id: 22,
    versions: [
      { timestamp: 200, delta: { type: "correction" } },
      { timestamp: 100 },
    ],
  });
  assert.equal(out.versions[0].action, "corrected");
  assert.equal(out.versions[1].action, "remembered");
});

await test("existing fields on a version are never overwritten by the backfill", () => {
  const out = normalizeRaw({
    id: 23,
    versions: [{
      timestamp: 300,
      versionId: "custom:1",
      ingestAt: 1,
      effectiveAt: 2,
      validFrom: 3,
      validTo: 4,
      previousVersionId: "prev-custom",
      who: "alice",
      why: "manual correction",
      action: "contested",
    }],
  });
  const v = out.versions[0];
  assert.equal(v.versionId, "custom:1");
  assert.equal(v.ingestAt, 1);
  assert.equal(v.effectiveAt, 2);
  assert.equal(v.validFrom, 3);
  assert.equal(v.validTo, 4);
  assert.equal(v.previousVersionId, "prev-custom");
  assert.equal(v.who, "alice");
  assert.equal(v.why, "manual correction");
  assert.equal(v.action, "contested");
});

await test("linkIds defaults to [] per version when not already an array", () => {
  // Newest-first input (timestamps descending) so the oldest-first migration
  // check doesn't reorder these before the assertions below.
  const out = normalizeRaw({ id: 24, versions: [{ timestamp: 2, linkIds: [5, 6] }, { timestamp: 1 }] });
  assert.deepEqual(out.versions[0].linkIds, [5, 6]);
  assert.deepEqual(out.versions[1].linkIds, []);
});

await test("each version's classification falls back to the entity's classification", () => {
  const out = normalizeRaw({
    id: 25,
    classification: "regulated",
    versions: [{ timestamp: 2, classification: "  Public  " }, { timestamp: 1 }],
  });
  assert.equal(out.versions[0].classification, "public");
  assert.equal(out.versions[1].classification, "regulated");
});

// ── normalizeRaw — legacy oldest-first migration ────────────────────────────
console.log("\n── normalizeRaw: legacy oldest-first version array is reversed ───");

await test("an oldest-first versions array is detected and reversed to newest-first", () => {
  const out = normalizeRaw({
    id: 30,
    versions: [{ timestamp: 100 }, { timestamp: 200 }], // oldest-first input
  });
  assert.deepEqual(out.versions.map(v => v.timestamp), [200, 100], "must end up newest-first");
});

await test("an already newest-first versions array is left in order", () => {
  const out = normalizeRaw({
    id: 31,
    versions: [{ timestamp: 200 }, { timestamp: 100 }], // already newest-first
  });
  assert.deepEqual(out.versions.map(v => v.timestamp), [200, 100]);
});

await test("equal-timestamp versions are not reversed (strict < only)", () => {
  const out = normalizeRaw({
    id: 32,
    versions: [{ timestamp: 100, note: "first" }, { timestamp: 100, note: "second" }],
  });
  assert.deepEqual(out.versions.map(v => v.note), ["first", "second"]);
});

await test("a single-element versions array is untouched by the reversal check", () => {
  const out = normalizeRaw({ id: 33, versions: [{ timestamp: 100 }] });
  assert.equal(out.versions.length, 1);
});

// ── normalizeRaw — unicode ──────────────────────────────────────────────────
console.log("\n── normalizeRaw: unicode content passes through intact ───────────");

await test("unicode text, tags, and workspaceId survive normalization", () => {
  const out = normalizeRaw({
    id: 40,
    text: "こんにちは世界 🎉",
    tags: ["日本語", "emoji🔥"],
    workspaceId: "  日本語ワークスペース  ",
    versions: [],
  });
  assert.equal(out.text, "こんにちは世界 🎉");
  assert.deepEqual(out.tags, ["日本語", "emoji🔥"]);
  assert.equal(out.workspaceId, "日本語ワークスペース");
});

// ── normalizeRaw — determinism ──────────────────────────────────────────────
console.log("\n── normalizeRaw: determinism ──────────────────────────────────────");

await test("normalizing two structurally-identical (but distinct) raw objects yields identical results", () => {
  const build = () => ({
    id: 99,
    text: "duplicate content",
    tags: ["x", "y"],
    versions: [{ timestamp: 1000 }, { timestamp: 500 }],
  });
  const outA = normalizeRaw(build());
  const outB = normalizeRaw(build());

  // Sets don't compare structurally with deepEqual/JSON.stringify; compare
  // everything else, plus the links contents explicitly.
  const strip = (o) => { const { links, ...rest } = o; return rest; };
  assert.deepEqual(strip(outA), strip(outB));
  assert.deepEqual([...outA.links], [...outB.links]);
});

await test("re-running normalizeRaw on an already-normalized entity is idempotent", () => {
  const raw = { id: 100, text: "idempotent check", versions: [{ timestamp: 1 }, { timestamp: 2 }] };
  const once  = normalizeRaw(raw);
  const dump1 = JSON.stringify({ ...once, links: [...once.links] });
  const twice = normalizeRaw(once); // same object, ran again
  const dump2 = JSON.stringify({ ...twice, links: [...twice.links] });
  assert.equal(dump1, dump2, "a second pass over already-normalized data must not change it");
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
const total = passed + failed;
console.log(`  ${passed}/${total} passed${failed ? `  (${failed} failed)` : " ✅"}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);

})();
