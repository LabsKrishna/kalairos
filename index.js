// index.js — Kalairos Core Engine
"use strict";

const os     = require("os");
const fs     = require("fs");
const path   = require("path");
const { cosine } = require("./kernel");
const { buildDelta, buildChangelog, measureDrift } = require("./versioning");
const { WorkerPool } = require("./worker-pool");
const { AgentMemory } = require("./agent");
const { Err, emitError, resetSignals } = require("./errors");
const { AuthStore } = require("./auth");
const { computeTrustSignals } = require("./trust");

// ─── Trust Score Defaults ─────────────────────────────────────────────────────
// Default trust scores by provenance type. Explicit annotations override these.
// The hierarchy reflects information quality: users and verified tools score
// higher than automated agents; raw files and system-generated content score lowest.
const _SOURCE_TRUST_DEFAULTS = {
  user:   0.90,  // human input — highest default trust
  agent:  0.75,  // automated agent write — moderate trust
  tool:   0.80,  // tool-assisted write — trusted but not user-confirmed
  file:   0.70,  // file ingest — content may be stale or external
  system: 0.60,  // system-generated — lowest default trust
};

function _defaultTrustScore(sourceType) {
  return _SOURCE_TRUST_DEFAULTS[sourceType] ?? 0.70;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  linkThreshold:      Number(process.env.KALAIROS_LINK_THRESHOLD    || 0.72),
  versionThreshold:   Number(process.env.KALAIROS_VERSION_THRESHOLD || 0.82),
  graphBoostWeight:   Number(process.env.KALAIROS_GRAPH_BOOST       || 0.01),
  keywordBoostWeight: 0.05,
  llmBoostWeight:     Number(process.env.KALAIROS_LLM_BOOST         || 0.08),
  importanceWeight:   Number(process.env.KALAIROS_IMPORTANCE_WEIGHT || 0.05),
  recencyWeight:      Number(process.env.KALAIROS_RECENCY_WEIGHT    || 0.10),
  recencyHalfLifeMs:  Number(process.env.KALAIROS_RECENCY_HALFLIFE_DAYS || 30) * 86_400_000,
  // Trust weighting is opt-in (default 0 = disabled). When > 0, query scores are scaled by
  // `(1 - trustWeight + trustWeight * trustScore)`. trustScore missing on an entity is treated
  // as fully trusted, preserving backward compat for records written before trust was tracked.
  trustWeight:        Number(process.env.KALAIROS_TRUST_WEIGHT       || 0),
  minFinalScore:      Number(process.env.KALAIROS_MIN_SCORE         || 0.45),
  minSemanticScore:   Number(process.env.KALAIROS_MIN_SEMANTIC      || 0.35),
  maxVersions:        Number(process.env.KALAIROS_MAX_VERSIONS      || 0), // 0 = unlimited
  strictEmbeddings:   (process.env.KALAIROS_STRICT_EMBEDDINGS       || "1") !== "0",
  dataFile:           path.join(process.cwd(), "data.kalairos"),
  // embedFn(text, type) — inject your own: `async (text, type) => number[]`.
  // llmFn(text, type) — inject your own: `async (text, type) => { keywords, context, llmTags, importance?, suggestedType? }`.
  // factExtractFn(text, type) — inject your own: `async (text, type) => string[]` (array of discrete fact strings).
  consolidationThreshold: Number(process.env.KALAIROS_CONSOLIDATION_THRESHOLD || 0.78),
  // Maximum number of mutations that may be pending in the write queue at once.
  // Excess writes are rejected with ERR_WRITE_QUEUE_FULL (HTTP 429) so callers
  // get a clear backpressure signal instead of unbounded memory growth.
  writeQueueMax: Number(process.env.KALAIROS_WRITE_QUEUE_MAX || 500),
  // Maximum characters allowed per ingested memory text. Exceeding this throws
  // ERR_TEXT_TOO_LONG rather than silently truncating — silent truncation
  // corrupts recall because the embedding is computed from clipped text.
  maxTextLen: Number(process.env.KALAIROS_MAX_TEXT_LEN || 5000),
};

// ─── Module state ─────────────────────────────────────────────────────────────

let CFG         = { ...DEFAULTS };
let store       = null;        // StoreAdapter (FileStore or PgStore)
let _pool       = null;        // persistent WorkerPool
let _initialized = false;
let _skipIO        = 0;    // ref-counted; > 0 suppresses per-item I/O during batch ops
let _pendingWrites = [];   // { fn, resolve, reject } — drain-based write queue
let _draining      = false;// true while _drainWrites() is scheduled or running
const _auth        = new AuthStore();

// Monotonically increasing ID — guarantees uniqueness even within the same ms.
let _nextId = Date.now();
function _newId() { return _nextId++; }

// ─── Write queue (drain-based coalescing mutex) ───────────────────────────────
// All store mutations run inside _withWriteLock so callers are serialised.
// The compute phase (embedding, LLM) runs outside the lock and stays parallel.
//
// Design — two properties beyond a plain serial queue:
//
//  1. Coalescing: _drainWrites() uses setImmediate so writes that arrive while
//     embeddings are in flight accumulate before the drain runs. When ≥ 2 writes
//     are pending, _skipIO is bumped for the batch and _persistAll() is called
//     once at the end instead of once per write. Under sustained load (100s–1000s
//     of concurrent ingests) this collapses N file-syncs into 1 per event-loop
//     tick, the dominant throughput bottleneck.
//
//  2. Backpressure: if _pendingWrites already holds writeQueueMax entries, new
//     writes are rejected immediately with ERR_WRITE_QUEUE_FULL (HTTP 429).
//     This bounds memory and gives callers a signal to back off rather than
//     silently queuing forever.
//
// All fn bodies must be synchronous (no await inside the lock). This keeps the
// critical section fast and avoids nested lock acquisition.

