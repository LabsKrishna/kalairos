#!/usr/bin/env node
"use strict";
// postinstall: download the ONNX embedder model to ~/.kalairos/
// Exits 0 on failure — never blocks npm install.
//
// Env overrides:
//   KALAIROS_SKIP_DOWNLOAD=1     — skip entirely (CI, Docker, offline)
//   KALAIROS_MODEL_URL=<url>     — custom mirror
//   KALAIROS_MODEL_DIR=<path>    — custom cache dir

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const crypto = require("crypto");

const VERSION  = require("../package.json").version;
const MODEL_SHA256 = process.env.KALAIROS_MODEL_SHA256 || "";
const DEFAULT_URL  = `https://github.com/LabsKrishna/kalairos/releases/download/v${VERSION}/model_int8.onnx`;
const MODEL_DIR    = process.env.KALAIROS_MODEL_DIR || path.join(os.homedir(), ".kalairos");
const MODEL_PATH   = path.join(MODEL_DIR, "model.onnx");
const TOK_SRC      = path.join(__dirname, "..", "tokenizer.json");
const TOK_DST      = path.join(MODEL_DIR, "tokenizer.json");

function log(msg) { process.stderr.write(`[kalairos] ${msg}\n`); }

function download(url, dest, redirects) {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  const proto = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const req = proto.get(url, { headers: { "User-Agent": `kalairos/${VERSION}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const total = parseInt(res.headers["content-length"], 10) || 0;
      let downloaded = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(dest + ".tmp");

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
      file.on("finish", () => {
        file.close();
        fs.renameSync(dest + ".tmp", dest);
        resolve(downloaded);
      });
      file.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

async function main() {
  if (process.env.KALAIROS_SKIP_DOWNLOAD === "1") {
    log("KALAIROS_SKIP_DOWNLOAD=1, skipping model download");
    return;
  }

  // Skip in CI environments
  if (process.env.CI === "true" && !process.env.KALAIROS_FORCE_DOWNLOAD) {
    log("CI detected, skipping model download (set KALAIROS_FORCE_DOWNLOAD=1 to override)");
    return;
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true });

  // Check if model already exists
  if (fs.existsSync(MODEL_PATH)) {
    const stat = fs.statSync(MODEL_PATH);
    if (stat.size > 50 * 1024 * 1024) {
      log(`model already cached at ${MODEL_PATH} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
      // Ensure tokenizer is there too
      if (!fs.existsSync(TOK_DST) && fs.existsSync(TOK_SRC)) {
        fs.copyFileSync(TOK_SRC, TOK_DST);
      }
      return;
    }
  }

  const url = process.env.KALAIROS_MODEL_URL || DEFAULT_URL;
  log(`downloading neural embedder (~105 MB)...`);
  log(`  from: ${url}`);
  log(`  to:   ${MODEL_PATH}`);

  try {
    const bytes = await download(url, MODEL_PATH, 0);
    log(`model downloaded (${(bytes / 1024 / 1024).toFixed(0)} MB)`);

    // Verify SHA256 if provided
    if (MODEL_SHA256) {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(MODEL_PATH);
      for await (const chunk of stream) hash.update(chunk);
      const actual = hash.digest("hex");
      if (actual !== MODEL_SHA256) {
        log(`SHA256 mismatch! expected ${MODEL_SHA256}, got ${actual}`);
        fs.unlinkSync(MODEL_PATH);
        return;
      }
      log("SHA256 verified");
    }

    // Copy tokenizer
    if (fs.existsSync(TOK_SRC)) {
      fs.copyFileSync(TOK_SRC, TOK_DST);
      log("tokenizer.json copied");
    }

    log("neural embedder ready — kalairos will use 768-dim embeddings");
  } catch (err) {
    log(`download failed: ${err.message}`);
    log("kalairos will use built-in embedder (lower quality but functional)");
    // Clean up partial download
    try { fs.unlinkSync(MODEL_PATH + ".tmp"); } catch {}
    try { fs.unlinkSync(MODEL_PATH); } catch {}
  }
}

main();
