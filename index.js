// index.js — Database X Core Engine
"use strict";

const os     = require("os");
const fs     = require("fs");
const path   = require("path");
const { cosine } = require("./kernel");
const { buildDelta }               = require("./versioning");
const { WorkerPool } = require("./worker-pool");
const { AgentMemory } = require("./agent");
const { Err, emitError, resetSignals } = require("./errors");
const { AuthStore } = require("./auth");

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  linkThreshold:      Number(process.env.DBX_LINK_THRESHOLD    || 0.72),
  versionThreshold:   Number(process.env.DBX_VERSION_THRESHOLD || 0.82),
  graphBoostWeight:   Number(process.env.DBX_GRAPH_BOOST       || 0.01),
  keywordBoostWeight: 0.05,
  llmBoostWeight:     Number(process.env.DBX_LLM_BOOST         || 0.08),
  recencyWeight:      Number(process.env.DBX_RECENCY_WEIGHT    || 0.10),
  recencyHalfLifeMs:  Number(process.env.DBX_RECENCY_HALFLIFE_DAYS || 30) * 86_400_000,
  minFinalScore:      Number(process.env.DBX_MIN_SCORE         || 0.45),
  minSemanticScore:   Number(process.env.DBX_MIN_SEMANTIC      || 0.35),
  maxVersions:        Number(process.env.DBX_MAX_VERSIONS      || 0), // 0 = unlimited
  strictEmbeddings:   (process.env.DBX_STRICT_EMBEDDINGS       || "1") !== "0",
  dataFile:           path.join(process.cwd(), "data.dbx"),
  // embedFn(text, type) — inject your own: `async (text, type) => number[]`.
  // llmFn(text, type) — inject your own: `async (text, type) => { keywords, context, llmTags, importance?, suggestedType? }`.
  // factExtractFn(text, type) — inject your own: `async (text, type) => string[]` (array of discrete fact strings).
  consolidationThreshold: Number(process.env.DBX_CONSOLIDATION_THRESHOLD || 0.78),
};

// ─── Module state ─────────────────────────────────────────────────────────────

let CFG         = { ...DEFAULTS };
let store       = new Map();   // id → entity
let _pool       = null;        // persistent WorkerPool
let _initialized = false;
let _skipIO      = false;      // suppresses per-item I/O during batch operations
const _auth      = new AuthStore();

// Monotonically increasing ID — guarantees uniqueness even within the same ms.
let _nextId = Date.now();
function _newId() { return _nextId++; }

// Canonicalizes provenance input. Accepts a string shorthand ("user", "agent", ...)
// or an object { type, uri? }. Unknown types are preserved so callers can extend.
// Canonical types: "user" | "agent" | "tool" | "file" | "system".
function _normalizeSource(input) {
  if (!input) return { type: "user" };
  if (typeof input === "string") return { type: input };
  const out = { type: input.type || "user" };
  if (input.uri)   out.uri   = String(input.uri);
  if (input.actor) out.actor = String(input.actor);
  return out;
}

// Canonicalizes sensitivity labels while allowing custom strings for caller-defined policies.
function _normalizeClassification(input) {
  if (!input) return "internal";
  return String(input).trim().toLowerCase() || "internal";
}

// Canonicalizes retention policy. Defaults to { policy: "keep", expiresAt: null }.
function _normalizeRetention(input) {
  if (!input || typeof input !== "object") return { policy: "keep", expiresAt: null };
  return {
    policy:    String(input.policy || "keep").trim().toLowerCase(),
    expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : null,
  };
}

// Canonicalizes memory type. Defaults to "long-term".
const _VALID_MEMORY_TYPES = new Set(["short-term", "long-term", "working"]);
function _normalizeMemoryType(input) {
  if (!input) return "long-term";
  const v = String(input).trim().toLowerCase();
  return _VALID_MEMORY_TYPES.has(v) ? v : "long-term";
}

// Canonicalizes workspace ID. Defaults to "default".
function _normalizeWorkspaceId(input) {
  if (!input) return "default";
  return String(input).trim() || "default";
}

// Returns true if the entity has NOT been soft-deleted.
function _isAlive(entity) { return !entity.deletedAt; }

// Returns all non-deleted entities.
function _getAllAlive() { return Array.from(store.values()).filter(_isAlive); }

// ─── Shared Entity Serialization ─────────────────────────────────────────────
// Single source of truth for entity → DTO conversion. Fields are already
// normalized at write-time, so no re-normalization needed on read.

function _serializeEntity(e, { truncateText } = {}) {
  const text = truncateText ? e.text.slice(0, truncateText) + (e.text.length > truncateText ? "…" : "") : e.text;
  return {
    id:             e.id,
    type:           e.type || "text",
    text,
    source:         e.source || { type: "user" },
    classification: e.classification || "internal",
    retention:      e.retention || { policy: "keep", expiresAt: null },
    memoryType:     e.memoryType || "long-term",
    workspaceId:    e.workspaceId || "default",
    deletedAt:      e.deletedAt || null,
    deletedBy:      e.deletedBy || null,
    metadata:       e.metadata || {},
    tags:           e.tags || [],
    linkCount:      e.links?.size || 0,
    versionCount:   e.versions?.length || 1,
    createdAt:      e.createdAt,
    updatedAt:      e.updatedAt,
  };
}

// ─── Shared Graph Unlink ─────────────────────────────────────────────────────

function _unlinkEntity(entity, entityId) {
  for (const linkedId of entity.links) {
    store.get(linkedId)?.links.delete(entityId);
  }
  entity.links.clear();
}

// ─── Guard ────────────────────────────────────────────────────────────────────

function _assertInit() {
  if (!_initialized) throw emitError(Err.notInitialized());
}