function _withWriteLock(fn) {
  const max = CFG.writeQueueMax;
  if (_pendingWrites.length >= max) {
    return Promise.reject(emitError(Err.writeQueueFull(_pendingWrites.length, max)));
  }
  return new Promise((resolve, reject) => {
    _pendingWrites.push({ fn, resolve, reject });
    if (!_draining) {
      _draining = true;
      // Defer so writes that arrive in the same tick can accumulate first.
      setImmediate(_drainWrites);
    }
  });
}

function _drainWrites() {
  // Loop: after each batch, check if new items arrived while we were settling.
  while (_pendingWrites.length > 0) {
    const batch   = _pendingWrites.splice(0); // grab everything pending right now
    const isMulti = batch.length > 1;

    // Suppress per-item I/O for multi-write batches; one flush covers them all.
    if (isMulti) _skipIO++;

    const settled = [];
    for (const item of batch) {
      try {
        settled.push({ ok: true,  resolve: item.resolve, value: item.fn() });
      } catch (err) {
        settled.push({ ok: false, reject:  item.reject,  error: err });
      }
    }

    if (isMulti) {
      _skipIO--;
      // _persistAll() honours the outer _skipIO counter: if we are nested inside
      // an ingestBatch/_extractFacts call (skipIO > 0), this is a no-op — the
      // caller's own _persistAll() will flush at the end of its loop. Otherwise
      // this is the single flush for the entire micro-batch.
      _persistAll();
    }

    // Settle all promises after the flush so callers receive confirmed IDs.
    for (const s of settled) {
      if (s.ok) s.resolve(s.value);
      else      s.reject(s.error);
    }
  }
  _draining = false;
}

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
    importance:     e.importance != null ? e.importance : null,
    trustScore:     e.trustScore != null ? e.trustScore : _defaultTrustScore(e.source?.type || "user"),
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

  CFG            = { ...DEFAULTS, ...overrides };
  _skipIO        = 0;      // reset batch-suppress counter
  _pendingWrites = [];     // drop any queued mutations from previous session
  _draining      = false;  // drain state reset

  // ── Choose backing store ───────────────────────────────────────────────────
  const storeType = (overrides.store || process.env.KALAIROS_STORE || "file").toLowerCase();
  if (storeType === "pg") {
    throw new Error(
      "[kalairos] PostgreSQL/pgvector backing store is available in Kalairos Enterprise.\n" +
      "  See https://github.com/LabsKrishna/kalairos#enterprise for more information."
    );
  }
  const { FileStore } = require("./store/file-store");
  store = new FileStore();
  await _loadStore();

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

// Normalise a raw entity object (from JSONL or DB row) into a live entity.
// Mutates `raw` in-place (same as the old _loadData loop) and returns it.
function _normalizeRaw(raw) {
  raw.links    = new Set(raw.links   || []);
  raw.versions = raw.versions || [];
  raw.type     = raw.type     || "text";
  raw.metadata = raw.metadata || {};
  raw.tags     = raw.tags     || [];

  const versionSource         = raw.versions.find(v => v?.source)?.source;
  const versionClassification = raw.versions.find(v => v?.classification)?.classification;
  raw.source         = raw.source || versionSource || { type: "user" };
  raw.classification = _normalizeClassification(raw.classification || versionClassification);
  raw.retention      = _normalizeRetention(raw.retention);

  // Preserve soft-delete fields; default to not-deleted
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    raw.deletedAt = Number(raw.deletedAt);
    raw.deletedBy = raw.deletedBy || null;
  } else {
    raw.deletedAt = null;
    raw.deletedBy = null;
  }

  // Backfill fields added in later schema versions
  raw.memoryType  = _normalizeMemoryType(raw.memoryType);
  raw.workspaceId = _normalizeWorkspaceId(raw.workspaceId);
  if (!Array.isArray(raw.llmKeywords)) raw.llmKeywords = raw.metadata?.llm?.keywords || [];
  if (raw.importance === undefined)    raw.importance  = null;
  if (raw.trustScore === undefined)    raw.trustScore  = _defaultTrustScore(raw.source?.type || "user");

  // Backfill per-version metadata
  for (const v of raw.versions) if (!v.source) v.source = raw.source;
  for (const v of raw.versions) {
    v.classification = _normalizeClassification(v.classification || raw.classification);
    if (!Array.isArray(v.linkIds)) v.linkIds = [];
  }

  // Migrate old data: if versions are oldest-first, reverse to newest-first
  if (raw.versions.length > 1 &&
      raw.versions[0].timestamp < raw.versions[raw.versions.length - 1].timestamp) {
    raw.versions.reverse();
  }

  return raw;
}

