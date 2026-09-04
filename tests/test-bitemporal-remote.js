// test-bitemporal-remote.js — the two time axes survive the network hop.
//
// tests/test-bitemporal-divergence.js proves the engine distinguishes ingest
// time from event time. That proof is worth nothing to a buyer who reaches
// Kalairos over HTTP or MCP unless the distinction survives transport: the
// axis has to be selectable on the wire, and the two must still disagree on
// the far side.
//
// These tests boot the real server as a subprocess (in a temp cwd, so the
// repo's data.kalairos is never touched), drive it through the published
// remote client, and drive the real MCP server over stdio JSON-RPC.
//
// Run: node tests/test-bitemporal-remote.js
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
const PORT = 3400 + (process.pid % 150);
const BASE = `http://127.0.0.1:${PORT}`;

// Shared scenario: the backdated-raise case from the engine-level test.
// Salary known Jan 1. On Mar 1 we learn of a raise effective Feb 1.
const JAN1  = Date.parse("2026-01-01T00:00:00Z");
const FEB1  = Date.parse("2026-02-01T00:00:00Z");
const FEB15 = Date.parse("2026-02-15T00:00:00Z");
const MAR1  = Date.parse("2026-03-01T00:00:00Z");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tempCwd(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kalairos-${label}-`));
}

// ─── REST ─────────────────────────────────────────────────────────────────────

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
  const cwd = tempCwd("rest");
  const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd,
    env: { ...process.env, KALAIROS_PORT: String(PORT), KALAIROS_HOST: "127.0.0.1" },
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
    proc.kill("SIGKILL");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function seedOverRest(kal) {
  await kal.ingest("Dana annual salary is one hundred thousand", {
    timestamp: JAN1, effectiveAt: JAN1,
  });
  await kal.ingest("Dana annual salary is one hundred thirty thousand", {
    timestamp: MAR1, effectiveAt: FEB1,
  });
}

// ─── MCP ──────────────────────────────────────────────────────────────────────
// Minimal stdio JSON-RPC client. The MCP SDK speaks newline-delimited JSON on
// stdio, which is little enough protocol to drive directly — this keeps the
// test dependency-free and exercises the real tool registration in mcp.js.

function mcpClient() {
  const cwd = tempCwd("mcp");
  const proc = spawn(process.execPath, [path.join(ROOT, "mcp.js")], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // non-protocol noise
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let stderr = "";
  proc.stderr.on("data", d => { stderr += d.toString(); });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out\n       --- stderr ---\n${stderr.slice(-500)}`)),
        30_000,
      );
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  return {
    send,
    notify,
    close() {
      proc.kill("SIGKILL");
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Unwrap an MCP tool result into the JSON payload the tool returned.
function mcpPayload(res) {
  assert.ok(res.result, `MCP call failed: ${JSON.stringify(res.error || res).slice(0, 300)}`);
  const text = res.result.content?.[0]?.text;
  assert.ok(text, `MCP result had no text content: ${JSON.stringify(res.result).slice(0, 300)}`);
  return JSON.parse(text);
}

function allTexts(payload) {
  const results = payload.results || payload.data?.results || [];
  return results.map(r => r.text);
}

function firstText(payload) {
  const t = allTexts(payload);
  return t.length ? t[0] : null;
}

// Assert on set membership rather than on the top-ranked hit. Over the wire the
// server picks its own embedder, so whether two salary statements merge into one
// entity or stay separate is an embedder detail — the axis behaviour under test
// is "which facts are visible on this axis at this instant", which holds either
// way.
function includesMatch(payload, re) {
  return allTexts(payload).some(t => re.test(t));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async function run() {
  console.log("\n── bitemporal axes over REST and MCP ────────────────────────\n");

  // 1. REST: the divergence survives the wire.
  await test("REST: asOf and validAt disagree across the network", async () => {
    await withServer(async () => {
      const kal = connect(BASE);
      await seedOverRest(kal);

      const believed = await kal.queryAt("Dana annual salary", FEB15);
      const actual   = await kal.queryValidAt("Dana annual salary", FEB15);

      assert.ok(believed.count > 0, "ingest-time query returned nothing over REST");
      assert.ok(actual.count   > 0, "event-time query returned nothing over REST");

      // On Feb 15 the raise had not been ingested — it must be invisible on the
      // ingest-time axis and visible on the event-time axis. That contrast is
      // the whole claim.
      assert.ok(includesMatch(believed, /one hundred thousand/),
        "the belief held on Feb 15 must come back on the ingest-time axis");
      assert.ok(!includesMatch(believed, /thirty thousand/),
        "the raise was not yet known on Feb 15 and must not appear on the ingest-time axis");
      assert.ok(includesMatch(actual, /thirty thousand/),
        "the raise was already in force on Feb 15 and must appear on the event-time axis");
      assert.equal(actual.validAt, FEB15, "the response must echo the event-time instant");
    });
  });

  // 2. REST: mixing axes is a 400, not a silent precedence choice.
  await test("REST: combining time modes is rejected with a validation error", async () => {
    await withServer(async () => {
      const res = await fetch(`${BASE}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Dana", asOf: FEB15, validAt: FEB15 }),
      });
      assert.equal(res.status, 400, "mixing asOf and validAt must be a client error");
      const body = await res.json();
      assert.match(JSON.stringify(body), /distinct query modes/,
        "the error must name the conflict rather than silently picking one axis");
    });
  });

  // 3. REST: the agent-scoped recall route dispatches time arguments.
  // Before this change it forwarded asOf into query(), which rejects time
  // arguments outright — so historical recall through a scope was broken.
  await test("REST: agent-scoped recall dispatches asOf and validAt", async () => {
    await withServer(async () => {
      const kal   = connect(BASE);
      const scope = await kal.scope({ source: { type: "agent", actor: "payroll" } });

      await scope.remember("Dana annual salary is one hundred thousand", {
        timestamp: JAN1, effectiveAt: JAN1,
      });
      await scope.remember("Dana annual salary is one hundred thirty thousand", {
        timestamp: MAR1, effectiveAt: FEB1,
      });

      const believed = await scope.queryAt("Dana annual salary", FEB15);
      const actual   = await scope.queryValidAt("Dana annual salary", FEB15);

      assert.ok(believed.count > 0, "scoped asOf recall must not throw");
      assert.ok(includesMatch(believed, /one hundred thousand/), "scoped belief on Feb 15");
      assert.ok(!includesMatch(believed, /thirty thousand/),
        "the raise was not yet ingested on Feb 15 — scoped ingest-time recall must not show it");
      assert.ok(includesMatch(actual, /thirty thousand/), "scoped truth on Feb 15");
    });
  });

  // 4. MCP: validAt is a registered parameter on kalairos_recall.
  await test("MCP: kalairos_recall advertises both time axes", async () => {
    const mcp = mcpClient();
    try {
      await mcp.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "kalairos-test", version: "0" },
      });
      mcp.notify("notifications/initialized", {});

      const res = await mcp.send("tools/list", {});
      assert.ok(res.result, `tools/list failed: ${JSON.stringify(res.error || {}).slice(0, 200)}`);
      const recall = res.result.tools.find(t => t.name === "kalairos_recall");
      assert.ok(recall, "kalairos_recall must be registered");

      const props = recall.inputSchema?.properties || {};
      assert.ok(props.asOf,    "asOf must remain on the recall schema");
      assert.ok(props.validAt, "validAt must be exposed on the recall schema");
      assert.match(String(props.validAt.description), /event.time|actually/i,
        "the validAt description must tell the model which question it answers");
      assert.match(String(props.asOf.description), /ingest|believe/i,
        "the asOf description must tell the model which question it answers");
    } finally {
      mcp.close();
    }
  });

  // 5. MCP: the divergence survives a real tool call.
  await test("MCP: asOf and validAt disagree through kalairos_recall", async () => {
    const mcp = mcpClient();
    try {
      await mcp.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "kalairos-test", version: "0" },
      });
      mcp.notify("notifications/initialized", {});

      const call = (name, args) => mcp.send("tools/call", { name, arguments: args });

      await call("kalairos_remember", {
        text: "Dana annual salary is one hundred thousand", effectiveAt: JAN1,
      });
      await call("kalairos_remember", {
        text: "Dana annual salary is one hundred thirty thousand", effectiveAt: FEB1,
      });

      const believed = mcpPayload(await call("kalairos_recall", { text: "Dana annual salary", asOf: FEB15 }));
      const actual   = mcpPayload(await call("kalairos_recall", { text: "Dana annual salary", validAt: FEB15 }));

      // Both facts were ingested now, so asOf(Feb 15) predates every ingest and
      // returns nothing — the honest answer: on Feb 15 this store knew nothing.
      assert.equal(allTexts(believed).length, 0,
        "nothing had been ingested by Feb 15, so ingest-time recall must be empty");

      // Event time is a different story: the raise was already effective.
      assert.ok(includesMatch(actual, /thirty thousand/),
        "event-time recall must return the version in force on Feb 15");
    } finally {
      mcp.close();
    }
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