// Returns true if the entity's workspace is in the allowed set.
// When allowedWorkspaces is null/undefined, no restriction is applied.
function _wsAllowed(entity, allowedWorkspaces) {
  if (!allowedWorkspaces) return true;
  return allowedWorkspaces.includes(entity.workspaceId || "default");
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize (or reinitialize) the database.
 * Must be called before any other operation.
 * @param {object} overrides — config overrides
 * @returns {{ config: object, size: number }}
 */
async function init(overrides = {}) {
  _initialized = false; // mark as uninitialized while we set up
  resetSignals();

  // Tear down existing worker pool before creating a new one
  if (_pool) { await _pool.stop(); _pool = null; }

  CFG   = { ...DEFAULTS, ...overrides };
  store = new Map();
  _loadData();

  _pool = new WorkerPool(os.cpus().length);
  _pool.start();

  _initialized = true;
  return { config: _safeConfig(), size: store.size };
}

function _safeConfig() {
  const c = { ...CFG };
  delete c.embedFn; // don't expose internal function ref
  return c;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function _dataFile() { return CFG.dataFile || null; }

function _loadData() {
  const file = _dataFile();
  if (!file || file === ":memory:" || !fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      raw.links    = new Set(raw.links   || []);
      raw.versions = raw.versions || [];
      raw.type     = raw.type     || "text";
      raw.metadata = raw.metadata || {};
      raw.tags     = raw.tags     || [];
      const versionSource = raw.versions.find(v => v?.source)?.source;
      const versionClassification = raw.versions.find(v => v?.classification)?.classification;
      raw.source   = raw.source || versionSource || { type: "user" };
      raw.classification = _normalizeClassification(raw.classification || versionClassification);
      raw.retention  = _normalizeRetention(raw.retention);
      // Preserve soft-delete fields; default to not-deleted
      if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
        raw.deletedAt = Number(raw.deletedAt);
        raw.deletedBy = raw.deletedBy || null;
      } else {
        raw.deletedAt = null;
        raw.deletedBy = null;
      }
      // Backfill memoryType, workspaceId (added v2 schema), and llmKeywords
      raw.memoryType   = _normalizeMemoryType(raw.memoryType);
      raw.workspaceId  = _normalizeWorkspaceId(raw.workspaceId);
      if (!Array.isArray(raw.llmKeywords)) raw.llmKeywords = raw.metadata?.llm?.keywords || [];

      // Backfill missing per-version source (older data files)
      for (const v of raw.versions) if (!v.source) v.source = raw.source;
      for (const v of raw.versions) {
        v.classification = _normalizeClassification(v.classification || raw.classification);
        // Backfill per-version linkIds snapshot (older data won't have it)
        if (!Array.isArray(v.linkIds)) v.linkIds = [];
      }

      // Migrate old data: if versions are oldest-first, reverse to newest-first
      if (raw.versions.length > 1 &&
          raw.versions[0].timestamp < raw.versions[raw.versions.length - 1].timestamp) {
        raw.versions.reverse();
      }

      store.set(raw.id, raw);
    } catch (err) {
      emitError(Err.loadFailed(err.message, line.slice(0, 80)));
      console.warn("[dbx] Skipping malformed line in data file");
    }
  }
  console.log(`[dbx] Loaded ${store.size} entities`);
}

function _persistAll() {
  if (_skipIO) return;
  const file = _dataFile();
  if (!file || file === ":memory:") return;
  const tmp = file + ".tmp";
  try {
    const lines = [];
    for (const entity of store.values()) {
      lines.push(JSON.stringify({ ...entity, links: Array.from(entity.links) }));
    }
    fs.writeFileSync(tmp, lines.join("\n") + "\n");
    fs.renameSync(tmp, file); // atomic on POSIX — prevents corrupt writes on crash
  } catch (err) {
    // Clean up temp file if rename failed
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    emitError(Err.persistFailed(err.message, err));
    console.error(`[dbx] Persistence failed: ${err.message}`);
  }
}

function _appendEntity(entity) {
  if (_skipIO) return;
  const file = _dataFile();
  if (!file || file === ":memory:") return;
  fs.appendFileSync(file, JSON.stringify({ ...entity, links: Array.from(entity.links) }) + "\n");
}

// ─── Embedding ────────────────────────────────────────────────────────────────

// Embeddings are supplied by the caller through embedFn(text, type).
// Database X stays model-agnostic and normalizes the returned vector.

function _normalizeEmbedding(raw, dim) {
  const arr = Array.isArray(raw?.[0]) ? raw[0] : raw;
  if (!Array.isArray(arr)) throw new Error("Embedding is not an array");
  const size = Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : arr.length;
  const out = new Array(size);
  for (let i = 0; i < size; i++) out[i] = Number.isFinite(arr[i]) ? arr[i] : 0;
  return out;
}

function _emptyEmbedding() {
  const size = Number.isFinite(CFG.embeddingDim) && CFG.embeddingDim > 0 ? Math.floor(CFG.embeddingDim) : 0;
  return new Array(size).fill(0);
}

// Embed text with awareness of the entity type. The embedFn injectable receives
// (text, type) so callers can dispatch to different models per type.
async function _embed(text, strict, type = "text") {
  const input     = String(text || "").slice(0, 2000);
  const useStrict = strict !== undefined ? strict : CFG.strictEmbeddings;

  // Custom embedder (injected via init — used for testing or alternative backends)
  if (typeof CFG.embedFn === "function") {
    try {
      const vec = await CFG.embedFn(input, type);
      return _normalizeEmbedding(vec, CFG.embeddingDim);
    } catch (err) {
      if (useStrict) throw emitError(Err.embeddingFailed(err.message));
      emitError(Err.embeddingFailed(err.message));
      return _emptyEmbedding();
    }
  }

  const msg = "No embedder configured. Pass embedFn to init({ embedFn: async (text, type) => number[] }).";
  if (useStrict) throw emitError(Err.embeddingFailed(msg));
  emitError(Err.embeddingFailed(msg));
  return _emptyEmbedding();
}

// ─── LLM Metadata Enrichment ─────────────────────────────────────────────────

// Calls the caller-supplied llmFn to extract keywords, context summary,
// semantic tags, importance score, and suggested entity type from raw text.
// Returns null when llmFn is not configured or the call fails (never blocks ingest).
//
// Expected llmFn signature: async (text, type) => {
//   keywords:      string[],     — terms that improve retrieval
//   context:       string,       — short contextual summary
//   llmTags:       string[],     — semantic labels (e.g. "decision", "preference")
//   importance?:   number (0-1), — how critical this memory is (default 0.5)
//   suggestedType?: string       — more specific entity type hint
// }
async function _enrichWithLLM(text, type) {
  if (typeof CFG.llmFn !== "function") return null;
  try {
    const raw = await CFG.llmFn(text, type);
    if (!raw || typeof raw !== "object") return null;
    return {
      keywords:      Array.isArray(raw.keywords) ? raw.keywords.map(String).slice(0, 30) : [],
      context:       typeof raw.context === "string" ? raw.context.slice(0, 500) : "",
      llmTags:       Array.isArray(raw.llmTags) ? raw.llmTags.map(String).slice(0, 20) : [],
      importance:    Number.isFinite(raw.importance) ? Math.max(0, Math.min(1, raw.importance)) : 0.5,
      suggestedType: typeof raw.suggestedType === "string" ? raw.suggestedType.slice(0, 50) : null,
    };
  } catch (err) {
    console.warn(`[dbx] LLM enrichment failed (non-blocking): ${err.message}`);
    return null;
  }
}

// ─── Fact Extraction ─────────────────────────────────────────────────────────

// Calls the caller-supplied factExtractFn to break raw text into discrete facts.
// Returns an array of fact strings, or empty array on failure.
// Expected signature: async (text, type) => string[]
async function _extractFacts(text, type) {
  if (typeof CFG.factExtractFn !== "function") return [];
  try {
    const raw = await CFG.factExtractFn(text, type);
    if (!Array.isArray(raw)) return [];
    return raw.map(String).filter(s => s.trim().length > 0).slice(0, 50);
  } catch (err) {
    console.warn(`[dbx] Fact extraction failed (non-blocking): ${err.message}`);
    return [];
  }
}

