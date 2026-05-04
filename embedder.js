"use strict";
// Neural ONNX embedder — fine-tuned Snowflake Arctic Embed M (BERT-base, 768-dim).
// Only requires onnxruntime-node. Tokenizer is built-in (WordPiece from tokenizer.json).
//
// Expected directory layout (KALAIROS_EMBEDDER_PATH):
//   model.onnx       — exported via convert_to_onnx.py
//   tokenizer.json   — copied from kalairos-embedder-v1/

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DIM          = 768;
const MAX_LEN      = 512;

let _session = null;
let _vocab   = null;  // token → id
let _unkId   = 0;
let _clsId   = 0;
let _sepId   = 0;

// ── Minimal WordPiece tokenizer (BERT-compatible) ────────────────────────────

function _buildVocab(tokenizerJson) {
  const vocab = new Map();
  const model = tokenizerJson.model;
  if (model && model.vocab) {
    for (const [token, id] of Object.entries(model.vocab)) {
      vocab.set(token, id);
    }
  }
  return vocab;
}

function _tokenize(text) {
  // Lowercase + strip accents (BERT default)
  text = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Split on whitespace and punctuation
  const words = text.match(/[a-z0-9]+|[^\sa-z0-9]/g) || [];

  const ids = [_clsId];
  for (const word of words) {
    let remaining = word;
    let isFirst = true;
    while (remaining.length > 0) {
      let found = null;
      for (let end = remaining.length; end > 0; end--) {
        const sub = isFirst ? remaining.slice(0, end) : "##" + remaining.slice(0, end);
        if (_vocab.has(sub)) {
          found = { token: sub, len: end };
          break;
        }
      }
      if (found) {
        ids.push(_vocab.get(found.token));
        remaining = remaining.slice(found.len);
        isFirst = false;
      } else {
        ids.push(_unkId);
        remaining = remaining.slice(1);
        isFirst = false;
      }
    }
    if (ids.length >= MAX_LEN - 1) break;
  }
  ids.push(_sepId);

  // Truncate
  if (ids.length > MAX_LEN) ids.length = MAX_LEN;

  const mask = new Array(ids.length).fill(1);
  const typeIds = new Array(ids.length).fill(0);
  return { ids, mask, typeIds };
}

// ── Path resolution ──────────────────────────────────────────────────────────

function _resolveModelDir() {
  const path = require("path");
  const fs   = require("fs");
  const os   = require("os");

  const candidates = [
    process.env.KALAIROS_EMBEDDER_PATH,
    path.join(os.homedir(), ".kalairos"),
    path.join(process.cwd(), "kalairos-model"),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "model.onnx")) && fs.existsSync(path.join(dir, "tokenizer.json"))) {
      return dir;
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

async function load(modelDir) {
  const path = require("path");
  const fs   = require("fs");

  if (!modelDir) modelDir = _resolveModelDir();
  if (!modelDir) return false;

  const modelPath = path.join(modelDir, "model.onnx");
  const tokPath   = path.join(modelDir, "tokenizer.json");

  if (!fs.existsSync(modelPath) || !fs.existsSync(tokPath)) {
    return false;
  }

  let ort;
  try { ort = require("onnxruntime-node"); }
  catch { process.stderr.write("kalairos-embedder: onnxruntime-node not installed\n"); return false; }

  try {
    const tokJson = JSON.parse(fs.readFileSync(tokPath, "utf8"));
    _vocab = _buildVocab(tokJson);
    _unkId = _vocab.get("[UNK]") ?? 0;
    _clsId = _vocab.get("[CLS]") ?? 101;
    _sepId = _vocab.get("[SEP]") ?? 102;

    _session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });

    return true;
  } catch (err) {
    process.stderr.write(`kalairos-embedder: failed to load — ${err.message}\n`);
    return false;
  }
}

async function embed(text) {
  if (!_session || !_vocab) throw new Error("Embedder not loaded — call load() first");

  const ort = require("onnxruntime-node");
  const enc = _tokenize(QUERY_PREFIX + text);

  const seqLen = enc.ids.length;
  const ids     = BigInt64Array.from(enc.ids,     v => BigInt(v));
  const mask    = BigInt64Array.from(enc.mask,    v => BigInt(v));
  const typeIds = BigInt64Array.from(enc.typeIds, v => BigInt(v));

  const feeds = {
    input_ids:      new ort.Tensor("int64", ids,     [1, seqLen]),
    attention_mask: new ort.Tensor("int64", mask,    [1, seqLen]),
    token_type_ids: new ort.Tensor("int64", typeIds, [1, seqLen]),
  };

  const out = await _session.run(feeds);
  const hidden = (out.last_hidden_state ?? out[Object.keys(out)[0]]).data;

  // CLS token at position 0
  const cls = hidden.subarray(0, DIM);

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += cls[i] * cls[i];
  norm = Math.sqrt(norm) || 1;

  const result = new Array(DIM);
  for (let i = 0; i < DIM; i++) result[i] = cls[i] / norm;
  return result;
}

module.exports = { load, embed, DIM };
