// test-process-exit.js — A script that never calls shutdown() must still exit.
//
// The worker pool's threads used to hold the event loop open, so the README
// quickstart (init, remember, query — no shutdown) printed its answer and then
// hung forever. Idle workers are now unref'd and only a job in flight holds
// the process. This runs that shape of script in a child and requires it to
// exit on its own, with its answer printed and its writes on disk.
// Run: node tests/test-process-exit.js
"use strict";

const assert = require("assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { spawn } = require("child_process");

const dir      = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-exit-"));
const dataFile = path.join(dir, "data.kalairos");
const libPath  = path.join(__dirname, "..", "index.js");

const script = `
  const kalairos = require(${JSON.stringify(libPath)});
  (async () => {
    await kalairos.init({ dataFile: ${JSON.stringify(dataFile)} });
    await kalairos.remember("Deploys go out every Friday afternoon");
    await kalairos.remember("The staging database is reset nightly");
    const { results } = await kalairos.query("when do deploys go out?");
    console.log(results.length ? results[0].text : "NO RESULTS");
  })();
`;

(async () => {
  console.log("\n=== process exits without shutdown() ===\n");

  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("hung"); }, 30_000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });

  try {
    assert.notStrictEqual(code, "hung", `the process did not exit within 30s\n${stderr}`);
    assert.strictEqual(code, 0, `exit code ${code}\n${stderr}`);
    console.log("  [ok] the process exits on its own");

    assert.match(stdout, /Friday/, "the query ran to completion before exit");
    console.log("  [ok] the query completed before the process exited");

    const rows = fs.readFileSync(dataFile, "utf8").trim().split("\n");
    assert.strictEqual(rows.length, 2, "both writes are on disk without shutdown()");
    console.log("  [ok] writes are durable without shutdown()");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== all process-exit tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