// ─── Graph Linking ────────────────────────────────────────────────────────────

function _relinkEntity(entity) {
  // Remove stale back-links from other entities before clearing own links
  for (const linkedId of entity.links) {
    store.get(linkedId)?.links.delete(entity.id);
  }
  entity.links.clear();

  for (const [otherId, other] of store) {
    if (otherId === entity.id) continue;
    if (cosine(entity.vector, other.vector) >= CFG.linkThreshold) {
      entity.links.add(otherId);
      other.links.add(entity.id);
    }
  }
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

/**
 * Ingest text. Auto-detects whether this is an update to an existing entity
 * or a brand-new entity based on semantic similarity.
 *
 * Provenance: every entity and every version records a `source` field describing
 * where the content came from — user input, an agent, a tool, a file, or the
 * system itself. Defaults to { type: "user" }. This is the foundation for audit
 * logs, deletion workflows, and trust signals.
 *
 * @param {string} text
 * @param {{ type?, timestamp?, metadata?, tags?, source?, classification? }} opts
 * @returns {number} stable entity ID (never changes across updates)
 */
async function ingest(text, { type = "text", timestamp, metadata = {}, tags = [], source, classification, retention, memoryType, workspaceId, useLLM = false, allowedWorkspaces } = {}) {
  _assertInit();

  const ts       = timestamp || Date.now();
  const safeText = String(text || "").slice(0, 5000);
  const vector   = await _embed(safeText, false, type);
  const src      = _normalizeSource(source);
  const cls      = _normalizeClassification(classification);
  const ret      = _normalizeRetention(retention);
  const mt       = _normalizeMemoryType(memoryType);
  const ws       = _normalizeWorkspaceId(workspaceId);

  // Workspace write check: caller must be allowed to write to the target workspace
  if (allowedWorkspaces && !allowedWorkspaces.includes(ws)) {
    throw emitError(Err.forbidden(`No write access to workspace "${ws}".`));
  }

  // ── Optional LLM enrichment (off by default for speed/privacy) ────────────
  let llmEnrichment = null;
  if (useLLM) {
    llmEnrichment = await _enrichWithLLM(safeText, type);
    if (llmEnrichment) {
      // Merge LLM-derived tags into the entity's tags
      tags = Array.from(new Set([...(Array.isArray(tags) ? tags : []), ...llmEnrichment.llmTags]));
    }
  }

  // ── Find closest existing entity of the same type ─────────────────────────
  // Two tiers: versionThreshold for direct updates, consolidationThreshold for
  // near-duplicate detection so the same fact expressed differently merges
  // instead of creating a separate entity.
  let bestMatch = null, bestSim = 0;
  let consolidateMatch = null, consolidateSim = 0;
  for (const entity of store.values()) {
    if (!_isAlive(entity)) continue;
    if (entity.type !== type) continue;
    const sim = cosine(vector, entity.vector);
    if (sim >= CFG.versionThreshold && sim > bestSim) {
      bestSim   = sim;
      bestMatch = entity;
    } else if (sim >= CFG.consolidationThreshold && sim > consolidateSim) {
      consolidateSim   = sim;
      consolidateMatch = entity;
    }
  }

  // Consolidation: if no direct version match but a near-duplicate exists,
  // treat it as a version update (same fact, different expression).
  const mergeTarget = bestMatch || consolidateMatch;
  const isConsolidation = !bestMatch && !!consolidateMatch;

  // ── Update / Consolidation path: merge into existing entity ───────────────
  if (mergeTarget) {
    const delta = buildDelta(mergeTarget.text, mergeTarget.vector, safeText, vector);
    if (isConsolidation) delta.type = "consolidation";

    // Snapshot current linkIds before relink so the version captures the graph at this point
    const linkSnapshot = Array.from(mergeTarget.links);
    mergeTarget.versions.unshift({ text: safeText, vector, timestamp: ts, delta, source: src, classification: cls, linkIds: linkSnapshot });

    if (CFG.maxVersions > 0 && mergeTarget.versions.length > CFG.maxVersions) {
      mergeTarget.versions.length = CFG.maxVersions;
    }

    mergeTarget.text      = safeText;
    mergeTarget.vector    = vector;
    mergeTarget.updatedAt = ts;
    mergeTarget.source    = src;
    mergeTarget.classification = cls;
    mergeTarget.retention = retention ? ret : mergeTarget.retention || _normalizeRetention();
    mergeTarget.memoryType  = memoryType ? mt : mergeTarget.memoryType || _normalizeMemoryType();
    mergeTarget.workspaceId = workspaceId ? ws : mergeTarget.workspaceId || _normalizeWorkspaceId();
    mergeTarget.metadata  = { ...mergeTarget.metadata, ...metadata };
    if (llmEnrichment) mergeTarget.metadata.llm = llmEnrichment;
    mergeTarget.tags      = Array.from(new Set([...(mergeTarget.tags || []), ...tags]));
    if (llmEnrichment) mergeTarget.llmKeywords = llmEnrichment.keywords;

    _relinkEntity(mergeTarget);
    _persistAll();
    const flag = delta.contradicts ? " ⚠ CONTRADICTS prior version" : "";
    const verb = isConsolidation ? "Consolidated into" : "Updated";
    console.log(`[dbx] ${verb} entity ${mergeTarget.id} → v${mergeTarget.versions.length} [${delta.type}]${flag} ${delta.summary}`);
    return mergeTarget.id;
  }

  // ── Create path: brand new entity ─────────────────────────────────────────
  const id     = _newId();
  const enrichedMeta = llmEnrichment ? { ...metadata, llm: llmEnrichment } : metadata;
  const entity = {
    id, type,
    text:      safeText,
    vector,
    source:    src,
    classification: cls,
    retention: ret,
    memoryType:  mt,
    workspaceId: ws,
    deletedAt: null,
    deletedBy: null,
    metadata:  enrichedMeta,
    tags:      Array.isArray(tags) ? [...tags] : [],
    llmKeywords: llmEnrichment ? llmEnrichment.keywords : [],
    links:     new Set(),
    createdAt: ts,
    updatedAt: ts,
    versions:  [{ text: safeText, vector, timestamp: ts, delta: null, source: src, classification: cls, linkIds: [] }],
  };

  store.set(id, entity);
  _relinkEntity(entity);
  _appendEntity(entity);
  console.log(`[dbx] Created entity ${id} [${type}]`);
  return id;
}

/**
 * Agent-facing helper for durable memory writes.
 * Defaults to agent provenance and internal classification.
 *
 * @param {string} text
 * @param {{ type?, timestamp?, metadata?, tags?, source?, classification? }} opts
 * @returns {number} stable entity ID (never changes across updates)
 */
async function remember(text, opts = {}) {
  const source = opts.source || { type: "agent" };
  return ingest(text, {
    ...opts,
    source,
    classification: opts.classification || "internal",
    allowedWorkspaces: opts.allowedWorkspaces,
  });
}

// ─── Batch Ingest ─────────────────────────────────────────────────────────────

/**
 * Ingest multiple items atomically — persists once at the end instead of after each item.
 * @param {Array<{ text: string, type?, metadata?, tags?, timestamp?, source?, classification? }>} items
 * @returns {number[]} array of entity IDs in the same order as input
 */
async function ingestBatch(items, { allowedWorkspaces } = {}) {
  _assertInit();
  if (!Array.isArray(items) || items.length === 0) {
    throw emitError(Err.validation("items must be a non-empty array"));
  }

  _skipIO = true;
  const ids = [];
  try {
    for (const item of items) {
      const { text, type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM } = item || {};
      ids.push(await ingest(text, { type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM, allowedWorkspaces }));
    }
  } finally {
    _skipIO = false;
  }
  _persistAll(); // single write for the entire batch
  return ids;
}

// ─── Fact Extraction + Ingest ────────────────────────────────────────────────

/**
 * Extract discrete facts from raw text and ingest each as a separate entity.
 * Requires factExtractFn to be configured via init().
 *
 * @param {string} text — raw text (meeting notes, paragraphs, etc.)
 * @param {{ type?, timestamp?, metadata?, tags?, source?, classification?, retention?, memoryType?, workspaceId?, useLLM? }} opts
 * @returns {{ facts: string[], ids: number[] }}
 */
async function extractFacts(text, opts = {}) {
  _assertInit();
  if (typeof CFG.factExtractFn !== "function") {
    throw emitError(Err.validation("factExtractFn not configured. Pass factExtractFn to init({ factExtractFn: async (text, type) => string[] })."));
  }

  const safeText = String(text || "").slice(0, 10000);
  const facts = await _extractFacts(safeText, opts.type || "text");
  if (!facts.length) return { facts: [], ids: [] };

  // Ingest each fact as its own entity, batched for single persist
  _skipIO = true;
  const ids = [];
  try {
    for (const fact of facts) {
      ids.push(await ingest(fact, {
        ...opts,
        metadata: { ...(opts.metadata || {}), extractedFrom: safeText.slice(0, 200) },
        allowedWorkspaces: opts.allowedWorkspaces,
      }));
    }
  } finally {
    _skipIO = false;
  }
  _persistAll();

  console.log(`[dbx] Extracted ${facts.length} facts from raw text`);
  return { facts, ids };
}

// ─── Time Series Ingest ───────────────────────────────────────────────────────

/**
 * Ingest a time series as a single versioned entity.
 * @param {string} label
 * @param {Array<{ timestamp: number, value: number }>} points
 * @param {{ metadata?, tags? }} opts
 * @returns {number} entity ID
 */
async function ingestTimeSeries(label, points, { metadata = {}, tags = [] } = {}) {
  _assertInit();
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("points must be a non-empty array of { timestamp, value }");
  }
  const values = points.map(p => Number(p.value));
  const min    = Math.min(...values);
  const max    = Math.max(...values);
  const avg    = values.reduce((a, b) => a + b, 0) / values.length;

  const text = `Time series: ${label}. Points: ${points.length}. Range: ${min} to ${max}. Avg: ${avg.toFixed(2)}. ` +
    `From ${new Date(points[0].timestamp).toISOString()} to ${new Date(points[points.length - 1].timestamp).toISOString()}.`;

  return ingest(text, {
    type: "timeseries",
    metadata: { ...metadata, label, pointCount: points.length, min, max, avg, points },
    tags,
  });
}