// Load raw rows from the backing store, normalise them, and populate the
// in-memory hot-cache. Works for both sync (FileStore) and async (KalairosStore).
async function _loadStore() {
  const rawItems = await store.loadRaw(CFG);
  for (const raw of rawItems) {
    try {
      const entity = _normalizeRaw(raw);
      store.set(entity.id, entity);
    } catch (err) {
      emitError(Err.loadFailed(err.message, String(raw?.id || "").slice(0, 80)));
      console.warn("[kalairos] Skipping malformed entity during load");
    }
  }
  console.log(`[kalairos] Loaded ${store.size} entities`);
}

// Serialise entity for backing store I/O (links Set → Array).
function _serializeForIO(entity) {
  return { ...entity, links: Array.from(entity.links) };
}

function _persistAll() {
  if (_skipIO > 0) return;
  const rows = Array.from(store.values()).map(_serializeForIO);
  try {
    const result = store.persistAll(rows, CFG);
    if (result && typeof result.catch === "function") {
      result.catch(err => {
        emitError(Err.persistFailed(err.message, err));
        console.error(`[kalairos] PersistAll failed: ${err.message}`);
      });
    }
  } catch (err) {
    emitError(Err.persistFailed(err.message, err));
    console.error(`[kalairos] Persistence failed: ${err.message}`);
  }
}

function _appendEntity(entity) {
  if (_skipIO > 0) return;
  const row = _serializeForIO(entity);
  try {
    const result = store.appendEntity(row, CFG);
    if (result && typeof result.catch === "function") {
      result.catch(err => {
        emitError(Err.persistFailed(err.message, err));
        console.error(`[kalairos] AppendEntity failed: ${err.message}`);
      });
    }
  } catch (err) {
    emitError(Err.persistFailed(err.message, err));
    console.error(`[kalairos] Append entity failed: ${err.message}`);
  }
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
    console.warn(`[kalairos] LLM enrichment failed (non-blocking): ${err.message}`);
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
    console.warn(`[kalairos] Fact extraction failed (non-blocking): ${err.message}`);
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
async function ingest(text, { type = "text", timestamp, metadata = {}, tags = [], source, classification, retention, memoryType, workspaceId, useLLM = false, importance, trustScore, allowedWorkspaces, forceNew = false } = {}) {
  _assertInit();

  const ts       = timestamp || Date.now();
  const rawText  = String(text || "");
  if (rawText.length > CFG.maxTextLen) {
    throw emitError(Err.textTooLong(rawText.length, CFG.maxTextLen));
  }
  const safeText = rawText;
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
  // Phase 1 ends here — everything above is pure compute with no store reads.
  // Multiple concurrent ingest() calls may reach this point in parallel, which
  // is safe: embeddings are deterministic and no shared state is touched.
  let llmEnrichment = null;
  if (useLLM) {
    llmEnrichment = await _enrichWithLLM(safeText, type);
    if (llmEnrichment) {
      // Merge LLM-derived tags into the entity's tags
      tags = Array.from(new Set([...(Array.isArray(tags) ? tags : []), ...llmEnrichment.llmTags]));
    }
  }

  // ── Phase 2: critical section (serialised via write lock) ─────────────────
  // All store reads, mutations, graph relinking, and persistence happen here.
  // The body is synchronous so the lock is held for the minimum possible time.
  return _withWriteLock(() => {
    // ── Find closest existing entity of the same type ───────────────────────
    // Two tiers: versionThreshold for direct updates, consolidationThreshold for
    // near-duplicate detection so the same fact expressed differently merges
    // instead of creating a separate entity.
    // forceNew=true bypasses this scan entirely — guarantees a new entity row.
    let bestMatch = null, bestSim = 0;
    let consolidateMatch = null, consolidateSim = 0;
    if (!forceNew) {
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
    }

    // Consolidation: if no direct version match but a near-duplicate exists,
    // treat it as a version update (same fact, different expression).
    const mergeTarget = bestMatch || consolidateMatch;
    const isConsolidation = !bestMatch && !!consolidateMatch;

    // ── Update / Consolidation path: merge into existing entity ─────────────
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
      if (Number.isFinite(importance)) mergeTarget.importance = Math.max(0, Math.min(1, importance));
      else if (llmEnrichment && Number.isFinite(llmEnrichment.importance)) mergeTarget.importance = llmEnrichment.importance;
      // Update trust score when explicitly provided; otherwise preserve existing
      if (Number.isFinite(trustScore)) mergeTarget.trustScore = Math.max(0, Math.min(1, trustScore));
      else if (!Number.isFinite(mergeTarget.trustScore)) mergeTarget.trustScore = _defaultTrustScore(src.type);

      _relinkEntity(mergeTarget);
      _persistAll();
      const flag = delta.contradicts ? " ⚠ CONTRADICTS prior version" : "";
      const verb = isConsolidation ? "Consolidated into" : "Updated";
      console.log(`[kalairos] ${verb} entity ${mergeTarget.id} → v${mergeTarget.versions.length} [${delta.type}]${flag} ${delta.summary}`);
      return mergeTarget.id;
    }

    // ── Create path: brand new entity ───────────────────────────────────────
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
      importance:  Number.isFinite(importance) ? Math.max(0, Math.min(1, importance))
                   : llmEnrichment ? (llmEnrichment.importance || 0.5) : null,
      trustScore:  Number.isFinite(trustScore) ? Math.max(0, Math.min(1, trustScore))
                   : _defaultTrustScore(src.type),
      llmKeywords: llmEnrichment ? llmEnrichment.keywords : [],
      links:     new Set(),
      createdAt: ts,
      updatedAt: ts,
      versions:  [{ text: safeText, vector, timestamp: ts, delta: null, source: src, classification: cls, linkIds: [] }],
    };

    store.set(id, entity);
    _relinkEntity(entity);
    _appendEntity(entity);
    console.log(`[kalairos] Created entity ${id} [${type}]`);
    return id;
  });
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
    importance:     opts.importance,
    trustScore:     opts.trustScore,
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

  _skipIO++;
  const ids = [];
  try {
    for (const item of items) {
      const { text, type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM, trustScore } = item || {};
      ids.push(await ingest(text, { type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM, trustScore, allowedWorkspaces }));
    }
  } finally {
    _skipIO--;
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
  _skipIO++;
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
    _skipIO--;
  }
  _persistAll();

  console.log(`[kalairos] Extracted ${facts.length} facts from raw text`);
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

