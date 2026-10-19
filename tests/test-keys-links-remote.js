// test-keys-links-remote.js — keys, fields and links survive the network hop.
//
// tests/test-keys-links.js proves the engine finds a thing by its key and
// reads it and its links on both clocks. Over HTTP that only holds if every
// write route carries key, fields and links, GET /describe passes both clocks
// through (as ms or ISO-8601, from a query string), and the read keeps to the
// caller's workspaces like every other read route.
//
// These tests boot the real server as a subprocess, in a temp cwd with its
// own data file so no real store is touched, and drive it through the
// published remote client.
//
// Run: node tests/test-keys-links-remote.js
"use strict";

const assert  = require("assert/strict");
const path    = require("path");
const os      = require("os");
const fs      = require("fs");
const { spawn } = require("child_process");
const { connect } = require("../remote");

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

const ROOT = path.join(__dirname, "..");
// A random high port, as in test-server-auth.js, so concurrent runs in other
// checkouts don't collide.
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);

const LIBRARY       = { type: "file", actor: "payer policy library" };
const CLEARINGHOUSE = { type: "tool", actor: "clearinghouse" };
const PRACTICE      = { type: "file", actor: "practice records" };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// kill() only sends the signal. Windows refuses to remove a directory that is
// still a live process's cwd (EBUSY), so wait for the exit before cleaning up.
function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    proc.once("exit", resolve);
    proc.kill("SIGKILL");
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server did not become ready on ${BASE} within ${timeoutMs}ms`);
}

async function withServer(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-keys-rest-"));
  const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd,
    env: {
      ...process.env,
      KALAIROS_PORT:      String(PORT),
      KALAIROS_HOST:      "127.0.0.1",
      KALAIROS_DATA_FILE: path.join(cwd, "data.kalairos"),
      KALAIROS_RATE_LIMIT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", d => { stderr += d.toString(); });
  proc.stdout.resume();

  try {
    await waitForServer();
    return await fn();
  } catch (e) {
    if (stderr) e.message += `\n       --- server stderr ---\n${stderr.split("\n").slice(-8).join("\n")}`;
    throw e;
  } finally {
    await stop(proc);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// The IB-114 case from test-keys-links.js, written through every write route:
// /ingest, /remember, /ingest/batch and a scope's /agent/:id/remember. IB-114
// is revised after the claim was filed: v1 (6 weeks) in force from Jan 1, v2
// (12 weeks) published Jun 15 and in force from Jul 1. The claim was served
// May 12, filed May 20, denied Jul 20.
async function seed(kal) {
  const v1 = await kal.ingest("Ironbark policy IB-114: six weeks of conservative therapy.", {
    type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, source: LIBRARY,
    timestamp: day("2025-12-01"), effectiveAt: day("2026-01-01"),
  });
  const v2 = await kal.ingest("IB-114 revised: twelve weeks before surgery.", {
    type: "policy", key: "IB-114", fields: { therapyWeeks: 12 }, source: LIBRARY,
    timestamp: day("2026-06-15"), effectiveAt: day("2026-07-01"),
  });
  const claim = await kal.remember("Claim for lumbar microdiscectomy at L5-S1.", {
    type: "claim", key: "D-101", fields: { dos: "2026-05-12", billed: 14200 },
    links: [{ rel: "under", to: "policy:IB-114", one: true }],
    source: CLEARINGHOUSE, timestamp: day("2026-05-20"), effectiveAt: day("2026-05-12"),
  });
  await kal.ingestBatch([{
    text: "Physical therapy discharge summary: eight weeks completed.",
    type: "record", key: "D-101/pt", fields: { therapyWeeks: 8 },
    links: [{ rel: "supports", to: "claim:D-101" }],
    source: PRACTICE, timestamp: day("2026-05-20"), effectiveAt: day("2026-04-28"),
  }]);
  const scope = await kal.scope({ source: { type: "agent", actor: "records-bot" } });
  await scope.remember("Operative note: microdiscectomy performed May 12.", {
    type: "record", key: "D-101/op-note",
    links: [{ rel: "supports", to: "claim:D-101" }],
    timestamp: day("2026-08-01"), effectiveAt: day("2026-05-12"),
  });
  return { policyIds: [v1.id, v2.id], claimId: claim.id };
}

(async function run() {
  console.log("\n── keys, fields and links over REST ─────────────────────────\n");

  await test("REST: every write route carries key, fields and links; describe reads both clocks", async () => {
    await withServer(async () => {
      const kal = connect(BASE);
      const { policyIds, claimId } = await seed(kal);

      assert.equal(policyIds[1], policyIds[0], "a reworded write with the same key lands on its record");
      const policy = await kal.get(policyIds[0]);
      assert.equal(policy.key, "IB-114");
      assert.deepEqual(policy.fields, { therapyWeeks: 12 });

      const now = await kal.describe("claim:D-101");
      assert.equal(now.id, claimId);
      assert.deepEqual(now.fields, { dos: "2026-05-12", billed: 14200 });
      assert.deepEqual(now.links.map(l => [l.rel, l.to]), [["under", "policy:IB-114"]]);
      assert.equal(now.links[0].thing.fields.therapyWeeks, 12, "now, the link reads the policy as it stands");
      assert.deepEqual(now.linkedFrom.map(l => l.from).sort(), ["record:D-101/op-note", "record:D-101/pt"],
        "links written through /ingest/batch and a scope's remember both arrive");

      // Both clocks at once, in ms: in force on the date of service, as known at denial.
      const onDos = await kal.describe("claim:D-101", { validAt: day("2026-05-12"), asOf: day("2026-07-20") });
      assert.equal(onDos.links[0].thing.fields.therapyWeeks, 6);
      assert.equal(onDos.validAt, day("2026-05-12"), "a query-string ms value reaches the engine as a number");
      assert.equal(onDos.asOf, day("2026-07-20"));
      assert.ok(!onDos.linkedFrom.some(l => l.from === "record:D-101/op-note"), "the op note arrived after the denial");
      assert.ok(onDos.linkedFrom.some(l => l.from === "record:D-101/pt"),
        "the PT summary, sent through /ingest/batch with an earlier effectiveAt, was in force on the date of service");
      // The same instants in ISO-8601.
      const iso = await kal.describe("claim:D-101", { validAt: "2026-05-12T12:00:00Z", asOf: "2026-07-20T12:00:00Z" });
      assert.deepEqual(iso, onDos, "ISO-8601 and ms name the same instants");
      // At denial, and as known before v2 was published.
      const atDenial = await kal.describe("claim:D-101", { validAt: day("2026-07-20"), asOf: day("2026-07-20") });
      assert.equal(atDenial.links[0].thing.fields.therapyWeeks, 12);
      const early = await kal.describe("claim:D-101", { validAt: day("2026-07-20"), asOf: day("2026-06-01") });
      assert.equal(early.links[0].thing.fields.therapyWeeks, 6, "on Jun 1 nobody had seen v2");
      assert.equal(await kal.describe("claim:D-101", { asOf: day("2026-05-19") }), null, "unknown before it was filed");
    });
  });

  await test("REST: unknown things are null; bad requests are 400s", async () => {
    await withServer(async () => {
      const kal = connect(BASE);
      await kal.ingest("Claim for lumbar microdiscectomy at L5-S1.", { type: "claim", key: "D-101" });

      assert.equal(await kal.describe("claim:D-999"), null, "an unknown key is null, not an error");
      assert.equal(await kal.describe("claim:D-101", { workspaceId: "elsewhere" }), null, "a key belongs to its workspace");
      await assert.rejects(kal.describe("D-101"), (e) => e.code === "ERR_VALIDATION" && /address/.test(e.message));
      await assert.rejects(kal.describe("claim:D-101", { validAt: "not a date" }), (e) => e.code === "ERR_VALIDATION");
      await assert.rejects(kal.ingest("Stray link", { links: [{ rel: "under", to: "policy:IB-114" }] }),
        (e) => e.code === "ERR_VALIDATION" && /key/.test(e.message), "links need a key");
      await assert.rejects(kal.ingest("Bad fields", { key: "k", fields: ["not", "an", "object"] }),
        (e) => e.code === "ERR_VALIDATION" && /fields/.test(e.message));

      const res = await fetch(`${BASE}/describe`);
      assert.equal(res.status, 400, "describe without an address is a client error");
      assert.match(JSON.stringify(await res.json()), /address/);
    });
  });

  await test("REST: describe keeps to the caller's workspaces", async () => {
    await withServer(async () => {
      const open = connect(BASE);
      const ops    = (await open.auth.addPrincipal({ id: "ops", name: "Ops", workspaces: { default: "owner", north: "owner" } })).principal.token;
      const reader = (await open.auth.addPrincipal({ id: "nina", name: "Nina", workspaces: { north: "read" } })).principal.token;
      await open.auth.enable();

      await connect(BASE, { token: ops }).ingest("Claim D-101 for the north practice.", {
        type: "claim", key: "D-101", fields: { billed: 14200 }, workspaceId: "north",
      });

      const nina = connect(BASE, { token: reader });
      const d = await nina.describe("claim:D-101", { workspaceId: "north" });
      assert.deepEqual(d.fields, { billed: 14200 }, "a reader of north can describe a north thing");
      await assert.rejects(nina.describe("claim:D-101"), (e) => e.code === "ERR_FORBIDDEN",
        "a reader of north can't read the default workspace");
      await assert.rejects(nina.describe("claim:D-101", { workspaceId: "south" }), (e) => e.code === "ERR_FORBIDDEN");
      await assert.rejects(open.describe("claim:D-101", { workspaceId: "north" }), (e) => e.code === "ERR_AUTH_FAILED",
        "an anonymous caller is refused once auth is on");
    });
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
