// test-mcp-stdio.js — The MCP server's stdout must carry JSON-RPC and nothing else.
//
// Over stdio, stdout IS the protocol. query() used to time itself with
// console.time/timeEnd, which prints to stdout, so every kalairos_recall
// injected a "[kalairos] query: 1.1ms" line into the JSON-RPC stream.
// This drives the real server through a handshake, a write and a recall,
// and fails on any stdout line that is not a JSON-RPC message.
//
// It also drives keys over the wire: kalairos_remember with key, fields and
// links, and kalairos_describe on both clocks. Agents reach the engine
// through MCP, so a key that doesn't survive this hop isn't usable.
// Run: node tests/test-mcp-stdio.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-mcp-"));

(async () => {
  console.log("\n=== MCP stdio channel ===\n");

  const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp.js")], {
    env: { ...process.env, KALAIROS_DATA_FILE: path.join(dir, "data.kalairos") },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const nonProtocol = [];
  const pending = new Map();
  let buf = "", stderr = "", nextId = 0;
  child.stderr.on("data", d => { stderr += d; });
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonProtocol.push(line); continue; }
      if (msg.jsonrpc !== "2.0") { nonProtocol.push(line); continue; }
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 60_000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(!r.error && !r.result.isError, `${name} failed: ${JSON.stringify(r.error || r.result)}`);
    return JSON.parse(r.result.content[0].text);
  };
  // A call the server must refuse: returns the tool's error text.
  const toolError = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.isError, `${name} should have failed: ${JSON.stringify(r.error || r.result)}`);
    return r.result.content[0].text;
  };

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.strictEqual(init.result.serverInfo.version, require("../package.json").version, "serverInfo reports the package version");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    console.log("  [ok] handshake reports the real package version");

    await tool("kalairos_remember", { text: "Deploys go out every Friday afternoon" });
    await tool("kalairos_remember", { text: "The staging database is reset nightly" });
    // Worded to match under either embedder: CI has no cached ONNX model, so
    // the server falls back to bag-of-words, which needs shared words.
    const recall = await tool("kalairos_recall", { text: "when do deploys go out?" });
    assert.ok(recall.results?.length > 0 || recall.count > 0 || Array.isArray(recall), "recall returns a result");
    console.log("  [ok] remember and recall work over stdio");

    // ── Keys, fields and links ────────────────────────────────────────────
    // Keyed identity never consults similarity, so these hold under either
    // embedder.
    const { tools } = (await rpc("tools/list", {})).result;
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    const rememberProps = byName.kalairos_remember.inputSchema.properties;
    for (const p of ["key", "fields", "links"]) assert.ok(rememberProps[p], `kalairos_remember takes ${p}`);
    const describeSchema = byName.kalairos_describe?.inputSchema;
    assert.ok(describeSchema, "kalairos_describe is registered");
    assert.deepStrictEqual(describeSchema.required, ["address"], "address is the one required argument");
    for (const p of ["asOf", "validAt", "workspaceId"]) assert.ok(describeSchema.properties[p], `kalairos_describe takes ${p}`);
    console.log("  [ok] kalairos_remember advertises key, fields and links; kalairos_describe is listed");

    const beforeKeys = Date.now() - 1;
    const v1 = await tool("kalairos_remember", {
      text: "Ironbark policy IB-114: six weeks of conservative therapy.",
      type: "policy", key: "IB-114", fields: { therapyWeeks: 6 }, effectiveAt: "2026-01-01",
    });
    const v2 = await tool("kalairos_remember", {
      text: "IB-114 revised: twelve weeks before surgery.",
      type: "policy", key: "IB-114", fields: { therapyWeeks: 12 }, effectiveAt: "2026-07-01",
    });
    assert.strictEqual(v2.id, v1.id, "a reworded write with the same key lands on its record");
    const claim = await tool("kalairos_remember", {
      text: "Claim for lumbar microdiscectomy at L5-S1.",
      type: "claim", key: "D-101", fields: { dos: "2026-05-12", billed: 14200 }, effectiveAt: "2026-05-12",
      links: [{ rel: "under", to: "policy:IB-114", one: true }],
    });
    console.log("  [ok] a reworded write with the same key lands on its record");

    const now = await tool("kalairos_describe", { address: "claim:D-101" });
    assert.strictEqual(now.id, claim.id);
    assert.strictEqual(now.key, "D-101");
    assert.deepStrictEqual(now.fields, { dos: "2026-05-12", billed: 14200 });
    assert.deepStrictEqual(now.links.map(l => [l.rel, l.to]), [["under", "policy:IB-114"]]);
    assert.strictEqual(now.links[0].thing.fields.therapyWeeks, 12, "now, the link reads the policy as it stands");
    const policy = await tool("kalairos_describe", { address: "policy:IB-114" });
    assert.deepStrictEqual(policy.linkedFrom.map(l => [l.rel, l.from]), [["under", "claim:D-101"]]);
    console.log("  [ok] kalairos_describe returns fields and links from both ends");

    // Event time as ISO, then both clocks at once in ms.
    const onDos = await tool("kalairos_describe", { address: "claim:D-101", validAt: "2026-05-12T12:00:00Z" });
    assert.strictEqual(onDos.links[0].thing.fields.therapyWeeks, 6, "on the date of service, the policy in force then");
    const both = await tool("kalairos_describe", {
      address: "claim:D-101", validAt: Date.parse("2026-05-12T12:00:00Z"), asOf: Date.now() + 60_000,
    });
    assert.strictEqual(both.links[0].thing.fields.therapyWeeks, 6, "validAt and asOf combine");
    assert.strictEqual(both.validAt, Date.parse("2026-05-12T12:00:00Z"), "the clocks are echoed as ms");
    assert.strictEqual(await tool("kalairos_describe", { address: "claim:D-101", asOf: new Date(beforeKeys).toISOString() }), null,
      "nothing about the claim had been recorded yet");
    assert.strictEqual(await tool("kalairos_describe", { address: "claim:D-101", validAt: "2026-05-01" }), null,
      "the claim was not yet true before the date of service");
    console.log("  [ok] kalairos_describe reads validAt and asOf, in ms or ISO-8601");

    assert.strictEqual(await tool("kalairos_describe", { address: "claim:D-999" }), null, "an unknown key is null, not an error");
    assert.strictEqual(await tool("kalairos_describe", { address: "claim:D-101", workspaceId: "elsewhere" }), null,
      "a key belongs to its workspace");
    assert.match(await toolError("kalairos_describe", { address: "D-101" }), /address/);
    assert.match(await toolError("kalairos_remember", { text: "Stray link", links: [{ rel: "under", to: "policy:IB-114" }] }), /key/);
    console.log("  [ok] unknown things are null; bad addresses and keyless links are refused");

    // Let any trailing writes land before checking the channel.
    await new Promise(r => setTimeout(r, 200));
    assert.deepStrictEqual(nonProtocol, [], `stdout carried non-protocol output:\n${nonProtocol.join("\n")}`);
    console.log("  [ok] stdout carried only JSON-RPC messages");
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== all MCP stdio tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