// ─── File Ingest ──────────────────────────────────────────────────────────────

// Maps file extensions to canonical types from CLAUDE.md:
// "text" | "image" | "audio" | "video" | "timeseries" | "json"
const EXT_MAP = {
  ".txt": "text", ".md": "text", ".markdown": "text", ".log": "text", ".rst": "text",
  ".csv": "text", ".tsv": "text",
  ".json": "json", ".jsonl": "json",
  ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image", ".bmp": "image",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio", ".flac": "audio",
  ".mp4": "video", ".mov": "video", ".avi": "video", ".mkv": "video", ".webm": "video",
};

/**
 * Ingest a file from disk. Text files are read and indexed by content;
 * binary files (images, audio, video) are indexed by metadata.
 * @param {string} filePath
 * @param {{ tags?, metadata? }} opts
 * @returns {number} entity ID
 */
async function ingestFile(filePath, { tags = [], metadata: extra = {} } = {}) {
  _assertInit();
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const ext      = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);
  const stats    = fs.statSync(filePath);
  const type     = EXT_MAP[ext] || "file";
  let text, metadata = { filename, size: stats.size, ext };

  if ([".txt", ".md", ".markdown", ".log", ".rst"].includes(ext)) {
    const content = fs.readFileSync(filePath, "utf8");
    text = content.slice(0, 5000);
    metadata.wordCount = content.split(/\s+/).filter(Boolean).length;
    metadata.lineCount = content.split("\n").length;
  } else if ([".csv", ".tsv"].includes(ext)) {
    const raw     = fs.readFileSync(filePath, "utf8");
    const delim   = ext === ".tsv" ? "\t" : ",";
    const rows    = raw.trim().split("\n").map(r => r.split(delim));
    const headers = rows[0] || [];
    text = `CSV: ${filename}. Columns: ${headers.join(", ")}. Rows: ${rows.length - 1}.`;
    metadata.rowCount = rows.length - 1;
    metadata.columns  = headers;
  } else if ([".json", ".jsonl"].includes(ext)) {
    const raw = fs.readFileSync(filePath, "utf8");
    text = raw.slice(0, 5000);
  } else {
    const kb = (stats.size / 1024).toFixed(1);
    text = `${type.charAt(0).toUpperCase() + type.slice(1)}: ${filename}. Size: ${kb}KB.`;
    metadata.filePath = filePath;
  }

  return ingest(text, {
    type,
    metadata: { ...metadata, ...extra },
    tags,
    source: { type: "file", uri: filePath },
  });
}

// ─── NL Filter Extraction ─────────────────────────────────────────────────────

