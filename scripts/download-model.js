#!/usr/bin/env node
"use strict";
// Download the ONNX embedder model to ~/.kalairos/.
//
// Runs two ways:
//   - as npm postinstall: best effort, exits 0 on failure, never blocks install
//   - as `kalairos model`: explicit, reports failure with a non-zero exit
//
// The second exists because many installs never run postinstall at all
// (pnpm and bun block dependency scripts by default; --ignore-scripts; CI).
// Without the model, kalairos falls back to a bag-of-words embedder that
// misses paraphrases and rarely detects that a new fact updates an old one.
//
// Env overrides:
//   KALAIROS_SKIP_DOWNLOAD=1     — skip entirely in postinstall (CI, Docker, offline)
//   KALAIROS_MODEL_URL=<url>     — custom mirror
//   KALAIROS_MODEL_SHA256=<hex>  — expected digest for a custom mirror
//   KALAIROS_MODEL_DIR=<path>    — custom cache dir (embedder.js reads it too)

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

const VERSION = require("../package.json").version;

// The model is its own artifact, published once as a release asset. It is
// pinned here rather than derived from the package version: deriving it
// pointed every release at a v<version>/model_int8.onnx that was never
// uploaded, so no install ever fetched the model.
const MODEL_URL    = "https://github.com/LabsKrishna/kalairos/releases/download/v1.6.0/model.onnx";
const MODEL_SHA256 = "ffed59b418b025eb4dfa47f076f532a2996fedbe40c1439110663b648eccebd6";
const MODEL_BYTES  = 110_273_656;

const MODEL_DIR  = process.env.KALAIROS_MODEL_DIR || path.join(os.homedir(), ".kalairos");
const MODEL_PATH = path.join(MODEL_DIR, "model.onnx");
const TOK_SRC    = path.join(__dirname, "..", "tokenizer.json");
const TOK_DST    = path.join(MODEL_DIR, "tokenizer.json");

function log(msg) { process.stderr.write(`[kalairos] ${msg}\n`); }

function download(url, dest, redirects) {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  const proto = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const req = proto.get(url, { headers: { "User-Agent": `kalairos/${VERSION}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const total = parseInt(res.headers["content-length"], 10) || 0;
      let downloaded = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(dest);

      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.floor(downloaded / total * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            log(`downloading model... ${pct}%`);
            lastPct = pct;
          }
        }
      });

      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(downloaded)));
      file.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function ensureTokenizer() {
  if (!fs.existsSync(TOK_DST) && fs.existsSync(TOK_SRC)) fs.copyFileSync(TOK_SRC, TOK_DST);
}

/**
 * Fetch the model into MODEL_DIR unless it is already there.
 * Resolves to the model path; rejects on any failure, leaving no partial file.
 */
async function downloadModel({ force = false } = {}) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  if (!force && fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 50 * 1024 * 1024) {
    ensureTokenizer();
    log(`model already cached at ${MODEL_PATH}`);
    return MODEL_PATH;
  }

  // A custom mirror is trusted to the digest its operator supplies, if any.
  // The default URL is always checked against the pinned digest.
  const url      = process.env.KALAIROS_MODEL_URL || MODEL_URL;
  const expected = process.env.KALAIROS_MODEL_URL ? (process.env.KALAIROS_MODEL_SHA256 || "") : MODEL_SHA256;
  const tmp      = MODEL_PATH + ".tmp";

  log(`downloading neural embedder (~${Math.round(MODEL_BYTES / 1024 / 1024)} MB)`);
  log(`  from: ${url}`);
  log(`  to:   ${MODEL_PATH}`);

  try {
    await download(url, tmp, 0);
    // Verify before the file becomes visible as model.onnx, so a bad or
    // truncated download is never loaded.
    if (expected) {
      const actual = await sha256Of(tmp);
      if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
      log("SHA256 verified");
    }
    fs.renameSync(tmp, MODEL_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }

  ensureTokenizer();
  log("neural embedder ready (768-dim)");
  return MODEL_PATH;
}

// npm postinstall: best effort only.
async function postinstall() {
  if (process.env.KALAIROS_SKIP_DOWNLOAD === "1") {
    log("KALAIROS_SKIP_DOWNLOAD=1, skipping model download");
    return;
  }
  if (process.env.CI === "true" && !process.env.KALAIROS_FORCE_DOWNLOAD) {
    log("CI detected, skipping model download (set KALAIROS_FORCE_DOWNLOAD=1 to override)");
    return;
  }
  try {
    await downloadModel();
  } catch (err) {
    log(`model download failed: ${err.message}`);
    log("kalairos will use its built-in bag-of-words embedder until you run: npx kalairos model");
  }
}

module.exports = { downloadModel, MODEL_URL, MODEL_SHA256, MODEL_DIR };

if (require.main === module) postinstall();