// ─── Importance Heuristic ────────────────────────────────────────────────────
// When no explicit importance is set and no LLM enrichment exists, derive a
// heuristic score from structural signals so that importance scoring always
// has a meaningful signal. Frequently updated, well-connected, and contradicted
// entities are considered more important.

function _computeImportance(entity) {
  // 1. Explicit importance (set via ingest { importance } or agent.remember)
  if (entity.importance != null && Number.isFinite(entity.importance)) return entity.importance;

  // 2. LLM-derived importance
  if (entity.metadata?.llm?.importance != null) return entity.metadata.llm.importance;

  // 3. Heuristic: version count (0.4) + link count (0.3) + contradiction (0.3)
  const versionSignal = Math.min((entity.versions?.length || 1) - 1, 10) / 10;
  const linkSignal    = Math.min(entity.links?.size || 0, 10) / 10;
  const hasContradiction = (entity.versions || []).some(v => v.delta?.contradicts) ? 1 : 0;
  return Math.min(1, versionSignal * 0.4 + linkSignal * 0.3 + hasContradiction * 0.3);
}

// ─── Parallel Hybrid Query ────────────────────────────────────────────────────

async function _runWorkers(queryVector, queryTerms, subset, { now = Date.now(), useRecency = true } = {}) {
  if (subset.length === 0) return { results: [], trustBreakdowns: new Map() };

  const numWorkers = os.cpus().length;
  const chunkSize  = Math.ceil(subset.length / numWorkers);
  const jobConfig  = {
    graphBoostWeight:   CFG.graphBoostWeight,
    keywordBoostWeight: CFG.keywordBoostWeight,
    llmBoostWeight:     CFG.llmBoostWeight,
    importanceWeight:   CFG.importanceWeight,
    recencyWeight:      CFG.recencyWeight,
    recencyHalfLifeMs:  CFG.recencyHalfLifeMs,
    trustWeight:        CFG.trustWeight,
    minFinalScore:      CFG.minFinalScore,
    minSemanticScore:   CFG.minSemanticScore,
    now,
    useRecency,
  };

  // Pre-compute multi-signal trust per entity in the main thread. The scalar
  // `trust` goes to the worker (used for scoring); the full breakdown stays
  // here in a Map and is re-attached to top-K results during assembly. This
  // avoids serialising a breakdown object for every entity we score.
  //
  // For historical queries (queryAt / queryRange), `updatedAt` on the subset
  // entity already reflects the snapshot time; we use it for recency decay.
  // Contradiction/corroboration counts still draw from the full version
  // history — point-in-time trust is a follow-up (documented in CLAUDE.md
  // under time-aware retrieval).
  const trustBreakdowns = new Map();
  const scoredEntities = subset.map(e => {
    const storeEntity = store.get(e.id) || e;
    const { trust, breakdown } = computeTrustSignals(storeEntity, {
      now,
      recencyHalfLifeMs: CFG.recencyHalfLifeMs,
    });
    trustBreakdowns.set(e.id, breakdown);
    return { e, trust };
  });

  const promises = [];
  for (let i = 0; i < numWorkers; i++) {
    const slice = scoredEntities.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!slice.length) continue;

    const chunk = slice.map(({ e, trust }) => ({
      id:          e.id,
      text:        e.text,
      type:        e.type || "text",
      vector:      e.vector,
      updatedAt:   e.updatedAt,
      links:       { size: e.links?.size || 0 },
      llmKeywords: e.llmKeywords || [],
      importance:  _computeImportance(e),
      trustScore:  trust,  // pre-computed composite replaces the stored scalar
    }));

    promises.push(_pool.run({ chunk, queryVector, queryTerms, config: jobConfig }));
  }

  const arrays = await Promise.all(promises);
  return { results: arrays.flat().filter(Boolean), trustBreakdowns };
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Semantic query over current memory (no time travel).
 *
 * For time-aware retrieval use:
 *   - `queryAt(text, timestamp, opts)`  — snapshot at a point in time
 *   - `queryRange(text, since, until, opts)` — version timeline overlap
 *
 * When `maxTokens` is supplied, results are packed greedily by score until the
 * token budget is exhausted — purpose-built for feeding results into agent
 * context windows. The `limit` parameter still caps the absolute number of
 * results but `maxTokens` may return fewer if the budget runs out first.
 * Token estimation uses ~4 characters per token (no external tokenizer needed).
 *
 * @param {string} text
 * @param {{ limit?, maxTokens?, filter?: { type?, since?, until?, tags?, memoryType?, workspaceId? }, allowedWorkspaces? }} [opts]
 * @returns {{ count, results, filter, asOf, since, until, config, tokenUsage? }}
 */