const _TIME_RULES = [
  { re: /\blast\s+hour\b/i,            ms: () => 3_600_000 },
  { re: /\blast\s+(\d+)\s+hours?\b/i,  ms: m => +m[1] * 3_600_000 },
  { re: /\btoday\b/i,                  ms: () => 86_400_000 },
  { re: /\byesterday\b/i,              ms: () => 2 * 86_400_000 },
  { re: /\bthis\s+week\b/i,            ms: () => 7 * 86_400_000 },
  { re: /\blast\s+(\d+)\s+days?\b/i,   ms: m => +m[1] * 86_400_000 },
  { re: /\blast\s+week\b/i,            ms: () => 7 * 86_400_000 },
  { re: /\bthis\s+month\b/i,           ms: () => 30 * 86_400_000 },
  { re: /\blast\s+month\b/i,           ms: () => 30 * 86_400_000 },
  { re: /\blast\s+(\d+)\s+weeks?\b/i,  ms: m => +m[1] * 7 * 86_400_000 },
  { re: /\blast\s+(\d+)\s+months?\b/i, ms: m => +m[1] * 30 * 86_400_000 },
  { re: /\brecent(ly)?\b/i,            ms: () => 7 * 86_400_000 },
];

const _TYPE_RULES = [
  { re: /\bimages?\b|\bphotos?\b/i,       type: "image" },
  { re: /\baudios?\b|\brecordings?\b/i,   type: "audio" },
  { re: /\bvideos?\b|\bclips?\b/i,        type: "video" },
  { re: /\btime.?series\b|\bmetrics?\b/i, type: "timeseries" },
  { re: /\bdocuments?\b|\bnotes?\b/i,     type: "document" },
];

function _parseNLFilters(text) {
  const filter = {}, now = Date.now();
  for (const r of _TIME_RULES) {
    const m = text.match(r.re);
    if (m) { filter.since = now - r.ms(m); break; }
  }
  for (const r of _TYPE_RULES) {
    if (r.re.test(text)) { filter.type = r.type; break; }
  }
  return filter;
}

// ─── Filter ───────────────────────────────────────────────────────────────────

function _applyFilter(entities, { type, since, until, tags, memoryType, workspaceId } = {}) {
  return entities.filter(e => {
    if (type        && e.type      !== type)        return false;
    if (since       && e.updatedAt <  since)        return false;
    if (until       && e.updatedAt >  until)        return false;
    if (memoryType  && (e.memoryType || "long-term") !== memoryType) return false;
    if (workspaceId && (e.workspaceId || "default")  !== workspaceId) return false;
    if (tags  && tags.length) {
      if (!tags.some(t => (e.tags || []).includes(t))) return false;
    }
    return true;
  });
}

// ─── Parallel Hybrid Query ────────────────────────────────────────────────────

async function _runWorkers(queryVector, queryTerms, subset, { now = Date.now(), useRecency = true } = {}) {
  if (subset.length === 0) return [];

  const numWorkers = os.cpus().length;
  const chunkSize  = Math.ceil(subset.length / numWorkers);
  const jobConfig  = {
    graphBoostWeight:   CFG.graphBoostWeight,
    keywordBoostWeight: CFG.keywordBoostWeight,
    llmBoostWeight:     CFG.llmBoostWeight,
    recencyWeight:      CFG.recencyWeight,
    recencyHalfLifeMs:  CFG.recencyHalfLifeMs,
    minFinalScore:      CFG.minFinalScore,
    minSemanticScore:   CFG.minSemanticScore,
    now,
    useRecency,
  };

  const promises = [];
  for (let i = 0; i < numWorkers; i++) {
    const slice = subset.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!slice.length) continue;

    const chunk = slice.map(e => ({
      id:          e.id,
      text:        e.text,
      type:        e.type || "text",
      vector:      e.vector,
      updatedAt:   e.updatedAt,
      links:       { size: e.links?.size || 0 },
      llmKeywords: e.llmKeywords || [],
    }));

    promises.push(_pool.run({ chunk, queryVector, queryTerms, config: jobConfig }));
  }

  const arrays = await Promise.all(promises);
  return arrays.flat().filter(Boolean);
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Query the database for semantically similar entities.
 * Supports natural-language time and type filters embedded in the query text.
 *
 * When `asOf` is supplied, each entity is scored against the version that was
 * current at that timestamp (time-travel query). Entities that did not yet
 * exist at asOf are skipped. Recency boost is disabled in asOf mode since
 * "now" has no meaning for a historical snapshot.
 *
 * When `maxTokens` is supplied, results are packed greedily by score until the
 * token budget is exhausted — purpose-built for feeding results into agent
 * context windows. The `limit` parameter still caps the absolute number of
 * results but `maxTokens` may return fewer if the budget runs out first.
 * Token estimation uses ~4 characters per token (no external tokenizer needed).
 *
 * @param {string} text
 * @param {{ limit?, maxTokens?, filter?: { type?, since?, until?, tags?, memoryType?, workspaceId? }, asOf?: number }} opts
 * @returns {{ count, results, filter, asOf, config, tokenUsage? }}
 */
async function query(text, { limit = 10, maxTokens = null, filter = {}, asOf = null, allowedWorkspaces } = {}) {
  _assertInit();

  const safeLimit   = Math.max(1, Math.min(100, Number(limit) || 10));
  const merged      = { ..._parseNLFilters(text), ...filter }; // explicit filter wins
  const queryVector = await _embed(text, true);
  const queryTerms  = String(text).toLowerCase().match(/[a-z]{3,}/g) || [];

  let subset = _getAllAlive();

  // Workspace isolation: only return entities from allowed workspaces
  if (allowedWorkspaces) {
    subset = subset.filter(e => _wsAllowed(e, allowedWorkspaces));
  }

  // Time-travel mode: remap each entity to the version that was current at asOf.
  // Versions are stored newest-first, so the first one with timestamp <= asOf wins.
  if (asOf !== null && Number.isFinite(asOf)) {
    subset = subset.map(e => {
      const v = e.versions.find(v => v.timestamp <= asOf);
      if (!v) return null; // entity did not exist yet
      // Use per-version linkIds snapshot for true historical graph state
      const historicalLinks = new Set(v.linkIds || []);
      return {
        id:        e.id,
        type:      e.type,
        text:      v.text,
        vector:    v.vector,
        updatedAt: v.timestamp,
        tags:      e.tags || [],
        links:     historicalLinks.size > 0 ? historicalLinks : e.links,
        memoryType:  e.memoryType || "long-term",
        workspaceId: e.workspaceId || "default",
        source:    v.source || e.source || { type: "user" },
        classification: v.classification || e.classification || "internal",
        delta:     v.delta || null,
      };
    }).filter(Boolean);
  }

  const subsetById = new Map(subset.map(e => [e.id, e]));

  if (Object.keys(merged).length) subset = _applyFilter(subset, merged);

  console.time("[dbx] query");
  const raw = await _runWorkers(queryVector, queryTerms, subset, {
    now:        asOf !== null ? asOf : Date.now(),
    useRecency: asOf === null,
  });
  console.timeEnd("[dbx] query");

  const sorted = raw
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit)
    .map(r => {
      const entity = subsetById.get(r.id);
      return {
        ...r,
        source:         entity?.source || { type: "user" },
        classification: entity?.classification || "internal",
        retention:      entity?.retention || { policy: "keep", expiresAt: null },
        memoryType:     entity?.memoryType || "long-term",
        workspaceId:    entity?.workspaceId || "default",
        delta:          entity?.delta || null,
      };
    });

  // Token-budgeted packing: greedily include highest-scored results until
  // the budget is exhausted. ~4 chars ≈ 1 token (GPT/Claude heuristic).
  let results, tokenUsage;
  const safeMaxTokens = maxTokens != null ? Math.max(1, Math.floor(Number(maxTokens) || 0)) : null;

  if (safeMaxTokens !== null) {
    results = [];
    let tokensUsed = 0;
    for (const r of sorted) {
      const textTokens = Math.ceil((r.text || "").length / 4);
      // Metadata overhead: id, type, score line ≈ 20 tokens per result
      const itemTokens = textTokens + 20;
      if (results.length > 0 && tokensUsed + itemTokens > safeMaxTokens) break;
      tokensUsed += itemTokens;
      results.push(r);
    }
    tokenUsage = { budget: safeMaxTokens, used: tokensUsed, resultsDropped: sorted.length - results.length };
  } else {
    results = sorted;
  }

  const response = {
    count:   results.length,
    results,
    filter:  merged,
    asOf,
    config:  {
      minScore:      CFG.minFinalScore,
      minSemantic:   CFG.minSemanticScore,
      linkThreshold: CFG.linkThreshold,
      recencyWeight: asOf === null ? CFG.recencyWeight : 0,
    },
  };
  if (tokenUsage) response.tokenUsage = tokenUsage;
  return response;
}

