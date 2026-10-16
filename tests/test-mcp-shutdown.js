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
// A shutdown that fails or stalls must still end the process, with code 1.
// Run: node tests/test-mcp-shutdown.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const MCP            = path.join(__dirname, "..", "mcp.js");
const ENGINE         = path.join(__dirname, "..", "index.js");
const EXIT_WITHIN_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000; // how long mcp.js lets a shutdown run before exiting 1
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

// The end of a server's stderr, for failure messages.
const tail = (text) => text.trim().split("\n").slice(-20).join("\n");

// Run fn against a fresh server, then make sure it is gone and its directory
// removed whatever fn did. `preload` is extra code run in the server before
// mcp.js, after the ref'd timer.
async function withServer(fn, { preload = "" } = {}) {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-mcp-shutdown-"));
  const dataFile = path.join(dir, "data.kalairos");
  const holdOpen = path.join(dir, "hold-open.js");
  fs.writeFileSync(holdOpen, `setInterval(() => {}, 1 << 30);\n${preload}\n`);

  // Bag-of-words everywhere, as in CI: the model cache is found through the
  // home directory, and shutdown does not depend on the embedder.
  const child = spawn(process.execPath, ["--require", holdOpen, MCP], {
    env: { ...process.env, KALAIROS_DATA_FILE: dataFile, HOME: dir, USERPROFILE: dir },
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
        const timer = setTimeout(() => reject(new Error(`${method} timed out\n${tail(stderr)}`)), 60_000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        exited.then(({ code, signal }) => {
          clearTimeout(timer);
          reject(new Error(`server exited (code ${code}, signal ${signal}) before answering ${method}\n${tail(stderr)}`));
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

    // Resolves to how the server exited, failing if it is still running after `within` ms.
    async exit(within = EXIT_WITHIN_MS) {
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, within, "running"); });
      const result = await Promise.race([exited, deadline]);
      clearTimeout(timer);
      assert.notEqual(result, "running", `server still running ${within}ms after its client left\n${tail(stderr)}`);
      return result;
    },

    // Clean means on its own, within the deadline, with code 0 and no signal.
    async exitsCleanly() {
      const result = await server.exit();
      assert.deepEqual(result, { code: 0, signal: null },
        `server exited with code ${result.code}, signal ${result.signal}\n${tail(stderr)}`);
    },

    stored(text) {
      if (!fs.existsSync(dataFile)) return false;
      return fs.readFileSync(dataFile, "utf8").split("\n").filter(Boolean)
        .some(line => JSON.parse(line).text === text);
    },

    child,
    stderr: () => stderr,
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

  // A host that crashes closes all three pipes at once. The write it sent
  // last still lands, and neither the reply nor a log line, both with nowhere
  // to go, may crash the server before it has flushed.
  await test("exits cleanly when the client vanishes mid-request", async () => {
    await withServer(async (server) => {
      await server.handshake();
      server.send({ id: 99, method: "tools/call", params: { name: "kalairos_remember", arguments: { text: FACT } } });
      server.child.stdin.end();
      server.child.stdout.destroy();
      server.child.stderr.destroy();
      await server.exitsCleanly();
      assert.ok(server.stored(FACT), "the write is on disk");
    });
  });

  // Exiting with output still queued for stdout drops it. Here the client
  // stops reading while a reply far larger than the pipe buffers is in
  // flight, closes stdin, and reads again a moment later. The reply must
  // arrive whole before the server exits.
  await test("delivers a large last reply whole before exiting", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const items = Array.from({ length: 1000 }, (_, i) => ({ text: `Note ${i}: ${`entry${i} `.repeat(400)}` }));
      await server.call("kalairos_batch_store", { items });
      server.child.stdout.pause();
      const reply = server.call("kalairos_export", {});
      server.child.stdin.end();
      setTimeout(() => server.child.stdout.resume(), 300);
      const exported = JSON.stringify(await reply);
      assert.ok(exported.length > 500_000, `the export is too small to outgrow the pipe (${exported.length} bytes)`);
      assert.match(exported, /Note 999:/, "the reply arrived whole");
      await server.exitsCleanly();
    });
  });

  // A failed final flush must not report success.
  await test("exits 1 when the final flush fails", async () => {
    const preload = `require(${JSON.stringify(ENGINE)}).shutdown = async () => { throw new Error("disk full"); };`;
    await withServer(async (server) => {
      await server.handshake();
      server.child.stdin.end();
      const { code } = await server.exit();
      assert.equal(code, 1, tail(server.stderr()));
      assert.match(server.stderr(), /shutdown failed: disk full/);
    }, { preload });
  });

  // The process must not outlive its client even when shutdown hangs.
  await test("exits 1 when shutdown stalls", async () => {
    const preload = `require(${JSON.stringify(ENGINE)}).shutdown = () => new Promise(() => {});`;
    await withServer(async (server) => {
      await server.handshake();
      server.child.stdin.end();
      const { code } = await server.exit(SHUTDOWN_TIMEOUT_MS + EXIT_WITHIN_MS);
      assert.equal(code, 1, tail(server.stderr()));
      assert.match(server.stderr(), /shutdown took over 5000ms/);
    }, { preload });
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
