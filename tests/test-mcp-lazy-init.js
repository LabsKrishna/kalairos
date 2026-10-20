// test-mcp-lazy-init.js — kalairos-mcp loads its engine on the first tool call.
//
// The server used to run init() before it connected, so it read the store,
// picked the embedder and started a worker thread per CPU whether or not a
// tool was ever called: about 300MB a server with the neural model. Hosts
// start a server per session, and most sessions never call a memory tool.
// Now the engine loads on the first tool call, every call that arrives while
// it loads waits on that one load, and a failed load is retried by the next
// call.
//
// Each server runs with a probe preloaded that records every init() call,
// every worker thread started, and whether the embedder module was loaded
// (init() requires it before it looks for a model). The probe also holds a
// ref'd timer, as in test-mcp-shutdown.js, so only a deliberate exit passes.
// Run: node tests/test-mcp-lazy-init.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const MCP            = path.join(__dirname, "..", "mcp.js");
const ENGINE         = path.join(__dirname, "..", "index.js");
const EMBEDDER       = fs.realpathSync(path.join(__dirname, "..", "embedder.js"));
const WORKERS        = 2; // KALAIROS_MAX_WORKERS, so one pool has a known size
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

const tail  = (text) => text.trim().split("\n").slice(-20).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Records what the server loads into `report`, one line per event. Patching
// worker_threads has to come before index.js loads, because worker-pool.js
// takes Worker from it then. `initDelayMs` holds every init() open that long,
// so calls sent together all arrive while it runs. The first `failInits`
// init() calls throw.
function probe(report, { initDelayMs = 0, failInits = 0 } = {}) {
  return `
    setInterval(() => {}, 1 << 30);
    const fs = require("fs");
    const note = (line) => fs.appendFileSync(${JSON.stringify(report)}, line + "\\n");
    const threads = require("worker_threads");
    const Worker = threads.Worker;
    threads.Worker = class extends Worker {
      constructor(...args) { note("worker"); super(...args); }
    };
    const engine = require(${JSON.stringify(ENGINE)});
    const init = engine.init;
    let inits = 0;
    engine.init = async (...args) => {
      note("init");
      const n = ++inits;
      await new Promise((resolve) => setTimeout(resolve, ${initDelayMs}));
      if (n <= ${failInits}) throw new Error("store unreadable");
      return init.apply(engine, args);
    };
    process.on("exit", () => { if (require.cache[${JSON.stringify(EMBEDDER)}]) note("embedder"); });
  `;
}