async function query(text, opts = {}) {
  if (opts && (opts.asOf != null || opts.since != null || opts.until != null)) {
    _assertInit();
    throw emitError(Err.validation(
      "query() does not accept time arguments. Use queryAt(text, timestamp) for time-travel or queryRange(text, since, until) for range queries."
    ));
  }
  return _queryInternal(text, opts);
}

/**
 * Time-travel query: score each entity against the version current at `timestamp`.
 * Entities that did not yet exist are skipped. Recency boost is disabled —
 * "now" has no meaning for a historical snapshot.
 *
 * @param {string} text
 * @param {number} timestamp — Unix ms
 * @param {{ limit?, maxTokens?, filter?, allowedWorkspaces? }} [opts]
 * @returns {{ count, results, filter, asOf, since, until, config, tokenUsage? }}
 */
async function queryAt(text, timestamp, opts = {}) {
  _assertInit();
  if (!Number.isFinite(Number(timestamp))) {
    throw emitError(Err.validation("queryAt: timestamp must be a finite Unix ms number"));
  }
  return _queryInternal(text, { ...opts, asOf: Number(timestamp) });
}

/**
 * Range query over the version timeline. An entity is included if any version's
 * active interval overlaps `[since, until]`. Each is scored against the version
 * current at `until` (or latest, if `until` is omitted). Either bound may be null
 * for an open-ended range.
 *
 * @param {string} text
 * @param {number|null} since — Unix ms (null for -Infinity)
 * @param {number|null} until — Unix ms (null for +Infinity)
 * @param {{ limit?, maxTokens?, filter?, allowedWorkspaces? }} [opts]
 * @returns {{ count, results, filter, asOf, since, until, config, tokenUsage? }}
 */
async function queryRange(text, since, until, opts = {}) {
  _assertInit();
  if (since == null && until == null) {
    throw emitError(Err.validation("queryRange: at least one of since or until must be provided"));
  }
  return _queryInternal(text, { ...opts, since, until });
}

