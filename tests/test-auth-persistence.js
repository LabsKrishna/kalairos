// test-auth-persistence.js — Auth state must survive a restart.
//
// Principals, tokens, the on/off switch and the audit log used to live only in
// memory. A restarted server came back with auth off and served every memory
// to anyone who could reach the port, which in Docker (KALAIROS_HOST=0.0.0.0)
// is the network. These tests boot the real server, stop it, and boot it again
// on the same data file. Servers are stopped with SIGKILL unless a test is
// about a graceful stop, so what survives is what each change saved before its
// response, not what shutdown() wrote.
//
// The last test drives the engine in-process: the store hook (loadAuth /
// saveAuth) that a store such as Postgres implements, and ":memory:".
// Run: node tests/test-auth-persistence.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const freePort = require("./free-port");

const SERVER  = path.join(__dirname, "..", "server.js");
// Windows has no SIGTERM: kill() always terminates, so a graceful stop can't
// be tested there. POSIX file modes don't apply either.
const WINDOWS = process.platform === "win32";

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tail  = (text) => text.trim().split("\n").slice(-15).join("\n");

// Boot server.js on dir's data file. Resolves once it answers (ready: true),
// or once it exits without ever answering (ready: false), as a refused boot
// does. Every child goes into `servers` before anything can throw, so the
// caller can wait for all of them to exit.
async function boot(dir, env, servers) {
  const port  = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      KALAIROS_PORT:         String(port),
      KALAIROS_HOST:         "127.0.0.1",
      KALAIROS_DATA_FILE:    path.join(dir, "data.kalairos"),
      KALAIROS_RATE_LIMIT:   "0",
      // Bag-of-words: nothing here depends on the embedder, and it boots fast.
      HOME:                  dir,
      USERPROFILE:           dir,
      KALAIROS_MODEL_DIR:    path.join(dir, "no-model"),
      // Only what a test passes; never the caller's shell.
      KALAIROS_REQUIRE_AUTH: undefined,
      KALAIROS_ADMIN_TOKEN:  undefined,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  const server = {
    child,
    base:   `http://127.0.0.1:${port}`,
    exited: new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal }))),
    output: () => output,
    ready:  false,
  };
  servers.push(server);

  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null || child.signalCode !== null) { await server.exited; return server; }
    try { await fetch(`${server.base}/auth/status`); server.ready = true; return server; } catch {}
    await sleep(250);
  }
  throw new Error("server did not start within 40s");
}

// kill() only sends the signal. Resolves once the process is gone.
function stop(server, signal = "SIGKILL") {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill(signal);
  return server.exited;
}

