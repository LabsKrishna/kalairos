// test-mcp-stdio.js — The MCP server's stdout must carry JSON-RPC and nothing else.
//
// Over stdio, stdout IS the protocol. query() used to time itself with
// console.time/timeEnd, which prints to stdout, so every kalairos_recall
// injected a "[kalairos] query: 1.1ms" line into the JSON-RPC stream.
// This drives the real server through a handshake, a write and a recall,
// and fails on any stdout line that is not a JSON-RPC message.
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

    // Let any trailing writes land before checking the channel.
    await new Promise(r => setTimeout(r, 200));
    assert.deepStrictEqual(nonProtocol, [], `stdout carried non-protocol output:\n${nonProtocol.join("\n")}`);
    console.log("  [ok] stdout carried only JSON-RPC messages");
  } finally {
    // kill() only sends the signal, and the server flushes its store into
    // `dir` as it shuts down. Wait for the exit before removing the directory.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== all MCP stdio tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