async function _queryInternal(text, { limit = 10, maxTokens = null, filter = {}, asOf = null, since = null, until = null, allowedWorkspaces } = {}) {
  _assertInit();

  const hasRange = (since !== null && since !== undefined) || (until !== null && until !== undefined);
  const hasAsOf  = asOf !== null && asOf !== undefined;
  if (hasAsOf && hasRange) {
    throw emitError(Err.validation("asOf and { since, until } are distinct query modes — supply one or the other, not both"));
  }
  const sinceMs = hasRange ? (Number.isFinite(Number(since)) ? Number(since) : -Infinity) : null;
  const untilMs = hasRange ? (Number.isFinite(Number(until)) ? Number(until) :  Infinity) : null;
  if (hasRange && sinceMs > untilMs) {
    throw emitError(Err.validation(`since (${since}) must be <= until (${until})`));
  }

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

  // Range mode: keep entities whose version timeline overlaps [sinceMs, untilMs],
  // and score against the version current at untilMs (the range's right edge).
  // Versions are stored newest-first. A version v is "active" from v.timestamp until
  // the timestamp of the version written after it (or forever if it's the newest).
  // Overlap condition: v.timestamp <= untilMs AND (next version's timestamp > sinceMs
  // OR v is the newest). Simpler equivalent: any v with timestamp in [sinceMs, untilMs],
  // OR the version that was active at sinceMs (covers long-lived entities whose last
  // update predates the range but whose validity extends into it).
  if (hasRange) {
    subset = subset.map(e => {
      const versions = e.versions || [];
      if (!versions.length) return null;

      // Find the version current at untilMs (newest with timestamp <= untilMs)
      const scoreVersion = versions.find(v => v.timestamp <= untilMs);
      if (!scoreVersion) return null; // entity did not exist yet at untilMs

      // Overlap check: does any version's active interval intersect [sinceMs, untilMs]?
      // The version current at untilMs is always a candidate if its timestamp >= sinceMs
      // OR if its activity extends across sinceMs (i.e. it's the newest version current at untilMs
      // and was written before sinceMs — still active during the range).
      const overlaps = scoreVersion.timestamp >= sinceMs
        || versions.some(v => v.timestamp >= sinceMs && v.timestamp <= untilMs);
      if (!overlaps) return null;

      const historicalLinks = new Set(scoreVersion.linkIds || []);
      return {
        id:        e.id,
        type:      e.type,
        text:      scoreVersion.text,
        vector:    scoreVersion.vector,
        updatedAt: scoreVersion.timestamp,
        tags:      e.tags || [],
        links:     historicalLinks.size > 0 ? historicalLinks : e.links,
        memoryType:  e.memoryType || "long-term",
        workspaceId: e.workspaceId || "default",
        source:    scoreVersion.source || e.source || { type: "user" },
        classification: scoreVersion.classification || e.classification || "internal",
        delta:     scoreVersion.delta || null,
        trustScore: e.trustScore,
      };
    }).filter(Boolean);
  }

  const subsetById = new Map(subset.map(e => [e.id, e]));

  if (Object.keys(merged).length) subset = _applyFilter(subset, merged);

  // In range mode, "now" is the right edge of the range (for recency math parity),
  // and recency is disabled because the concept of "now" is undefined for a historical span.
  const rangeNow = hasRange
    ? (Number.isFinite(untilMs) ? untilMs : Date.now())
    : null;
  console.time("[kalairos] query");
  const { results: raw, trustBreakdowns } = await _runWorkers(queryVector, queryTerms, subset, {
    now:        hasAsOf ? asOf : (hasRange ? rangeNow : Date.now()),
    useRecency: !hasAsOf && !hasRange,
  });
  console.timeEnd("[kalairos] query");

  const sorted = raw
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit)
    .map(r => {
      const entity = subsetById.get(r.id);
      const breakdown = trustBreakdowns.get(r.id) || null;
      return {
        ...r,
        source:         entity?.source || { type: "user" },
        classification: entity?.classification || "internal",
        retention:      entity?.retention || { policy: "keep", expiresAt: null },
        memoryType:     entity?.memoryType || "long-term",
        workspaceId:    entity?.workspaceId || "default",
        // trustScore exposes the stored per-entity prior (source-default or annotation).
        // `trust` on the result (from kernel) is the composite used for scoring.
        trustScore:     entity?.trustScore != null
                          ? entity.trustScore
                          : _defaultTrustScore(entity?.source?.type || "user"),
        trustBreakdown: breakdown,
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
    since:   hasRange ? since : null,
    until:   hasRange ? until : null,
    config:  {
      minScore:      CFG.minFinalScore,
      minSemantic:   CFG.minSemanticScore,
      linkThreshold: CFG.linkThreshold,
      recencyWeight: (hasAsOf || hasRange) ? 0 : CFG.recencyWeight,
      trustWeight:   CFG.trustWeight,
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
  return _withWriteLock(() => {
    const numId = Number(id) || id;
    const e = store.get(numId);
    if (!e) throw emitError(Err.notFound(id));
    if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No admin access to workspace "${e.workspaceId || "default"}".`));
    if (e.deletedAt) throw emitError(Err.alreadyDeleted(id));

    _unlinkEntity(e, numId);
    e.deletedAt = Date.now();
    e.deletedBy = deletedBy ? _normalizeSource(deletedBy) : null;

    _persistAll();
    console.log(`[kalairos] Soft-deleted entity ${numId}`);
  });
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
  return _withWriteLock(() => {
    const numId = Number(id) || id;
    const e = store.get(numId);
    if (!e) throw emitError(Err.notFound(id));
    if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No admin access to workspace "${e.workspaceId || "default"}".`));

    _unlinkEntity(e, numId);
    store.delete(numId);
    _persistAll();
    console.log(`[kalairos] Purged entity ${numId} (permanent)`);
  });
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
  // consolidate holds the lock for its full duration because both the similarity
  // scan and the mutation loop must see a consistent store snapshot.
  return _withWriteLock(() => {
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
    console.log(`[kalairos] ${verb} ${merged.length} duplicate(s) across ${clusters.size} cluster(s)`);
    return { merged, totalMerged: merged.length };
  });
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
    writeQueue: { pending: _pendingWrites.length, max: CFG.writeQueueMax },
    runningSince:  new Date().toISOString(),
  };
}

// ─── Markdown Adapter ────────────────────────────────────────────────────────
// Bridges the gap between agents that think in .md and Kalairos's NDJSON persistence.
// exportMarkdown() produces human-readable markdown from entities;
// importMarkdown() parses it back and ingests each section.

/**
 * Export entities as human-readable markdown.
 * Agents can read/write this format instead of touching .kalairos directly.
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

  const lines = ["# Kalairos — Memory Export", ""];
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
 * This lets agents write memories as markdown and round-trip into Kalairos.
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
    _skipIO++;
    const ids = [];
    try {
      for (const sec of sections) {
        const factText = sec.lines.join(" ").trim();
        if (!factText) continue;
        const type = sec.type === "text" ? "text" : sec.type;
        ids.push(await ingest(factText, { ...defaults, type, allowedWorkspaces }));
      }
    } finally {
      _skipIO--;
    }
    _persistAll();
    console.log(`[kalairos] Imported ${ids.length} entities from structured markdown`);
    return { imported: ids.length, ids };
  }

  // Fallback: treat bullet points or plain lines as individual facts
  const bullets = lines
    .map(l => l.replace(/^[\s]*[-*]\s+/, "").trim())
    .filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"));

  if (!bullets.length) return { imported: 0, ids: [] };

  _skipIO++;
  const ids = [];
  try {
    for (const fact of bullets) {
      ids.push(await ingest(fact, { ...defaults, allowedWorkspaces }));
    }
  } finally {
    _skipIO--;
  }
  _persistAll();
  console.log(`[kalairos] Imported ${ids.length} entities from markdown bullets`);
  return { imported: ids.length, ids };
}

// ─── Time-aware Change Retrieval ─────────────────────────────────────────────

/**
 * Return all entities that changed (created or updated) after a given timestamp.
 * Each result includes the delta of the most recent change since `since`, so callers
 * can ask "what changed in the last hour?" and get structured diffs back.
 *
 * @param {number} since — Unix ms timestamp; entities touched after this are returned
 * @param {{ type?, workspaceId?, limit?, allowedWorkspaces? }} opts
 * @returns {{ since, count, changes: Array<{ id, type, text, changedAt, delta, source, trustScore, changeCount }> }}
 */
