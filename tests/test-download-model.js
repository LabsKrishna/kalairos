// test-download-model.js — The model downloader fetches, verifies, then publishes.
//
// It used to request v<package version>/model_int8.onnx, an asset no release
// ever carried, so no install ever got the neural embedder. It also renamed a
// download into place before checking its digest. Served from a local HTTP
// server so the test needs no network and no 110 MB transfer.
// Run: node tests/test-download-model.js
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs     = require("fs");
const http   = require("http");
const os     = require("os");
const path   = require("path");

const dir     = fs.mkdtempSync(path.join(os.tmpdir(), "kalairos-model-"));
const payload = crypto.randomBytes(60 * 1024 * 1024); // over the 50 MB "already cached" floor
const digest  = crypto.createHash("sha256").update(payload).digest("hex");

function freshModule(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../scripts/download-model")];
  return require("../scripts/download-model");
}

(async () => {
  console.log("\n=== model downloader ===\n");

  // ── 1. The pinned default points at a published asset, not the version ────
  const { MODEL_URL, MODEL_SHA256 } = freshModule({ KALAIROS_MODEL_DIR: dir });
  assert.match(MODEL_URL, /\/releases\/download\/v1\.6\.0\/model\.onnx$/, "the URL names the published v1.6.0 asset");
  assert.match(MODEL_SHA256, /^[0-9a-f]{64}$/, "a digest is pinned for the default URL");
  console.log("  [ok] default URL and digest are pinned to the published asset");

  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/model.onnx" }); return res.end(); }
    if (req.url === "/model.onnx") { res.writeHead(200, { "Content-Length": payload.length }); return res.end(payload); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const modelPath = path.join(dir, "model.onnx");
  const quiet = () => {}; // the downloader logs progress to stderr
  const realWrite = process.stderr.write.bind(process.stderr);

  try {
    process.stderr.write = quiet;

    // ── 2. A digest mismatch leaves nothing behind ──────────────────────────
    let mod = freshModule({ KALAIROS_MODEL_DIR: dir, KALAIROS_MODEL_URL: `${base}/model.onnx`, KALAIROS_MODEL_SHA256: "0".repeat(64) });
    await assert.rejects(mod.downloadModel(), /SHA256 mismatch/);
    assert.ok(!fs.existsSync(modelPath), "a mismatched download is never published as model.onnx");
    assert.ok(!fs.existsSync(modelPath + ".tmp"), "the partial file is cleaned up");

    // ── 3. A matching digest publishes the model and the tokenizer ──────────
    mod = freshModule({ KALAIROS_MODEL_DIR: dir, KALAIROS_MODEL_URL: `${base}/redirect`, KALAIROS_MODEL_SHA256: digest });
    assert.strictEqual(await mod.downloadModel(), modelPath);
    assert.ok(fs.readFileSync(modelPath).equals(payload), "the published file is the served bytes");
    assert.ok(fs.existsSync(path.join(dir, "tokenizer.json")), "the tokenizer is copied alongside");

    // ── 4. A 404 rejects cleanly ────────────────────────────────────────────
    mod = freshModule({ KALAIROS_MODEL_DIR: path.join(dir, "other"), KALAIROS_MODEL_URL: `${base}/missing`, KALAIROS_MODEL_SHA256: "" });
    await assert.rejects(mod.downloadModel(), /HTTP 404/);
  } finally {
    process.stderr.write = realWrite;
    server.close();
  }
  console.log("  [ok] a digest mismatch publishes nothing and cleans up");
  console.log("  [ok] a verified download (through a redirect) is published with its tokenizer");
  console.log("  [ok] a missing asset fails loudly instead of silently");

  // ── 5. The embedder looks where the downloader writes ─────────────────────
  const src = fs.readFileSync(path.join(__dirname, "..", "embedder.js"), "utf8");
  assert.match(src, /process\.env\.KALAIROS_MODEL_DIR/, "embedder.js searches KALAIROS_MODEL_DIR");
  console.log("  [ok] the embedder searches KALAIROS_MODEL_DIR");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n=== all model downloader tests passed ===\n");
})().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