// ─── Get Entity ───────────────────────────────────────────────────────────────

/**
 * Get the current state of a single entity without version history.
 * @param {number|string} id
 */
async function get(id, { allowedWorkspaces } = {}) {
  _assertInit();
  const e = store.get(Number(id) || id);
  if (!e) throw emitError(Err.notFound(id));
  if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No access to workspace "${e.workspaceId || "default"}".`));
  return _serializeEntity(e);
}

// ─── Get Many Entities ────────────────────────────────────────────────────────

/**
 * Batch-fetch multiple entities by ID in one call.
 * Missing IDs return null in the same position — the array order matches the input.
 * Designed for the Postgres join pattern: store dbxId in Postgres, resolve here.
 * @param {Array<number|string>} ids
 * @returns {Array<object|null>}
 */
async function getMany(ids, { allowedWorkspaces } = {}) {
  _assertInit();
  if (!Array.isArray(ids)) throw emitError(Err.validation("ids must be an array"));
  return ids.map(id => {
    const e = store.get(Number(id) || id);
    if (!e) return null;
    if (!_wsAllowed(e, allowedWorkspaces)) return null; // silently hide inaccessible entities
    return _serializeEntity(e);
  });
}

// ─── Remove Entity (Soft Delete) ──────────────────────────────────────────────

/**
 * Soft-delete an entity. Sets deletedAt/deletedBy and removes graph links,
 * but keeps the entity in the store for auditability and GDPR compliance.
 * Use purge() for permanent hard deletion.
 * @param {number|string} id
 * @param {{ deletedBy?: string|object }} opts
 */
async function remove(id, { deletedBy, allowedWorkspaces } = {}) {
  _assertInit();
  const numId = Number(id) || id;
  const e = store.get(numId);
  if (!e) throw emitError(Err.notFound(id));
  if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No admin access to workspace "${e.workspaceId || "default"}".`));
  if (e.deletedAt) throw emitError(Err.alreadyDeleted(id));

  _unlinkEntity(e, numId);
  e.deletedAt = Date.now();
  e.deletedBy = deletedBy ? _normalizeSource(deletedBy) : null;

  _persistAll();
  console.log(`[dbx] Soft-deleted entity ${numId}`);
}

// ─── Purge Entity (Hard Delete) ──────────────────────────────────────────────

/**
 * Permanently and irrecoverably delete an entity from the store.
 * This is a destructive operation intended for GDPR right-to-erasure
 * or retention policy enforcement.
 * @param {number|string} id
 */