async function getChangeSince(since, { type, workspaceId, limit = 100, allowedWorkspaces } = {}) {
  _assertInit();
  const sinceMs = Number(since);
  if (!Number.isFinite(sinceMs)) throw emitError(Err.validation("since must be a valid timestamp (Unix ms)"));

  let entities = _getAllAlive();
  if (allowedWorkspaces) entities = entities.filter(e => _wsAllowed(e, allowedWorkspaces));
  if (type)        entities = entities.filter(e => e.type === type);
  if (workspaceId) entities = entities.filter(e => (e.workspaceId || "default") === workspaceId);

  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const changes   = [];

  for (const e of entities) {
    // All versions with timestamp > sinceMs (versions are newest-first)
    const newVersions = (e.versions || []).filter(v => v.timestamp > sinceMs);
    if (newVersions.length === 0) continue;

    // Oldest of the new versions gives us the delta _into_ this change window
    const firstNewVersion = newVersions[newVersions.length - 1];
    changes.push({
      id:          e.id,
      type:        e.type || "text",
      text:        e.text,
      changedAt:   newVersions[0].timestamp, // most recent change
      delta:       firstNewVersion.delta || null,
      source:      newVersions[0].source || e.source || { type: "user" },
      trustScore:  e.trustScore != null ? e.trustScore : _defaultTrustScore(e.source?.type || "user"),
      changeCount: newVersions.length,
    });
  }

  changes.sort((a, b) => b.changedAt - a.changedAt);

  return {
    since,
    count:   Math.min(changes.length, safeLimit),
    changes: changes.slice(0, safeLimit),
  };
}

// ─── Contradiction Access ─────────────────────────────────────────────────────

/**
 * Return all versions of an entity that have been flagged as contradicting a
 * prior version. This is a convenience wrapper over getHistory().
 *
 * @param {number|string} id
 * @param {{ allowedWorkspaces? }} opts
 * @returns {{ id, contradictions: object[], total: number }}
 */
async function getContradictions(id, { allowedWorkspaces } = {}) {
  _assertInit();
  const history = await getHistory(id, { allowedWorkspaces });
  const contradictions = (history.versions || []).filter(v => v.delta?.contradicts);
  return { id: history.id, contradictions, total: contradictions.length };
}

// ─── Semantic Drift Analysis ──────────────────────────────────────────────────

/**
 * Measure how much an entity's meaning has drifted across its version history.
 * Returns total drift, per-step breakdown, and a trend label.
 *
 * @param {number|string} id
 * @param {{ allowedWorkspaces? }} opts
 * @returns {{ id, versionCount, totalDrift, averageDrift, trend, steps }}
 */
async function getDrift(id, { allowedWorkspaces } = {}) {
  _assertInit();
  const history = await getHistory(id, { allowedWorkspaces });
  const drift   = measureDrift(history.versions || []);
  return { id: history.id, versionCount: history.versionCount, ...drift };
}

// ─── Annotation (trust + metadata, no new version) ───────────────────────────

/**
 * Update trust signals and metadata for an existing entity without creating a
 * new version. This is the right tool for human review, verification, and
 * manual trust scoring — operations that describe the _reliability_ of a memory
 * rather than a change in its content.
 *
 * Updatable fields:
 *   - trustScore  (0-1): how much to trust this memory
 *   - verified    (bool): human-confirmed correct
 *   - notes       (string): free-form annotation up to 500 chars
 *   - memoryType  (string): change the memory tier without a content update
 *
 * @param {number|string} id
 * @param {{ trustScore?, verified?, notes?, memoryType?, allowedWorkspaces? }} opts
 * @returns {object} updated serialized entity
 */
async function annotate(id, { trustScore, verified, notes, memoryType, allowedWorkspaces } = {}) {
  _assertInit();
  return _withWriteLock(() => {
    const numId = Number(id) || id;
    const e = store.get(numId);
    if (!e) throw emitError(Err.notFound(id));
    if (!_isAlive(e)) throw emitError(Err.alreadyDeleted(id));
    if (!_wsAllowed(e, allowedWorkspaces)) throw emitError(Err.forbidden(`No access to workspace "${e.workspaceId || "default"}".`));

    if (Number.isFinite(trustScore)) e.trustScore = Math.max(0, Math.min(1, trustScore));
    if (notes !== undefined)         e.metadata = { ...e.metadata, notes: String(notes).slice(0, 500) };
    if (verified !== undefined)      e.metadata = { ...e.metadata, verified: !!verified, verifiedAt: Date.now() };
    if (memoryType)                  e.memoryType = _normalizeMemoryType(memoryType);
    // updatedAt intentionally not changed — this is metadata, not a content update

    _persistAll();
    console.log(`[kalairos] Annotated entity ${numId} (trust=${e.trustScore?.toFixed(2)}, verified=${e.metadata?.verified ?? "–"})`);
    return _serializeEntity(e);
  });
}

// ─── Progressive Context Loading ─────────────────────────────────────────────
// Returns the most critical memories in minimal tokens so agents can boot
// without scanning the full store. No embedding/query needed — ranks by a
// composite of importance, recency, connectivity, and update frequency.

