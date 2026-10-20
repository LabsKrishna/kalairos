// test-keys-links.js — keys, fields, links as keyed facts, describe() on both
// clocks, and the contested-write rule.
// Run: node tests/test-keys-links.js
//
// Under test: a keyed thing is found by its key, never by how its words read;
// its fields version exactly; a link is a fact with its own history; and
// describe() answers "what was true at X, as known at Y" for a thing and for
// everything it touches. A write to someone else's key from a source that is
// not more trusted is contested: it lands, flagged and penalised, and the
// holder's version stays recoverable.
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const lib    = require("../index");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.log(`  ❌  ${name}\n       ${e.stack || e.message}`); failed++; }
}

// Bag-of-words mock embedder: deterministic, no model download. Identity in
// this file must never depend on it — keyed writes don't consult similarity.
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

async function fresh(extra = {}) {
  await lib.shutdown().catch(() => {});
  await lib.init({
    dataFile:         ":memory:",
    embeddingDim:     64,
    embedFn:          makeMockEmbedder(64),
    minFinalScore:    0,
    minSemanticScore: 0,
    ...extra,
  });
}

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);

const CLEARINGHOUSE = { type: "tool", actor: "clearinghouse" };
const LIBRARY       = { type: "file", actor: "payer policy library" };
const PRACTICE      = { type: "file", actor: "practice records" };
const INTAKE_BOT    = { type: "agent", actor: "intake-bot" };

// IB-114 is revised after the claim was filed: v1 (6 weeks) in force from
// Jan 1, v2 (12 weeks) published Jun 15 and in force from Jul 1. The claim
// was served May 12, filed May 20, denied Jul 20.
async function seedClaim() {
  await lib.ingest("Ironbark policy IB-114: six weeks of conservative therapy.", {
    type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, source: LIBRARY,
    timestamp: day("2025-12-01"), effectiveAt: day("2026-01-01"),
  });
  await lib.ingest("Ironbark policy IB-114: twelve weeks of conservative therapy.", {
    type: "policy", key: "IB-114", fields: { therapyWeeks: 12 }, source: LIBRARY,
    timestamp: day("2026-06-15"), effectiveAt: day("2026-07-01"),
  });
  await lib.ingest("Tallgrass policy TG-207: four weeks of therapy.", {
    type: "policy", key: "TG-207", fields: { therapyWeeks: 4 }, source: LIBRARY,
    timestamp: day("2025-12-01"), effectiveAt: day("2026-01-01"),
  });
  const claimId = await lib.ingest("Claim for lumbar microdiscectomy at L5-S1, received by Ironbark.", {
    type: "claim", key: "D-101", fields: { dos: "2026-05-12", billed: 14200 },
    links: [{ rel: "under", to: "policy:IB-114", one: true }],
    source: CLEARINGHOUSE, timestamp: day("2026-05-20"), effectiveAt: day("2026-05-12"),
  });
  await lib.ingest("Physical therapy discharge summary: eight weeks completed.", {
    type: "record", key: "D-101/pt", fields: { therapyWeeks: 8 },
    links: [{ rel: "supports", to: "claim:D-101" }],
    source: PRACTICE, timestamp: day("2026-05-20"), effectiveAt: day("2026-04-28"),
  });
  await lib.ingest("Lumbar MRI report: nerve root compression at L5-S1.", {
    type: "record", key: "D-101/mri", fields: { imaging: "nerve root compression" },
    links: [{ rel: "supports", to: "claim:D-101" }],
    source: PRACTICE, timestamp: day("2026-05-20"), effectiveAt: day("2026-03-30"),
  });
  return claimId;
}