async function purge(id, { allowedWorkspaces } = {}) {
  _assertInit();
  const numId = Number(id) || id;
  const e = store.get(numId);
  if (!e) throw emitError(Err.notFound(id));
  if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No admin access to workspace "${e.workspaceId || "default"}".`));

  _unlinkEntity(e, numId);
  store.delete(numId);
  _persistAll();
  console.log(`[dbx] Purged entity ${numId} (permanent)`);
}

// ─── Memory Consolidation ────────────────────────────────────────────────────

/**
 * Scan all entities for near-duplicates and merge them.
 * For each cluster of similar entities, the most recently updated one is kept
 * and the others are soft-deleted after their metadata/tags are merged in.
 *
 * @param {{ threshold?, dryRun?, type? }} opts
 *   threshold — similarity floor for considering two entities duplicates (default: consolidationThreshold)
 *   dryRun    — if true, returns the report without actually merging (default: false)
 *   type      — only consolidate entities of this type (optional)
 * @returns {{ merged: Array<{ kept, absorbed, similarity }>, totalMerged: number }}
 */
async function consolidate({ threshold, dryRun = false, type, allowedWorkspaces } = {}) {
  _assertInit();
  const thresh = Number.isFinite(threshold) ? threshold : CFG.consolidationThreshold;
  let alive  = _getAllAlive().filter(e => !type || e.type === type);
  if (allowedWorkspaces) alive = alive.filter(e => _wsAllowed(e, allowedWorkspaces));

  // Build clusters: union-find by similarity
  const parent = new Map();
  function find(id) {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of alive) parent.set(e.id, e.id);

  const pairs = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      if (alive[i].type !== alive[j].type) continue;
      const sim = cosine(alive[i].vector, alive[j].vector);
      if (sim >= thresh) {
        union(alive[i].id, alive[j].id);
        pairs.push({ a: alive[i], b: alive[j], sim });
      }
    }
  }

  // Group by cluster root
  const clusters = new Map();
  for (const e of alive) {
    const root = find(e.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(e);
  }

  const merged = [];
  for (const [, members] of clusters) {
    if (members.length < 2) continue;
    // Keep the most recently updated entity
    members.sort((a, b) => b.updatedAt - a.updatedAt);
    const keeper = members[0];
    const absorbed = members.slice(1);

    for (const dup of absorbed) {
      const sim = cosine(keeper.vector, dup.vector);
      merged.push({
        kept:     { id: keeper.id, text: keeper.text.slice(0, 80) },
        absorbed: { id: dup.id,    text: dup.text.slice(0, 80) },
        similarity: +sim.toFixed(4),
      });

      if (!dryRun) {
        // Merge tags and metadata from duplicate into keeper
        keeper.tags = Array.from(new Set([...(keeper.tags || []), ...(dup.tags || [])]));
        keeper.metadata = { ...dup.metadata, ...keeper.metadata };

        // Soft-delete the duplicate
        _unlinkEntity(dup, dup.id);
        dup.deletedAt = Date.now();
        dup.deletedBy = { type: "system", actor: "consolidate" };
      }
    }
  }

  if (!dryRun && merged.length) _persistAll();

  const verb = dryRun ? "Would merge" : "Merged";
  console.log(`[dbx] ${verb} ${merged.length} duplicate(s) across ${clusters.size} cluster(s)`);
  return { merged, totalMerged: merged.length };
}

// ─── Graph ────────────────────────────────────────────────────────────────────

/**
 * Get the full graph of all entities and their semantic links.
 * @returns {{ nodes, edges }}
 */
async function getGraph({ allowedWorkspaces } = {}) {
  _assertInit();
  const nodes = [], edgeSet = new Set();
  for (const e of store.values()) {
    if (!_isAlive(e)) continue;
    if (!_wsAllowed(e, allowedWorkspaces)) continue;
    nodes.push({
      id: e.id, type: e.type || "text",
      label: e.text.slice(0, 40) + (e.text.length > 40 ? "…" : ""),
      linkCount:    e.links?.size || 0,
      versionCount: e.versions?.length || 1,
      tags:         e.tags || [],
      createdAt:    e.createdAt,
    });
    for (const lid of (e.links || [])) {
      edgeSet.add([e.id, lid].sort((a, b) => a - b).join(":"));
    }
  }
  return {
    nodes,
    edges: Array.from(edgeSet).map(k => {
      const [s, t] = k.split(":").map(Number);
      return { source: s, target: t };
    }),
  };
}

// ─── Graph Traversal ──────────────────────────────────────────────────────────

/**
 * BFS traversal from an entity up to a given link depth.
 * @param {number|string} id
 * @param {number} depth — max hops (default 1)
 * @returns {{ nodes, edges }}
 */
async function traverse(id, depth = 1, { allowedWorkspaces } = {}) {
  _assertInit();
  const root = store.get(Number(id) || id);
  if (!root) throw emitError(Err.notFound(id));
  if (!_wsAllowed(root, allowedWorkspaces)) throw emitError(Err.forbidden(`No access to workspace "${root.workspaceId || "default"}".`));
  if (!_isAlive(root)) throw emitError(Err.alreadyDeleted(id));

  const visited = new Set();
  const result  = { nodes: [], edges: [] };

  function bfs(eid, d) {
    if (visited.has(eid)) return;
    visited.add(eid);
    const e = store.get(eid);
    if (!e || !_isAlive(e)) return;
    if (!_wsAllowed(e, allowedWorkspaces)) return;
    result.nodes.push({
      id: e.id, type: e.type || "text",
      label: e.text.slice(0, 60) + (e.text.length > 60 ? "…" : ""),
      depth: d, linkCount: e.links?.size || 0,
      versionCount: e.versions?.length || 1,
    });
    if (d < depth) {
      for (const lid of (e.links || [])) {
        result.edges.push({ source: e.id, target: lid });
        bfs(lid, d + 1);
      }
    }
  }

  bfs(Number(id) || id, 0);
  return result;
}

// ─── List Entities ────────────────────────────────────────────────────────────

/**
 * List entities with optional filtering and pagination.
 * @param {{ page?, limit?, type?, since?, until?, tags? }} opts
 * @returns {{ total, page, pages, entities }}
 */
async function listEntities({ page = 1, limit = 20, type, since, until, tags, memoryType, workspaceId, allowedWorkspaces } = {}) {
  _assertInit();
  const pg  = Math.max(1, Number(page)  || 1);
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const filter = {};
  if (type)        filter.type        = type;
  if (since)       filter.since       = Number(since);
  if (until)       filter.until       = Number(until);
  if (tags)        filter.tags        = Array.isArray(tags) ? tags : [tags];
  if (memoryType)  filter.memoryType  = memoryType;
  if (workspaceId) filter.workspaceId = workspaceId;

  let all = _getAllAlive();
  // Workspace isolation
  if (allowedWorkspaces) all = all.filter(e => _wsAllowed(e, allowedWorkspaces));
  if (Object.keys(filter).length) all = _applyFilter(all, filter);
  all.sort((a, b) => b.updatedAt - a.updatedAt);

  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / lim));
  const slice = all.slice((pg - 1) * lim, pg * lim);

  return {
    total, page: pg, pages,
    entities: slice.map(e => _serializeEntity(e, { truncateText: 120 })),
  };
}

// ─── History ──────────────────────────────────────────────────────────────────

/**
 * Get full version history for an entity.
 * @param {number|string} id
 * @returns {{ id, type, current, metadata, tags, createdAt, updatedAt, versionCount, versions }}
 */
async function getHistory(id, { allowedWorkspaces } = {}) {
  _assertInit();
  const e = store.get(Number(id) || id);
  if (!e) throw emitError(Err.notFound(id));
  if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No access to workspace "${e.workspaceId || "default"}".`));

  // Stored newest-first internally; display oldest-first for readability
  const versionsOldestFirst = [...e.versions].reverse();

  return {
    ..._serializeEntity(e),
    current: e.text,
    versionCount: e.versions.length,
    versions: versionsOldestFirst.map((v, i) => ({
      version:        i + 1,
      text:           v.text,
      timestamp:      v.timestamp,
      delta:          v.delta || null,
      source:         v.source || e.source || { type: "user" },
      classification: v.classification || e.classification || "internal",
      linkIds:        v.linkIds || [],
    })),
  };
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Get aggregate database statistics.
 * @returns {{ entities, totalVersions, totalLinks, byType, runningSince }}
 */
async function getStatus({ allowedWorkspaces } = {}) {
  _assertInit();
  const all      = Array.from(store.values()).filter(e => _wsAllowed(e, allowedWorkspaces));
  const alive    = all.filter(_isAlive);
  const deleted  = all.length - alive.length;
  const byType   = {};
  const byMemoryType  = {};
  const byWorkspace   = {};
  let   totalLinks = 0;
  for (const e of alive) {
    byType[e.type || "text"] = (byType[e.type || "text"] || 0) + 1;
    const mt = e.memoryType || "long-term";
    byMemoryType[mt] = (byMemoryType[mt] || 0) + 1;
    const ws = e.workspaceId || "default";
    byWorkspace[ws] = (byWorkspace[ws] || 0) + 1;
    totalLinks += e.links?.size || 0;
  }
  return {
    entities:      alive.length,
    deletedEntities: deleted,
    totalVersions: alive.reduce((s, e) => s + (e.versions?.length || 1), 0),
    totalLinks:    Math.floor(totalLinks / 2),
    byType,
    byMemoryType,
    byWorkspace,
    runningSince:  new Date().toISOString(),
  };
}

