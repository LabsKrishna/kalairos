// test-mcp-shutdown.js — kalairos-mcp exits when its client goes away.
//
// The stdio server had no shutdown path. Nothing listened for stdin ending and
// no signal was handled, so it ran until its event loop happened to empty. On
// 1.9.0 the loop never emptied: the worker pool's idle threads held it open,
// and servers whose client had exited ran on for days at ~260MB each. 1.9.1
// unref'd those threads, but the server still lived only as long as every
// handle in the process happened to let go.
//
// Each case starts the server with a ref'd timer preloaded, standing in for
// any handle that holds the loop, so only a deliberate exit passes. A clean
// exit is prompt, with code 0, and leaves the client's last write on disk.
// Run: node tests/test-mcp-shutdown.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const MCP            = path.join(__dirname, "..", "mcp.js");
const EXIT_WITHIN_MS = 5_000;
const FACT           = "Deploys go out every Friday afternoon";

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

// Run fn against a fresh server, then make sure it is gone and its directory
// removed whatever fn did.
async function withServer(fn) {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-mcp-shutdown-"));
  const dataFile = path.join(dir, "data.kalairos");
  const holdOpen = path.join(dir, "hold-open.js");
  fs.writeFileSync(holdOpen, "setInterval(() => {}, 1 << 30);\n");

  const child = spawn(process.execPath, ["--require", holdOpen, MCP], {
    env: { ...process.env, KALAIROS_DATA_FILE: dataFile },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "", buf = "", nextId = 0;
  const pending = new Map();
  const exited  = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on("data", d => { stderr += d; });
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });

  const server = {
    send: (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"),

    request(method, params) {
      const id = ++nextId;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 60_000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        exited.then(({ code, signal }) => {
          clearTimeout(timer);
          reject(new Error(`server exited (code ${code}, signal ${signal}) before answering ${method}\n${stderr}`));
        });
      });
      server.send({ id, method, params });
      return reply;
    },

    async call(name, args) {
      const msg = await server.request("tools/call", { name, arguments: args });
      assert.ok(!msg.error && !msg.result.isError, `${name} failed: ${JSON.stringify(msg.error || msg.result)}`);
      return JSON.parse(msg.result.content[0].text);
    },

    async handshake() {
      await server.request("initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
      });
      server.send({ method: "notifications/initialized" });
    },

    // Clean means on its own, within the deadline, with code 0 and no signal.
    async exitsCleanly() {
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, EXIT_WITHIN_MS, "running"); });
      const result = await Promise.race([exited, deadline]);
      clearTimeout(timer);
      assert.notEqual(result, "running", `server still running ${EXIT_WITHIN_MS}ms after its client left\n${stderr}`);
      assert.deepEqual(result, { code: 0, signal: null },
        `server exited with code ${result.code}, signal ${result.signal}\n${stderr}`);
    },

    stored(text) {
      if (!fs.existsSync(dataFile)) return false;
      return fs.readFileSync(dataFile, "utf8").split("\n").filter(Boolean)
        .some(line => JSON.parse(line).text === text);
    },

    child,
  };

  try {
    await fn(server);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("\n=== MCP server shutdown ===\n");

  await test("exits when the client closes stdin", async () => {
    await withServer(async (server) => {
      await server.handshake();
      await server.call("kalairos_remember", { text: FACT });
      server.child.stdin.end();
      await server.exitsCleanly();
      assert.ok(server.stored(FACT), "the acknowledged write is on disk");
    });
  });

  // A client may write its last request and close stdin in the same breath,
  // then wait for the reply. Shutting down on EOF must not drop that request.
  await test("answers and stores a request sent just before stdin closes", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const reply = server.call("kalairos_remember", { text: FACT });
      server.child.stdin.end();
      const { id } = await reply;
      assert.ok(id, "the request was answered with an entity id");
      await server.exitsCleanly();
      assert.ok(server.stored(FACT), "the write is on disk");
    });
  });

  // Windows has no catchable SIGTERM or SIGINT: kill() ends the process outright.
  if (process.platform === "win32") {
    console.log("  ⏭️   SIGTERM and SIGINT cases skipped: Windows cannot deliver a catchable signal");
  } else {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      await test(`exits cleanly on ${signal}`, async () => {
        await withServer(async (server) => {
          await server.handshake();
          await server.call("kalairos_remember", { text: FACT });
          server.child.kill(signal);
          await server.exitsCleanly();
          assert.ok(server.stored(FACT), "the acknowledged write is on disk");
        });
      });
    }
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