// Run fn against a fresh server with the probe loaded, then make sure it is
// gone and its directory removed whatever fn did.
async function withServer(fn, probeOptions) {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-mcp-lazy-"));
  const dataFile = path.join(dir, "data.kalairos");
  const report   = path.join(dir, "loaded.txt");
  const preload  = path.join(dir, "probe.js");
  fs.writeFileSync(preload, probe(report, probeOptions));

  // The model cache is found through the home directory, so this runs on
  // bag-of-words, as CI does, unless KALAIROS_EMBEDDER_PATH names a model.
  const child = spawn(process.execPath, ["--require", preload, MCP], {
    cwd: dir,
    env: { ...process.env, KALAIROS_DATA_FILE: dataFile, HOME: dir, USERPROFILE: dir, KALAIROS_MAX_WORKERS: String(WORKERS) },
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

    // What a host does on connect: initialize, then list the tools.
    async handshake() {
      await server.request("initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
      });
      server.send({ method: "notifications/initialized" });
      const { result } = await server.request("tools/list", {});
      return result.tools.map(t => t.name);
    },

    // Clean means on its own, within the deadline, with code 0 and no signal.
    async exitsCleanly() {
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, EXIT_WITHIN_MS, "running"); });
      const result = await Promise.race([exited, deadline]);
      clearTimeout(timer);
      assert.notEqual(result, "running", `server still running ${EXIT_WITHIN_MS}ms after its client left\n${tail(stderr)}`);
      assert.deepEqual(result, { code: 0, signal: null },
        `server exited with code ${result.code}, signal ${result.signal}\n${tail(stderr)}`);
    },

    // init() calls and worker threads so far. `embedder` is written at exit.
    loaded() {
      const lines = fs.existsSync(report) ? fs.readFileSync(report, "utf8").split("\n") : [];
      return {
        inits:    lines.filter(l => l === "init").length,
        workers:  lines.filter(l => l === "worker").length,
        embedder: lines.includes("embedder"),
      };
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
  console.log("\n=== MCP server loads its engine on first use ===\n");

  // The whole life of a session that never calls a memory tool.
  await test("an idle server never loads the engine and exits cleanly when stdin closes", async () => {
    await withServer(async (server) => {
      const tools = await server.handshake();
      assert.ok(tools.includes("kalairos_remember"), `tools/list is served without the engine: ${tools}`);
      await sleep(1000); // long enough for a load deferred to a timer to show
      server.child.stdin.end();
      await server.exitsCleanly();
      assert.deepEqual(server.loaded(), { inits: 0, workers: 0, embedder: false },
        "no init(), no worker threads, no embedder");
    });
  });

  // Windows has no catchable SIGTERM: kill() ends the process outright.
  if (process.platform === "win32") {
    console.log("  ⏭️   SIGTERM case skipped: Windows cannot deliver a catchable signal");
  } else {
    await test("an idle server exits cleanly on SIGTERM without loading the engine", async () => {
      await withServer(async (server) => {
        await server.handshake();
        server.child.kill("SIGTERM");
        await server.exitsCleanly();
        assert.deepEqual(server.loaded(), { inits: 0, workers: 0, embedder: false });
      });
    });
  }

  // Also the probe's positive control: it sees a load when there is one.
  await test("the first tool call loads the engine and works, and later calls reuse it", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const { id } = await server.call("kalairos_remember", { text: FACT });
      assert.ok(id, "the write returned an entity id");
      const recall = await server.call("kalairos_recall", { text: "when do deploys go out?" });
      assert.equal(recall.results?.[0]?.text, FACT, "recall finds the write");
      const status = await server.call("kalairos_status", {});
      assert.ok(status, "a third call is answered");
      server.child.stdin.end();
      await server.exitsCleanly();
      assert.deepEqual(server.loaded(), { inits: 1, workers: WORKERS, embedder: true },
        "one init(), one pool, the embedder looked for");
      assert.ok(server.stored(FACT), "the write is on disk");
    });
  });

  // Without one shared load, each of these would run init() itself, and each
  // init() would tear down the pool and store the previous one set up.
  await test("concurrent first calls run init() once", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const facts = [
        FACT,
        "The staging database is reset nightly",
        "The on-call rotation changes every Monday",
        "Backups are kept for thirty days",
        "The billing service is written in Go",
      ];
      const replies = await Promise.all(facts.map(text => server.call("kalairos_remember", { text })));
      assert.equal(new Set(replies.map(r => r.id)).size, facts.length, "every call got its own entity");
      server.child.stdin.end();
      await server.exitsCleanly();
      assert.deepEqual(server.loaded(), { inits: 1, workers: WORKERS, embedder: true }, "one init(), one pool");
      for (const text of facts) assert.ok(server.stored(text), `"${text}" is on disk`);
    }, { initDelayMs: 300 });
  });

  // A failure is the error of every call that waited on that load, and it is
  // not kept: the next call loads again.
  await test("a failed load is a tool error, and the next call loads again", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const first = await Promise.all([
        server.request("tools/call", { name: "kalairos_remember", arguments: { text: FACT } }),
        server.request("tools/call", { name: "kalairos_status", arguments: {} }),
      ]);
      for (const { result } of first) {
        assert.equal(result.isError, true, `expected a tool error, got ${JSON.stringify(result)}`);
        assert.match(result.content[0].text, /kalairos failed to load: store unreadable/);
      }
      assert.equal(server.loaded().inits, 1, "the waiting calls shared one load");
      const { id } = await server.call("kalairos_remember", { text: FACT });
      assert.ok(id, "the next call loaded the engine and wrote");
      assert.equal(server.loaded().inits, 2);
      server.child.stdin.end();
      await server.exitsCleanly();
      assert.ok(server.stored(FACT), "the write is on disk");
    }, { initDelayMs: 300, failInits: 1 });
  });

  // The client sends its first call and leaves while the engine is still
  // loading. Shutdown waits for the load and the write, then flushes.
  await test("a first call sent as stdin closes is answered and lands", async () => {
    await withServer(async (server) => {
      await server.handshake();
      const reply = server.call("kalairos_remember", { text: FACT });
      server.child.stdin.end();
      const { id } = await reply;
      assert.ok(id, "the call was answered with an entity id");
      await server.exitsCleanly();
      assert.equal(server.loaded().inits, 1);
      assert.ok(server.stored(FACT), "the write is on disk");
    }, { initDelayMs: 300 });
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  process.exit(failed === 0 ? 0 : 1);
})();