(async () => {
  console.log("\n── keys: identity by key, never by wording ──────────────────────");

  await test("a reworded revision lands on its record", async () => {
    await fresh();
    const a = await lib.ingest("Claim for lumbar microdiscectomy at L5-S1, received May 20.", {
      type: "claim", key: "D-101", source: CLEARINGHOUSE, timestamp: day("2026-05-20"), effectiveAt: day("2026-05-12"),
    });
    const b = await lib.ingest("Resubmitted with the member ID fixed.", {
      type: "claim", key: "D-101", source: CLEARINGHOUSE, timestamp: day("2026-06-02"), effectiveAt: day("2026-05-12"),
    });
    assert.equal(b, a);
    assert.equal((await lib.getHistory(a)).versionCount, 2);
    assert.equal((await lib.get(a)).key, "D-101");
  });

  await test("two keys never merge, even with identical text", async () => {
    await fresh();
    const x = await lib.ingest("Lumbar spine MRI claim.", { type: "claim", key: "D-103", source: CLEARINGHOUSE });
    const y = await lib.ingest("Lumbar spine MRI claim.", { type: "claim", key: "D-104", source: CLEARINGHOUSE });
    assert.notEqual(x, y);
  });

  await test("an unkeyed write never lands on a keyed thing", async () => {
    await fresh();
    const k = await lib.ingest("Lumbar spine MRI claim.", { type: "claim", key: "D-103", source: CLEARINGHOUSE });
    const u = await lib.ingest("Lumbar spine MRI claim.", { type: "claim", source: CLEARINGHOUSE });
    assert.notEqual(u, k);
    assert.equal((await lib.getHistory(k)).versionCount, 1);
  });

  await test("consolidate leaves keyed things alone", async () => {
    await fresh();
    await lib.ingest("Lumbar spine MRI claim.",  { type: "claim", key: "D-103", source: CLEARINGHOUSE });
    await lib.ingest("Lumbar spine MRI claim!",  { type: "claim", key: "D-104", source: CLEARINGHOUSE });
    const r = await lib.consolidate({ threshold: 0.5 });
    assert.equal(r.totalMerged, 0);
  });

  await test("the same key in two workspaces is two things", async () => {
    await fresh();
    const north = lib.scope({ source: CLEARINGHOUSE, workspaceId: "north" });
    const south = lib.scope({ source: CLEARINGHOUSE, workspaceId: "south" });
    const n = await north.remember("Claim D-101 for the north practice.", { type: "claim", key: "D-101" });
    const s = await south.remember("Claim D-101 for the south practice.", { type: "claim", key: "D-101" });
    assert.notEqual(n, s);
    assert.equal((await north.describe("claim:D-101")).id, n);
    assert.equal((await south.describe("claim:D-101")).id, s);
    assert.equal(await lib.describe("claim:D-101"), null, "the default workspace has no D-101");
  });

  await test("describe refuses a workspace the caller can't read", async () => {
    await assert.rejects(
      lib.describe("claim:D-101", { workspaceId: "north", allowedWorkspaces: ["south"] }),
      /No access to workspace "north"/,
    );
    const d = await lib.describe("claim:D-101", { workspaceId: "north", allowedWorkspaces: ["north"] });
    assert.equal(d.workspaceId, "north");
  });

  console.log("\n── fields: exact facts, versioned with the text ─────────────────");

  await test("a later change by the holder is a revision, not a contradiction", async () => {
    await fresh();
    const id = await lib.ingest("Policy IB-114: six weeks of therapy.", {
      type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, source: LIBRARY,
      timestamp: day("2025-12-01"), effectiveAt: day("2026-01-01"),
    });
    await lib.ingest("Policy IB-114: twelve weeks of therapy.", {
      type: "policy", key: "IB-114", fields: { therapyWeeks: 12 }, source: LIBRARY,
      timestamp: day("2026-06-15"), effectiveAt: day("2026-07-01"),
    });
    const v2 = (await lib.getHistory(id)).versions[1];
    assert.deepEqual(v2.fields, { therapyWeeks: 12 });
    assert.deepEqual(v2.delta.fields, { therapyWeeks: { from: 6, to: 12 } });
    assert.equal(v2.delta.contradicts, false, "a revision over time is not a contradiction");
    assert.equal(v2.delta.supersedes, true);
    assert.equal(v2.action, "superseded");
  });

  await test("a same-moment change by the holder is a correction", async () => {
    const id = (await lib.describe("policy:IB-114")).id;
    await lib.ingest("Policy IB-114: ten weeks of therapy.", {
      type: "policy", key: "IB-114", fields: { therapyWeeks: 10 }, source: LIBRARY,
      timestamp: day("2026-06-20"), effectiveAt: day("2026-07-01"),
    });
    const v3 = (await lib.getHistory(id)).versions[2];
    assert.equal(v3.delta.contradicts, false);
    assert.equal(v3.delta.type, "correction");
    assert.equal(v3.action, "corrected");
  });

  await test("fields left out of a write carry forward", async () => {
    const id = (await lib.describe("policy:IB-114")).id;
    await lib.ingest("Policy IB-114: ten weeks of supervised therapy.", {
      type: "policy", key: "IB-114", source: LIBRARY,
      timestamp: day("2026-06-21"), effectiveAt: day("2026-07-01"),
    });
    assert.deepEqual((await lib.get(id)).fields, { therapyWeeks: 10 });
    const h = await lib.getHistory(id);
    assert.deepEqual(h.versions[h.versions.length - 1].fields, { therapyWeeks: 10 });
  });

  console.log("\n── contested writes ─────────────────────────────────────────────");

  await test("a less trusted source changing a key is contested, flagged and penalised", async () => {
    await fresh();
    const id = await lib.ingest("Claim D-101 billed $14,200.", {
      type: "claim", key: "D-101", fields: { billed: 14200 }, source: CLEARINGHOUSE,
      timestamp: day("2026-05-20"), effectiveAt: day("2026-05-12"),
    });
    const before = await lib.describe("claim:D-101");
    await lib.ingest("Claim D-101 billed $1,420.", {
      type: "claim", key: "D-101", fields: { billed: 1420 }, source: INTAKE_BOT,
      timestamp: day("2026-06-01"), effectiveAt: day("2026-05-12"),
    });
    const h  = await lib.getHistory(id);
    const v2 = h.versions[1];
    assert.equal(v2.delta.contested, true);
    assert.equal(v2.delta.contradicts, true);
    assert.match(v2.delta.contestReason, /agent:intake-bot/);
    assert.match(v2.delta.contestReason, /tool:clearinghouse/);
    assert.ok(h.trailEvents.some(ev => ev.action === "contested"), "a contested trail event is recorded");
    const now = await lib.describe("claim:D-101");
    assert.equal(now.contested, true);
    assert.ok(now.trust < before.trust, `trust should drop (${before.trust} → ${now.trust})`);
    const then = await lib.describe("claim:D-101", { asOf: day("2026-05-21") });
    assert.deepEqual(then.fields, { billed: 14200 }, "the holder's version is recoverable");
  });

  await test("naming a high trustScore doesn't buy a contested write out of the penalty", async () => {
    await fresh();
    await lib.ingest("Claim D-101 billed $14,200.", {
      type: "claim", key: "D-101", fields: { billed: 14200 }, source: CLEARINGHOUSE, effectiveAt: day("2026-05-12"),
    });
    const before = await lib.describe("claim:D-101");
    await lib.ingest("Claim D-101 billed $1,420.", {
      type: "claim", key: "D-101", fields: { billed: 1420 }, source: INTAKE_BOT, trustScore: 1.0, effectiveAt: day("2026-05-12"),
    });
    const now = await lib.describe("claim:D-101");
    assert.equal(now.contested, true);
    assert.equal((await lib.get(now.id)).trustScore, 0.8, "the base stays the holder's");
    assert.ok(now.trust < before.trust, `trust should drop (${before.trust} → ${now.trust})`);
  });

  await test("an equally trusted outsider is contested too", async () => {
    await fresh();
    const id = await lib.ingest("Policy IB-114: six weeks.", {
      type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, source: LIBRARY, effectiveAt: day("2026-01-01"),
    });
    await lib.ingest("Policy IB-114: four weeks.", {
      type: "policy", key: "IB-114", fields: { therapyWeeks: 4 }, source: { type: "file", actor: "fax-inbox" }, effectiveAt: day("2026-02-01"),
    });
    assert.equal((await lib.getHistory(id)).versions[1].delta.contested, true);
  });

  await test("the holder and stronger sources are not contested; repeating the head corroborates", async () => {
    await fresh();
    const id = await lib.ingest("Claim D-101 billed $14,200.", {
      type: "claim", key: "D-101", fields: { billed: 14200 }, source: CLEARINGHOUSE, effectiveAt: day("2026-05-12"),
    });
    // A weaker source saying exactly what the head says is corroboration.
    await lib.ingest("Claim D-101 billed $14,200.", {
      type: "claim", key: "D-101", fields: { billed: 14200 }, source: INTAKE_BOT, effectiveAt: day("2026-05-12"),
    });
    // A contest, then the holder restating the truth.
    await lib.ingest("Claim D-101 billed $1,420.", {
      type: "claim", key: "D-101", fields: { billed: 1420 }, source: INTAKE_BOT, effectiveAt: day("2026-05-12"),
    });
    await lib.ingest("Claim D-101 billed $14,200.", {
      type: "claim", key: "D-101", fields: { billed: 14200 }, source: CLEARINGHOUSE, effectiveAt: day("2026-05-12"),
    });
    // A stronger source changing it.
    await lib.ingest("Claim D-101 billed $14,500.", {
      type: "claim", key: "D-101", fields: { billed: 14500 }, source: { type: "user", actor: "billing-lead" }, effectiveAt: day("2026-05-12"),
    });
    const v = (await lib.getHistory(id)).versions;
    assert.equal(Boolean(v[1].delta.contested), false, "repeating the head is not a contest");
    assert.equal(v[2].delta.contested, true);
    assert.equal(Boolean(v[3].delta.contested), false, "the holder restating is not contested");
    assert.equal(Boolean(v[4].delta.contested), false, "a more trusted source is not contested");
    assert.equal((await lib.describe("claim:D-101")).contested, false);
  });

  console.log("\n── links: facts with their own history ──────────────────────────");

  await test("links read from both ends", async () => {
    await fresh();
    await seedClaim();
    const d = await lib.describe("claim:D-101");
    assert.deepEqual(d.links.map(l => [l.rel, l.to]), [["under", "policy:IB-114"]]);
    assert.equal(d.links[0].thing.fields.therapyWeeks, 12, "now, the link reads the policy as it stands now");
    assert.deepEqual(d.linkedFrom.map(l => l.from).sort(), ["record:D-101/mri", "record:D-101/pt"]);
    assert.ok(d.linkedFrom.every(l => l.rel === "supports"));
    const pt = await lib.describe("record:D-101/pt");
    assert.equal(pt.links[0].thing.address, "claim:D-101");
    const ib = await lib.describe("policy:IB-114");
    assert.deepEqual(ib.linkedFrom.map(l => l.from), ["claim:D-101"]);
  });

  await test("describe reads both clocks: in force on the date of service, as known at denial", async () => {
    const onDos = await lib.describe("claim:D-101", { validAt: day("2026-05-12"), asOf: day("2026-07-20") });
    assert.equal(onDos.links[0].thing.fields.therapyWeeks, 6);
    assert.equal(onDos.links[0].thing.version.effectiveAt, day("2026-01-01"));
    const atDenial = await lib.describe("claim:D-101", { validAt: day("2026-07-20"), asOf: day("2026-07-20") });
    assert.equal(atDenial.links[0].thing.fields.therapyWeeks, 12);
    // On Jun 1 nobody had seen v2, whatever date they asked about.
    const early = await lib.describe("claim:D-101", { validAt: day("2026-07-20"), asOf: day("2026-06-01") });
    assert.equal(early.links[0].thing.fields.therapyWeeks, 6);
    assert.equal(await lib.describe("claim:D-101", { asOf: day("2026-05-19") }), null, "unknown before it was filed");
    assert.equal(await lib.describe("claim:D-101", { validAt: day("2026-05-01") }), null, "not yet true before the service");
    assert.equal(onDos.knownSince, day("2026-05-20"));
  });

  await test("inbound links respect the clocks", async () => {
    await lib.ingest("Operative note: microdiscectomy performed May 12.", {
      type: "record", key: "D-101/op-note", links: [{ rel: "supports", to: "claim:D-101" }],
      source: PRACTICE, timestamp: day("2026-08-01"), effectiveAt: day("2026-05-12"),
    });
    const had = await lib.describe("claim:D-101", { validAt: day("2026-05-12"), asOf: day("2026-07-20") });
    assert.ok(!had.linkedFrom.some(l => l.from === "record:D-101/op-note"), "sent after the denial");
    const existed = await lib.describe("claim:D-101", { validAt: day("2026-05-12") });
    assert.ok(existed.linkedFrom.some(l => l.from === "record:D-101/op-note"), "existed on the date of service");
  });

  await test("re-pointing a one-link is a new version of the same link", async () => {
    await lib.ingest("Claim for lumbar microdiscectomy at L5-S1, received by Ironbark.", {
      type: "claim", key: "D-101", fields: { dos: "2026-05-12", billed: 14200 },
      links: [{ rel: "under", to: "policy:TG-207", one: true }],
      source: CLEARINGHOUSE, timestamp: day("2026-08-05"), effectiveAt: day("2026-05-12"),
    });
    const now = await lib.describe("claim:D-101");
    assert.deepEqual(now.links.map(l => l.to), ["policy:TG-207"]);
    const before = await lib.describe("claim:D-101", { asOf: day("2026-07-20") });
    assert.deepEqual(before.links.map(l => l.to), ["policy:IB-114"]);
    assert.equal((await lib.getHistory(now.links[0].linkId)).versionCount, 2);
    assert.ok(!(await lib.describe("policy:IB-114")).linkedFrom.some(l => l.from === "claim:D-101"));
  });

  await test("a link changed by an outsider is contested", async () => {
    await lib.ingest("Claim for lumbar microdiscectomy at L5-S1, received by Ironbark.", {
      type: "claim", key: "D-101", fields: { dos: "2026-05-12", billed: 14200 },
      links: [{ rel: "under", to: "policy:IB-114", one: true }],
      source: INTAKE_BOT, timestamp: day("2026-08-06"), effectiveAt: day("2026-05-12"),
    });
    const d = await lib.describe("claim:D-101");
    assert.equal(d.contested, false, "the claim itself was only repeated");
    assert.equal(d.links[0].contested, true);
  });

  await test("link records stay out of search, and results carry keys", async () => {
    const res = await lib.query("claim D-101 under policy IB-114", { limit: 50 });
    assert.ok(res.results.length > 0);
    assert.ok(res.results.every(r => r.type !== "link"));
    assert.ok(res.results.some(r => r.key === "D-101" && r.type === "claim"));
  });

  await test("bad input is refused before anything is written", async () => {
    await assert.rejects(lib.ingest("x", { links: [{ rel: "under", to: "policy:IB-114" }] }), /key/);
    await assert.rejects(lib.ingest("x", { key: "k", links: { rel: "under", to: "policy:IB-114" } }), /links must be an array/);
    await assert.rejects(lib.ingest("x", { key: "   " }), /key must be a non-empty string/);
    await assert.rejects(lib.ingest("x", { key: "k", links: [{ rel: "under", to: "IB-114" }] }), /address/);
    await assert.rejects(lib.ingest("x", { key: "k", links: [{ to: "policy:IB-114" }] }), /rel/);
    await assert.rejects(lib.ingest("x", { key: "k", fields: ["not", "an", "object"] }), /fields/);
    await assert.rejects(lib.ingest("x", { key: "k", forceNew: true }), /forceNew/);
    await assert.rejects(lib.describe("D-101"), /address/);
  });

  // A thing and its links are one write: if it fails, none of it stays in
  // memory, and no later flush puts any of it on disk.
  await test("a linked write that fails leaves neither the thing nor its links", async () => {
    const { FileStore } = require("../store/file-store");
    const realPersistAll = FileStore.prototype.persistAll;
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-keys-"));
    const file = path.join(dir, "data.kalairos");
    try {
      await fresh({ dataFile: file });
      await lib.ingest("Ironbark policy IB-114: six weeks of conservative therapy.", {
        type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, source: LIBRARY,
      });
      FileStore.prototype.persistAll = () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      };
      await assert.rejects(lib.ingest("Claim for lumbar microdiscectomy at L5-S1.", {
        type: "claim", key: "D-102", links: [{ rel: "under", to: "policy:IB-114", one: true }],
        source: CLEARINGHOUSE,
      }), /ENOSPC/);
      FileStore.prototype.persistAll = realPersistAll;

      // The keys a reload would find: right now (a crash here), and after
      // shutdown's final flush rewrites the file from memory.
      const keysOnDisk = () => [...new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
        .map(l => JSON.parse(l).key))];
      assert.deepEqual(keysOnDisk(), ["IB-114"], "the rejected write is on disk");
      assert.equal(await lib.describe("claim:D-102"), null, "the rejected thing is still served");
      assert.deepEqual((await lib.describe("policy:IB-114")).linkedFrom, [], "the rejected link is still served");
      await lib.shutdown();
      assert.deepEqual(keysOnDisk(), ["IB-114"], "a later flush wrote the rejected write");
    } finally {
      FileStore.prototype.persistAll = realPersistAll;
      await lib.shutdown().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("keys, fields and links survive a restart", async () => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-keys-"));
    const file = path.join(dir, "data.kalairos");
    try {
      await fresh({ dataFile: file });
      const claimId = await seedClaim();
      await lib.shutdown();
      await lib.init({ dataFile: file, embeddingDim: 64, embedFn: makeMockEmbedder(64) });
      const d = await lib.describe("claim:D-101", { validAt: day("2026-05-12") });
      assert.equal(d.id, claimId);
      assert.deepEqual(d.fields, { dos: "2026-05-12", billed: 14200 });
      assert.equal(d.links[0].thing.fields.therapyWeeks, 6);
      const again = await lib.ingest("Claim D-101, resubmitted.", {
        type: "claim", key: "D-101", source: CLEARINGHOUSE, effectiveAt: day("2026-05-12"),
      });
      assert.equal(again, claimId);
    } finally {
      await lib.shutdown().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await lib.shutdown().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
})();