// A fresh data directory. It is removed only after every server started in it
// has exited: a server still running writes into it (ENOTEMPTY on rmSync), and
// Windows refuses to remove a live process's cwd (EBUSY).
async function withDir(fn) {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-auth-state-"));
  const servers = [];
  const start   = async (env = {}) => boot(dir, env, servers);
  try {
    await fn({ start, authFile: path.join(dir, "data.kalairos.auth"), output: () => servers.map(s => s.output()).join("\n") });
  } catch (e) {
    const last = servers[servers.length - 1];
    if (last) e.message += `\n       --- server output ---\n${tail(last.output())}`;
    throw e;
  } finally {
    await Promise.all(servers.map(s => stop(s)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function call(server, method, route, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(server.base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function addPrincipal(server, principal, token) {
  const r = await call(server, "POST", "/auth/principals", { token, body: principal });
  assert.equal(r.status, 200, `creating ${principal.id}: ${JSON.stringify(r.body)}`);
  return r.body.principal.token;
}

(async () => {
  console.log("\n=== auth state survives a restart ===\n");

  await test("a restart keeps auth on, the tokens valid and the audit log", () => withDir(async ({ start, authFile }) => {
    let s = await start();
    const alice = await addPrincipal(s, { id: "alice", name: "Alice", workspaces: { default: "owner" } });
    const bob   = await addPrincipal(s, { id: "bob",   name: "Bob",   workspaces: { default: "read" } });
    const temp  = await addPrincipal(s, { id: "temp",  name: "Temp",  workspaces: { default: "read" } });
    assert.equal((await call(s, "POST", "/auth/enable")).status, 200);
    assert.equal((await call(s, "POST", "/ingest", { token: alice, body: { text: "The on-call rotation changes every Monday" } })).status, 200);
    assert.equal((await call(s, "POST", "/auth/grant", { token: alice, body: { principalId: "bob", workspaceId: "default", role: "write" } })).status, 200);
    assert.equal((await call(s, "DELETE", "/auth/principals/temp", { token: alice })).status, 200);
    await stop(s); // SIGKILL: no shutdown flush

    s = await start();
    assert.deepEqual((await call(s, "GET", "/auth/status")).body, { enabled: true, required: false, principals: 2 },
      "auth comes back on, with its principals");
    const actions = (await call(s, "GET", "/auth/audit", { token: alice })).body.log.map(e => e.action);
    assert.deepEqual(actions, ["principal_created", "principal_created", "principal_created", "auth_enabled", "ingest", "grant", "principal_removed"],
      "the audit log comes back, including the ingest saved along with the grant after it");
    assert.equal((await call(s, "POST", "/query", { body: { text: "on-call" } })).status, 401, "an anonymous caller is still refused");
    assert.equal((await call(s, "POST", "/query", { token: temp, body: { text: "on-call" } })).status, 401, "a removed principal stays removed");
    assert.equal((await call(s, "POST", "/query", { token: "f".repeat(64), body: { text: "on-call" } })).status, 401);
    assert.equal((await call(s, "GET", "/auth/principals", { token: alice })).status, 200, "the owner's token still works");
    assert.equal((await call(s, "POST", "/ingest", { token: bob, body: { text: "Bob can write after the restart" } })).status, 200,
      "the grant survives");

    const saved = fs.readFileSync(authFile, "utf8");
    for (const t of [alice, bob, temp]) assert.ok(!saved.includes(t), "no plaintext token is saved");
    if (!WINDOWS) assert.equal(fs.statSync(authFile).mode & 0o777, 0o600, "the auth file is readable by its owner only");

    if (!WINDOWS) {
      // Bob's ingest came after the last change was saved; a graceful stop saves it.
      await stop(s, "SIGTERM");
      s = await start();
      const last = (await call(s, "GET", "/auth/audit", { token: alice })).body.log.at(-1);
      assert.deepEqual([last.action, last.principalId], ["ingest", "bob"], "a graceful stop saves the audit entries since the last change");
    }
  }));

  await test("a failed save rejects the change and leaves memory and disk as they were", () => withDir(async ({ start, authFile }) => {
    let s = await start();
    const alice = await addPrincipal(s, { id: "alice", name: "Alice", workspaces: { default: "owner" } });
    const bob   = await addPrincipal(s, { id: "bob",   name: "Bob",   workspaces: { default: "read" } });
    assert.equal((await call(s, "POST", "/auth/enable")).status, 200);
    const savedBefore = fs.readFileSync(authFile);
    const auditBefore = (await call(s, "GET", "/auth/audit", { token: alice })).body.log;

    // A directory where the save writes its tmp file makes every save fail.
    fs.mkdirSync(authFile + ".tmp");
    const mallory = "m".repeat(40);
    for (const [method, route, body] of [
      ["POST", "/auth/principals", { id: "mallory", name: "Mallory", workspaces: { default: "owner" }, token: mallory }],
      ["POST", "/auth/grant", { principalId: "bob", workspaceId: "default", role: "owner" }],
      ["POST", "/auth/revoke", { principalId: "bob", workspaceId: "default" }],
      ["DELETE", "/auth/principals/bob"],
      ["POST", "/auth/disable"],
    ]) {
      const r = await call(s, method, route, { token: alice, body });
      assert.equal(r.status, 500, `${method} ${route} must fail when its save fails, got ${r.status}`);
      assert.equal(r.body.error, "ERR_PERSIST_FAILED");
    }

    assert.deepEqual((await call(s, "GET", "/auth/status")).body, { enabled: true, required: false, principals: 2 },
      "auth is still on, with the same principals");
    assert.equal((await call(s, "POST", "/query", { token: mallory, body: { text: "x" } })).status, 401, "the principal whose save failed doesn't exist");
    assert.equal((await call(s, "POST", "/query", { token: bob, body: { text: "x" } })).status, 200, "bob is still there");
    assert.equal((await call(s, "POST", "/ingest", { token: bob, body: { text: "Bob tries to write" } })).status, 403, "and still read-only");
    assert.deepEqual((await call(s, "GET", "/auth/audit", { token: alice })).body.log, auditBefore, "no failed change left an audit entry");
    assert.deepEqual(fs.readFileSync(authFile), savedBefore, "the saved state is untouched");

    // Once saving works again, so do changes, and a restart keeps them.
    fs.rmdirSync(authFile + ".tmp");
    assert.equal((await call(s, "POST", "/auth/grant", { token: alice, body: { principalId: "bob", workspaceId: "default", role: "write" } })).status, 200);
    await stop(s);
    s = await start();
    assert.equal((await call(s, "POST", "/ingest", { token: bob, body: { text: "Bob writes after the restart" } })).status, 200);
    assert.equal((await call(s, "POST", "/query", { token: mallory, body: { text: "x" } })).status, 401);
  }));

  await test("an unreadable auth file stops the boot instead of starting with auth off", () => withDir(async ({ start, authFile }) => {
    fs.writeFileSync(authFile, '{"version":1,"enabled":tru');
    const s = await start();
    assert.equal(s.ready, false, "the port never opens");
    assert.notEqual((await s.exited).code, 0);
    assert.match(s.output(), /holds the auth state and is not valid JSON/);
  }));

  await test("the last owner can't be removed or demoted while auth is on", () => withDir(async ({ start }) => {
    let s = await start();
    const alice = await addPrincipal(s, { id: "alice", name: "Alice", workspaces: { default: "owner" } });
    assert.equal((await call(s, "POST", "/auth/enable")).status, 200);
    for (const [method, route, body] of [
      ["DELETE", "/auth/principals/alice"],
      ["POST", "/auth/revoke", { principalId: "alice", workspaceId: "default" }],
      ["POST", "/auth/grant", { principalId: "alice", workspaceId: "default", role: "admin" }],
    ]) {
      const r = await call(s, method, route, { token: alice, body });
      assert.equal(r.status, 400, `${method} ${route} would leave no owner, got ${r.status}`);
    }
    await stop(s);
    s = await start();
    assert.equal((await call(s, "GET", "/auth/principals", { token: alice })).status, 200, "alice is still an owner after a restart");
  }));

  await test("KALAIROS_REQUIRE_AUTH=1 refuses to start open and refuses /auth/disable", () => withDir(async ({ start, authFile }) => {
    let s = await start({ KALAIROS_REQUIRE_AUTH: "1" });
    assert.equal(s.ready, false, "a store with no auth state never opens its port");
    assert.equal((await s.exited).code, 1);
    assert.match(s.output(), /Not starting: KALAIROS_REQUIRE_AUTH=1/);
    assert.ok(!fs.existsSync(authFile), "a refused boot saves nothing");

    s = await start();
    const alice = await addPrincipal(s, { id: "alice", name: "Alice", workspaces: { default: "owner" } });
    await stop(s);
    s = await start({ KALAIROS_REQUIRE_AUTH: "1" });
    assert.equal(s.ready, false, "an owner with auth off is refused too");
    assert.equal((await s.exited).code, 1);

    s = await start({ KALAIROS_REQUIRE_AUTH: "yes" });
    assert.equal(s.ready, false, "a value other than 1 or 0 stops the boot instead of reading as off");
    assert.match(s.output(), /KALAIROS_REQUIRE_AUTH must be 1 or 0/);

    s = await start();
    assert.equal((await call(s, "POST", "/auth/enable")).status, 200);
    await stop(s);
    s = await start({ KALAIROS_REQUIRE_AUTH: "1" });
    assert.equal(s.ready, true, "auth on with an owner starts");
    assert.deepEqual((await call(s, "GET", "/auth/status")).body, { enabled: true, required: true, principals: 1 });
    assert.equal((await call(s, "POST", "/auth/disable", { token: alice })).status, 403, "an owner of every workspace can't disable auth");
    assert.equal((await call(s, "POST", "/auth/disable")).status, 401);
    assert.equal((await call(s, "GET", "/auth/status")).body.enabled, true);
  }));

  await test("KALAIROS_ADMIN_TOKEN bootstraps one owner exactly once and is never logged", () => withDir(async ({ start, authFile, output }) => {
    const T1 = "a1".repeat(32), T2 = "b2".repeat(32), WEAK = "hunter2hunter2";
    // Data in a second workspace, written while the server ran open.
    let s = await start();
    assert.equal((await call(s, "POST", "/ingest", { body: { text: "Acme renews its contract in March", workspaceId: "acme" } })).status, 200);
    await stop(s);

    s = await start({ KALAIROS_ADMIN_TOKEN: WEAK });
    assert.equal(s.ready, false, "a weak token stops the boot");
    assert.match(s.output(), /KALAIROS_ADMIN_TOKEN must be at least 32 characters/);
    assert.ok(!fs.existsSync(authFile));

    // Locked from its first boot, as a container comes up.
    s = await start({ KALAIROS_ADMIN_TOKEN: T1, KALAIROS_REQUIRE_AUTH: "1" });
    assert.equal(s.ready, true, "the token bootstraps what KALAIROS_REQUIRE_AUTH needs");
    assert.deepEqual((await call(s, "GET", "/auth/status")).body, { enabled: true, required: true, principals: 1 });
    assert.equal((await call(s, "POST", "/query", { body: { text: "renews" } })).status, 401);
    const principals = (await call(s, "GET", "/auth/principals", { token: T1 })).body.principals;
    assert.deepEqual(principals.map(p => [p.id, p.workspaces]), [["admin", { default: "owner", acme: "owner" }]],
      "one owner, of default and of every workspace already in the store");
    assert.equal((await call(s, "POST", "/query", { token: T1, body: { text: "when does Acme renew" } })).status, 200);
    await stop(s);

    // A different token on a later boot: no second owner, and the first token stands.
    s = await start({ KALAIROS_ADMIN_TOKEN: T2, KALAIROS_REQUIRE_AUTH: "1" });
    assert.equal((await call(s, "GET", "/auth/status")).body.principals, 1, "no second bootstrap");
    assert.equal((await call(s, "GET", "/auth/principals", { token: T2 })).status, 401, "the later token is not an owner");
    assert.equal((await call(s, "GET", "/auth/principals", { token: T1 })).status, 200, "the first token still is");
    assert.match(s.output(), /KALAIROS_ADMIN_TOKEN not used: principals already exist/);
    await stop(s);

    const saved = fs.readFileSync(authFile, "utf8");
    for (const t of [T1, T2, WEAK]) {
      assert.ok(!output().includes(t), "no token is ever logged");
      assert.ok(!saved.includes(t), "or saved in plaintext");
    }
  }));

  await test("KALAIROS_ADMIN_TOKEN is ignored on a store that already has principals", () => withDir(async ({ start }) => {
    let s = await start();
    await addPrincipal(s, { id: "alice", name: "Alice", workspaces: { default: "owner" } });
    await stop(s);
    s = await start({ KALAIROS_ADMIN_TOKEN: "c3".repeat(32) });
    assert.deepEqual((await call(s, "GET", "/auth/principals")).body.principals.map(p => p.id), ["alice"], "no admin was created");
    assert.equal((await call(s, "GET", "/auth/status")).body.enabled, false, "and auth stays as it was saved");
  }));

  await test("the engine keeps auth state through a store's loadAuth/saveAuth, and in memory for :memory:", async () => {
    const lib = require("../index");
    const { FileStore } = require("../store/file-store");
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-auth-hook-"));
    const opts = (dataFile) => ({ dataFile, embedFn: async () => [1, 0], embeddingDim: 2 });
    try {
      // The fallback file, then a :memory: store, which saves auth state nowhere.
      const fileA = path.join(dir, "a.kalairos");
      await lib.init(opts(fileA));
      lib.auth.addPrincipal({ id: "ops", name: "Ops", workspaces: { default: "owner" } });
      const savedA = fs.readFileSync(fileA + ".auth", "utf8");
      await lib.init(opts(":memory:"));
      lib.auth.addPrincipal({ id: "temp", name: "Temp", workspaces: { default: "read" } });
      lib.auth.enable();
      assert.equal(lib.auth.getPrincipal("temp").id, "temp", "a :memory: store keeps auth state in memory");
      assert.equal(fs.readFileSync(fileA + ".auth", "utf8"), savedA, "and no longer saves into the previous store's file");

      // A store that keeps auth state itself, as the Postgres store will.
      let saved = null, saves = 0, mode = "ok";
      const fileB = path.join(dir, "b.kalairos");
      FileStore.prototype.loadAuth = function (config) {
        assert.equal(config.dataFile, fileB);
        return saved && JSON.parse(saved);
      };
      FileStore.prototype.saveAuth = function (state, config) {
        assert.equal(config.dataFile, fileB);
        saves++;
        if (mode === "throw") throw new Error("database unavailable");
        if (mode === "promise") return Promise.resolve();
        saved = JSON.stringify(state);
      };
      await lib.init(opts(fileB));
      assert.equal(lib.auth.listPrincipals().length, 0, "init replaces what was in memory with the store's state (none yet)");
      const { token } = lib.auth.addPrincipal({ id: "ops", name: "Ops", workspaces: { default: "owner" } });
      lib.auth.enable();
      assert.equal(saves, 2, "each change is saved");
      assert.ok(!fs.existsSync(fileB + ".auth"), "the store keeps it, not a file");
      assert.ok(!saved.includes(token), "the store gets hashes, never tokens");

      for (const m of ["throw", "promise"]) {
        mode = m;
        assert.throws(() => lib.auth.grant("ops", "north", "read"), (e) => e.code === "ERR_PERSIST_FAILED",
          `a save that ${m === "throw" ? "throws" : "returns a promise"} rejects the change`);
        assert.equal(lib.auth.getPrincipal("ops").workspaces.north, undefined, "and the change is undone");
      }
      mode = "ok";

      await lib.init(opts(fileB)); // an in-process restart
      assert.equal(lib.auth.enabled, true, "loadAuth's state comes back");
      assert.equal(lib.auth.authenticate(token)?.id, "ops");
    } finally {
      await lib.shutdown();
      delete FileStore.prototype.loadAuth;
      delete FileStore.prototype.saveAuth;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${passed + failed} passed ${failed === 0 ? "✅" : "❌"}`);
  console.log("────────────────────────────────────────────────────────────\n");
  process.exit(failed === 0 ? 0 : 1);
})();
