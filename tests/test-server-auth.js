// test-server-auth.js — The /auth/* routes must be protected once auth is on.
//
// They used to carry no auth check at all: with auth enabled, an anonymous
// caller could mint itself an owner token, or POST /auth/disable and then read
// every memory. Enabling auth protected nothing. This drives the real server
// over HTTP so the routes are tested as deployed, middleware included.
// Run: node tests/test-server-auth.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-auth-"));
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, route, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForServer(child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try { await fetch(`${BASE}/auth/status`); return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

(async () => {
  console.log("\n=== server auth routes ===\n");

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      KALAIROS_PORT: String(PORT),
      KALAIROS_HOST: "127.0.0.1",
      KALAIROS_DATA_FILE: path.join(dir, "data.kalairos"),
      KALAIROS_RATE_LIMIT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });

  try {
    await waitForServer(child);

    // ── 1. Bootstrap while auth is off ──────────────────────────────────────
    let r = await call("POST", "/auth/enable");
    assert.strictEqual(r.status, 400, "enabling with no owner would lock everyone out");
    console.log("  [ok] auth cannot be enabled before an owner exists");

    const alice = (await call("POST", "/auth/principals", { body: { id: "alice", name: "Alice", workspaces: { default: "owner" } } })).body.principal.token;
    const carol = (await call("POST", "/auth/principals", { body: { id: "carol", name: "Carol", workspaces: { teamb: "owner" } } })).body.principal.token;
    const bob   = (await call("POST", "/auth/principals", { body: { id: "bob", name: "Bob", workspaces: { default: "read" } } })).body.principal.token;
    assert.ok(alice && carol && bob, "principals are created while auth is off");
    r = await call("POST", "/auth/enable");
    assert.strictEqual(r.status, 200);
    console.log("  [ok] open bootstrap: create an owner, then enable");

    // ── 2. Anonymous callers are refused everywhere ─────────────────────────
    for (const [method, route, body] of [
      ["POST", "/auth/disable"],
      ["POST", "/auth/enable"],
      ["POST", "/auth/principals", { id: "mallory", name: "M", workspaces: { default: "owner" } }],
      ["GET", "/auth/principals"],
      ["DELETE", "/auth/principals/alice"],
      ["POST", "/auth/grant", { principalId: "bob", workspaceId: "default", role: "owner" }],
      ["POST", "/auth/revoke", { principalId: "alice", workspaceId: "default" }],
      ["GET", "/auth/audit"],
      ["POST", "/query", { text: "anything" }],
    ]) {
      r = await call(method, route, { body });
      assert.strictEqual(r.status, 401, `${method} ${route} without a token must be 401, got ${r.status}`);
    }
    console.log("  [ok] every auth route refuses an anonymous caller");

    r = await call("GET", "/auth/status");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.enabled, true, "anonymous attempts did not turn auth off");
    console.log("  [ok] /auth/status stays readable and auth is still on");

    // ── 3. Non-owners are refused ───────────────────────────────────────────
    r = await call("POST", "/auth/disable", { token: bob });
    assert.strictEqual(r.status, 403, "a read-only principal cannot disable auth");
    r = await call("POST", "/auth/grant", { token: bob, body: { principalId: "bob", workspaceId: "default", role: "owner" } });
    assert.strictEqual(r.status, 403, "a read-only principal cannot promote itself");
    console.log("  [ok] a non-owner cannot disable auth or promote itself");

    // ── 4. Owners act only on workspaces they own ───────────────────────────
    r = await call("POST", "/auth/grant", { token: alice, body: { principalId: "bob", workspaceId: "teamb", role: "read" } });
    assert.strictEqual(r.status, 403, "alice does not own teamb");
    r = await call("POST", "/auth/principals", { token: alice, body: { id: "dave", name: "Dave", workspaces: { teamb: "read" } } });
    assert.strictEqual(r.status, 403, "alice cannot hand out roles on teamb");
    r = await call("DELETE", "/auth/principals/carol", { token: alice });
    assert.strictEqual(r.status, 403, "alice cannot remove a teamb owner");
    r = await call("POST", "/auth/grant", { token: alice, body: { principalId: "bob", workspaceId: "default", role: "write" } });
    assert.strictEqual(r.status, 200, "alice can grant on her own workspace");
    console.log("  [ok] an owner manages only the workspaces it owns");

    r = await call("POST", "/auth/principals", { token: alice, body: { id: "carol", name: "Impostor", workspaces: { default: "read" } } });
    assert.strictEqual(r.status, 400, "re-adding an existing id must not overwrite it");
    console.log("  [ok] an existing principal cannot be overwritten");

    r = await call("GET", "/auth/principals", { token: carol });
    const visible = r.body.principals.map(p => p.id).sort();
    assert.deepStrictEqual(visible, ["carol"], "carol sees only principals in teamb");
    console.log("  [ok] owners list only principals in their workspaces");

    r = await call("GET", "/auth/audit", { token: alice, body: undefined });
    const grant = r.body.log.find(e => e.action === "grant");
    assert.strictEqual(grant?.principalId, "alice", "the audit log records who granted");
    console.log("  [ok] audit entries record the acting principal");

    // ── 5. Disabling takes an owner of every workspace ──────────────────────
    r = await call("POST", "/auth/disable", { token: alice });
    assert.strictEqual(r.status, 403, "alice cannot open teamb by disabling auth");
    r = await call("POST", "/auth/grant", { token: carol, body: { principalId: "alice", workspaceId: "teamb", role: "owner" } });
    assert.strictEqual(r.status, 200);
    r = await call("POST", "/auth/disable", { token: alice });
    assert.strictEqual(r.status, 200, "an owner of every workspace can disable auth");
    r = await call("POST", "/query", { body: { text: "anything" } });
    assert.strictEqual(r.status, 200, "with auth off the server is open again");
    console.log("  [ok] only an owner of every workspace can switch auth off");
  } catch (err) {
    console.error(stderr.split("\n").slice(-15).join("\n"));
    throw err;
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== all server auth tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
