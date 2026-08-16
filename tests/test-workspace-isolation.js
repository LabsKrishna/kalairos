// test-workspace-isolation.js — Verifies that ingest() never merges a write
// into an entity belonging to another workspace.
//
// The merge scan runs *before* any read check, so `allowedWorkspaces` (which
// gates reads) cannot protect it: two tenants writing similar text used to
// collapse into a single shared entity. That is cross-tenant fact corruption
// (§15 threat 3), so it is asserted here rather than left to review.
// Run: node test-workspace-isolation.js
"use strict";

const assert = require("assert/strict");
const lib = require("../index");

function makeMockEmbedder(dim = 64) {
  const vocab = new Map();
  return async (text) => {
    const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
    const vec = new Array(dim).fill(0);
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
      vec[vocab.get(w) % dim]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

const INIT_OPTS = {
  dataFile: ":memory:",
  embeddingDim: 64,
  embedFn: makeMockEmbedder(64),
  linkThreshold: 0.72,
  versionThreshold: 0.82,
  consolidationThreshold: 0.70,
  minFinalScore: 0.20,
};

(async () => {
  console.log("\n=== workspace isolation on ingest() ===\n");

  await lib.init(INIT_OPTS);

  // ── 1. Identical text in two workspaces stays two entities ────────────────
  // Identical text scores cosine 1.0 — the strongest possible merge signal.
  // If workspace isolation holds at all, it holds here.
  const text = "The deployment target for the platform is Render";
  const alice = await lib.ingest(text, { workspaceId: "alice", allowedWorkspaces: ["alice"] });
  const bob = await lib.ingest(text, { workspaceId: "bob", allowedWorkspaces: ["bob"] });

  assert.notStrictEqual(alice, bob,
    "identical text in different workspaces must not merge into one entity");
  console.log("  [ok] identical text in two workspaces produces two entities");

  // ── 2. Neither entity leaked the other's workspace ────────────────────────
  const aliceEntity = await lib.get(alice, { allowedWorkspaces: ["alice"] });
  const bobEntity = await lib.get(bob, { allowedWorkspaces: ["bob"] });
  assert.strictEqual(aliceEntity.workspaceId, "alice");
  assert.strictEqual(bobEntity.workspaceId, "bob");
  console.log("  [ok] each entity kept its own workspace");

  // ── 3. Each holds exactly one version — no cross-tenant supersession ──────
  // The old failure mode was silent: the second write became version 2 of the
  // first tenant's entity, overwriting their fact and stamping their audit
  // trail with a stranger's provenance.
  assert.strictEqual(aliceEntity.versionCount, 1,
    "alice's entity must not carry a version authored from bob's workspace");
  assert.strictEqual(bobEntity.versionCount, 1);
  console.log("  [ok] neither entity gained a version from the other workspace");

  // ── 4. Within one workspace, merging still works ──────────────────────────
  // The isolation filter must not disable ordinary versioning.
  const again = await lib.ingest("The deployment target for the platform is Fly", {
    workspaceId: "alice",
    allowedWorkspaces: ["alice"],
  });
  assert.strictEqual(again, alice, "a same-workspace update must version the existing entity");
  const updated = await lib.get(alice, { allowedWorkspaces: ["alice"] });
  assert.ok(updated.versionCount >= 2, "the same-workspace update should add a version");
  console.log("  [ok] same-workspace updates still version in place");

  // ── 5. Workspace-less callers are unaffected ──────────────────────────────
  // Everyone who never sets workspaceId lands in "default", so for them the
  // filter matches everything it matched before — no behavior change.
  const d1 = await lib.ingest("Quarterly review happens in March");
  const d2 = await lib.ingest("Quarterly review happens in April");
  assert.strictEqual(d1, d2, "default-workspace callers keep the old merge behavior");
  console.log("  [ok] callers that never set a workspace see no change");

  await lib.shutdown();
  console.log("\n=== all workspace-isolation tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