/**
 * Get a token-budgeted startup summary of the most critical memories.
 * Designed for agent boot: returns essential context in minimal tokens.
 *
 * Scoring (no query vector needed):
 *   importance × 0.4 + recency × 0.3 + connectivity × 0.15 + activity × 0.15
 *
 * @param {{ maxTokens?, maxItems?, depth?, filter?, allowedWorkspaces? }} opts
 *   - maxTokens:  token budget (default 500; ~4 chars/token)
 *   - maxItems:   hard cap on items (default depends on depth)
 *   - depth:      "essential" (top 5), "standard" (top 20), "full" (top 50)
 *   - filter:     standard filter object (type, tags, memoryType, workspaceId)
 *   - allowedWorkspaces: workspace isolation array
 * @returns {{ summary, items }}
 */
async function getStartupSummary({
  maxTokens = 500,
  maxItems,
  depth = "standard",
  filter = {},
  allowedWorkspaces,
} = {}) {
  _assertInit();

  const depthLimits = { essential: 5, standard: 20, full: 50 };
  const itemCap = maxItems || depthLimits[depth] || depthLimits.standard;
  const safeMaxTokens = Math.max(1, Math.floor(Number(maxTokens) || 500));

  let candidates = _getAllAlive();
  if (allowedWorkspaces) candidates = candidates.filter(e => _wsAllowed(e, allowedWorkspaces));
  if (Object.keys(filter).length) candidates = _applyFilter(candidates, filter);

  if (candidates.length === 0) {
    return {
      summary: { totalMemories: 0, itemsReturned: 0, tokenUsage: { budget: safeMaxTokens, used: 0 }, depth, generatedAt: new Date().toISOString() },
      items: [],
    };
  }

  // Pre-compute normalization bounds
  const now = Date.now();
  const halfLifeMs = CFG.recencyHalfLifeMs || 30 * 86_400_000;
  let maxLinks = 0, maxVersions = 0;
  for (const e of candidates) {
    const lc = e.links?.size || 0;
    const vc = e.versions?.length || 1;
    if (lc > maxLinks)    maxLinks = lc;
    if (vc > maxVersions) maxVersions = vc;
  }

  // Score each candidate without a query vector
  const scored = [];
  for (const e of candidates) {
    // Importance: from LLM enrichment metadata, default 0.5
    const importance = (e.metadata?.llm?.importance != null)
      ? Math.max(0, Math.min(1, Number(e.metadata.llm.importance)))
      : 0.5;

    // Recency: exponential half-life decay (same formula as kernel.js)
    const ageMs = Math.max(0, now - (e.updatedAt || e.createdAt || now));
    const recency = Math.exp(-Math.LN2 * ageMs / halfLifeMs);

    // Connectivity: normalized link count
    const connectivity = maxLinks > 0 ? Math.min(e.links?.size || 0, 10) / Math.min(maxLinks, 10) : 0;

    // Activity: normalized version count (frequently updated = important)
    const activity = maxVersions > 1 ? Math.min((e.versions?.length || 1) - 1, 20) / Math.min(maxVersions - 1, 20) : 0;

    const score = importance * 0.4 + recency * 0.3 + connectivity * 0.15 + activity * 0.15;

    scored.push({ entity: e, score, importance, recency });
  }

  scored.sort((a, b) => b.score - a.score);

  // Token-budgeted packing (same ~4 chars/token heuristic as query())
  const items = [];
  let tokensUsed = 0;
  for (const { entity: e, score, importance, recency } of scored) {
    if (items.length >= itemCap) break;
    const textTokens = Math.ceil(e.text.length / 4);
    const itemTokens = textTokens + 20; // metadata overhead
    if (items.length > 0 && tokensUsed + itemTokens > safeMaxTokens) break;
    tokensUsed += itemTokens;
    items.push({
      id:           e.id,
      type:         e.type || "text",
      text:         e.text,
      score:        +score.toFixed(4),
      importance:   +importance.toFixed(4),
      recency:      +recency.toFixed(4),
      memoryType:   e.memoryType || "long-term",
      tags:         e.tags || [],
      updatedAt:    e.updatedAt,
      versionCount: e.versions?.length || 1,
    });
  }

  return {
    summary: {
      totalMemories: candidates.length,
      itemsReturned: items.length,
      tokenUsage:    { budget: safeMaxTokens, used: tokensUsed },
      depth,
      generatedAt:   new Date().toISOString(),
    },
    items,
  };
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Flush pending writes and terminate worker pool. Call before process exit.
 */
async function shutdown() {
  if (!_initialized) return; // safe to call even if init() was never called
  _persistAll(); // final flush to backing store
  if (_pool) { await _pool.stop(); _pool = null; }
  if (store?.shutdown) await store.shutdown();
  _initialized = false;
  console.log("[kalairos] Shutdown complete");
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
  queryAt,
  queryRange,
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
  getStartupSummary,
  exportMarkdown,
  importMarkdown,
  // Time-aware retrieval
  getChangeSince,
  // Version semantics
  getContradictions,
  getDrift,
  buildChangelog,
  // Provenance & trust
  annotate,
  shutdown,
  createAgent,
  // Auth & Workspace ACL
  auth: _auth,
  // Error → Signal → Learning Loop
  onSignal:     require("./errors").onSignal,
  getSignals:   require("./errors").getSignals,
};