// ─── Markdown Adapter ────────────────────────────────────────────────────────
// Bridges the gap between agents that think in .md and DBX's NDJSON persistence.
// exportMarkdown() produces human-readable markdown from entities;
// importMarkdown() parses it back and ingests each section.

/**
 * Export entities as human-readable markdown.
 * Agents can read/write this format instead of touching .dbx directly.
 *
 * @param {{ filter?, includeHistory? }} opts
 * @returns {string} markdown string
 */
async function exportMarkdown({ filter, includeHistory = false, allowedWorkspaces } = {}) {
  _assertInit();
  let entities = _getAllAlive();
  if (allowedWorkspaces) entities = entities.filter(e => _wsAllowed(e, allowedWorkspaces));
  if (filter && Object.keys(filter).length) entities = _applyFilter(entities, filter);
  entities.sort((a, b) => b.updatedAt - a.updatedAt);

  const lines = ["# Database X — Memory Export", ""];
  lines.push(`> Exported ${entities.length} entities at ${new Date().toISOString()}`, "");

  for (const e of entities) {
    lines.push(`## [${e.id}] ${(e.type || "text").toUpperCase()}`);
    lines.push("");
    lines.push(e.text);
    lines.push("");
    lines.push(`- **ID:** ${e.id}`);
    lines.push(`- **Type:** ${e.type || "text"}`);
    lines.push(`- **Memory type:** ${e.memoryType || "long-term"}`);
    lines.push(`- **Workspace:** ${e.workspaceId || "default"}`);
    lines.push(`- **Classification:** ${e.classification || "internal"}`);
    lines.push(`- **Tags:** ${(e.tags || []).join(", ") || "none"}`);
    lines.push(`- **Source:** ${e.source?.type || "user"}${e.source?.actor ? " (" + e.source.actor + ")" : ""}`);
    lines.push(`- **Created:** ${new Date(e.createdAt).toISOString()}`);
    lines.push(`- **Updated:** ${new Date(e.updatedAt).toISOString()}`);
    lines.push(`- **Versions:** ${e.versions?.length || 1}`);

    if (includeHistory && e.versions?.length > 1) {
      lines.push("");
      lines.push("### Version History");
      lines.push("");
      const versionsOldest = [...e.versions].reverse();
      for (let i = 0; i < versionsOldest.length; i++) {
        const v = versionsOldest[i];
        const delta = v.delta ? ` [${v.delta.type}] ${v.delta.summary}` : " (initial)";
        lines.push(`${i + 1}. **${new Date(v.timestamp).toISOString()}**${delta}`);
        if (v.text !== e.text) lines.push(`   > ${v.text.slice(0, 120)}`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse a markdown file (in the exportMarkdown format) and ingest each section.
 * This lets agents write memories as markdown and round-trip into DBX.
 *
 * Also supports simple format: any line starting with "- " or "* " is treated
 * as a separate fact, making it easy for agents to just write bullet lists.
 *
 * @param {string} mdText — markdown string
 * @param {{ source?, classification?, memoryType?, workspaceId?, tags? }} defaults
 * @returns {{ imported: number, ids: number[] }}
 */
async function importMarkdown(mdText, defaults = {}) {
  _assertInit();
  const text = String(mdText || "");
  if (!text.trim()) return { imported: 0, ids: [] };

  const sections = [];
  const allowedWorkspaces = defaults.allowedWorkspaces;

  // Try structured format first: split on ## headers
  const headerRe = /^##\s+\[(\d+)\]\s+(.+)/;
  const lines = text.split("\n");
  let currentSection = null;

  for (const line of lines) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: headerMatch[2].trim().toLowerCase(), lines: [] };
      continue;
    }
    if (currentSection) {
      // Skip metadata lines (start with "- **")
      if (/^- \*\*/.test(line.trim()) || /^###/.test(line.trim()) || /^---$/.test(line.trim()) || /^>/.test(line.trim())) continue;
      const trimmed = line.trim();
      if (trimmed) currentSection.lines.push(trimmed);
    }
  }
  if (currentSection) sections.push(currentSection);

  // If we found structured sections, ingest each
  if (sections.length > 0) {
    _skipIO = true;
    const ids = [];
    try {
      for (const sec of sections) {
        const factText = sec.lines.join(" ").trim();
        if (!factText) continue;
        const type = sec.type === "text" ? "text" : sec.type;
        ids.push(await ingest(factText, { ...defaults, type, allowedWorkspaces }));
      }
    } finally {
      _skipIO = false;
    }
    _persistAll();
    console.log(`[dbx] Imported ${ids.length} entities from structured markdown`);
    return { imported: ids.length, ids };
  }

  // Fallback: treat bullet points or plain lines as individual facts
  const bullets = lines
    .map(l => l.replace(/^[\s]*[-*]\s+/, "").trim())
    .filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"));

  if (!bullets.length) return { imported: 0, ids: [] };

  _skipIO = true;
  const ids = [];
  try {
    for (const fact of bullets) {
      ids.push(await ingest(fact, { ...defaults, allowedWorkspaces }));
    }
  } finally {
    _skipIO = false;
  }
  _persistAll();
  console.log(`[dbx] Imported ${ids.length} entities from markdown bullets`);
  return { imported: ids.length, ids };
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Flush pending writes and terminate worker pool. Call before process exit.
 */
async function shutdown() {
  if (!_initialized) return; // safe to call even if init() was never called
  _persistAll();
  if (_pool) { await _pool.stop(); _pool = null; }
  _initialized = false;
  console.log("[dbx] Shutdown complete");
}

// ─── Agent Helper ────────────────────────────────────────────────────────────

/**
 * Create a lightweight agent memory helper with built-in provenance,
 * classification defaults, and a clean recall/update interface.
 *
 * @param {{ name: string, defaultClassification?: string, defaultTags?: string[] }} opts
 * @returns {AgentMemory}
 *
 * @example
 * const agent = dbx.createAgent({ name: "budget-planner" });
 * await agent.remember("Q2 budget is 2.4M");
 * await agent.update("Q2 budget is now 2.7M");
 * const results = await agent.recall("Q2 budget");
 * const { contradictions } = await agent.getContradictions(id);
 */
function createAgent(opts) {
  _assertInit();
  return new AgentMemory(module.exports, opts);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  ingest,
  remember,
  ingestBatch,
  extractFacts,
  ingestTimeSeries,
  ingestFile,
  query,
  get,
  getMany,
  remove,
  purge,
  consolidate,
  getGraph,
  traverse,
  listEntities,
  getHistory,
  getStatus,
  exportMarkdown,
  importMarkdown,
  shutdown,
  createAgent,
  // Auth & Workspace ACL
  auth: _auth,
  // Error → Signal → Learning Loop
  onSignal:     require("./errors").onSignal,
  getSignals:   require("./errors").getSignals,
};
