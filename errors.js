// errors.js — Error → Signal → Learning Loop for Kalairos
//
// Every error is a signal. Signals carry structure. Structure enables learning.
// Agents subscribe to signals and adapt behavior based on error patterns.
"use strict";

// ─── Typed Error ─────────────────────────────────────────────────────────────

class KalairosError extends Error {
  /**
   * @param {string} code       — machine-readable error code (e.g. "ERR_PERSIST_FAILED")
   * @param {string} message    — human-readable detail
   * @param {object} [opts]
   * @param {boolean} [opts.recoverable=false] — can the caller retry or degrade gracefully?
   * @param {string}  [opts.suggestion]        — what should the caller do next?
   * @param {object}  [opts.context]           — structured data about the failure
   */
  constructor(code, message, { recoverable = false, suggestion, context } = {}) {
    super(message);
    this.name = "KalairosError";
    this.code = code;
    this.recoverable = recoverable;
    this.suggestion = suggestion || null;
    this.context = context || {};
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      suggestion: this.suggestion,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

// ─── Error Codes ─────────────────────────────────────────────────────────────

const Codes = {
  NOT_INITIALIZED:    "ERR_NOT_INITIALIZED",
  ENTITY_NOT_FOUND:   "ERR_ENTITY_NOT_FOUND",
  ALREADY_DELETED:    "ERR_ALREADY_DELETED",
  EMBEDDING_FAILED:   "ERR_EMBEDDING_FAILED",
  PERSIST_FAILED:     "ERR_PERSIST_FAILED",
  LOAD_FAILED:        "ERR_LOAD_FAILED",
  VALIDATION:         "ERR_VALIDATION",
  WORKER_FAILED:      "ERR_WORKER_FAILED",
  LLM_ENRICHMENT:     "ERR_LLM_ENRICHMENT",
  AUTH_FAILED:        "ERR_AUTH_FAILED",
  FORBIDDEN:          "ERR_FORBIDDEN",
  WRITE_QUEUE_FULL:   "ERR_WRITE_QUEUE_FULL",
  TEXT_TOO_LONG:      "ERR_TEXT_TOO_LONG",
};

// ─── Signal Bus ──────────────────────────────────────────────────────────────
// Lightweight pub/sub. Errors are emitted as signals. Subscribers decide
// what to learn from them (retry? degrade? alert?).

const _listeners = new Map();   // code → Set<fn>
const _globalListeners = new Set();
const _signalLog = [];          // bounded ring buffer of recent signals
const MAX_LOG = 200;

function _emit(signal) {
  _signalLog.push(signal);
  if (_signalLog.length > MAX_LOG) _signalLog.shift();

  for (const fn of _globalListeners) {
    try { fn(signal); } catch { /* listener errors must never propagate */ }
  }
  const byCode = _listeners.get(signal.code);
  if (byCode) {
    for (const fn of byCode) {
      try { fn(signal); } catch { /* same */ }
    }
  }
}

/**
 * Subscribe to error signals.
 * @param {string|null} code — specific error code, or null for all signals
 * @param {function} fn — (signal) => void
 * @returns {function} unsubscribe
 */
function onSignal(code, fn) {
  if (typeof code === "function") { fn = code; code = null; }
  if (code === null) {
    _globalListeners.add(fn);
    return () => _globalListeners.delete(fn);
  }
  if (!_listeners.has(code)) _listeners.set(code, new Set());
  _listeners.get(code).add(fn);
  return () => _listeners.get(code)?.delete(fn);
}

/** Get recent signals, optionally filtered by code. */
function getSignals(code) {
  if (!code) return [..._signalLog];
  return _signalLog.filter(s => s.code === code);
}

/** Clear all listeners and signal history. */
function resetSignals() {
  _listeners.clear();
  _globalListeners.clear();
  _signalLog.length = 0;
}

// ─── Signal Emitters (used by engine internals) ──────────────────────────────

function emitError(err) {
  if (err instanceof KalairosError) {
    _emit(err.toJSON());
  } else {
    _emit({
      code: "ERR_UNKNOWN",
      message: err?.message || String(err),
      recoverable: false,
      suggestion: null,
      context: {},
      timestamp: Date.now(),
    });
  }
  return err; // pass-through for throw chains
}

// ─── Convenience Constructors ────────────────────────────────────────────────

const Err = {
  notInitialized: () =>
    new KalairosError(Codes.NOT_INITIALIZED, "Kalairos not initialized. Call await kalairos.init() first.", {
      recoverable: true,
      suggestion: "Call init() before any operation.",
    }),

  notFound: (id) =>
    new KalairosError(Codes.ENTITY_NOT_FOUND, `Entity ${id} not found`, {
      recoverable: false,
      context: { entityId: id },
    }),

  alreadyDeleted: (id) =>
    new KalairosError(Codes.ALREADY_DELETED, `Entity ${id} is already deleted`, {
      recoverable: false,
      context: { entityId: id },
      suggestion: "Use purge() for permanent removal, or get() to inspect the soft-deleted entity.",
    }),

  embeddingFailed: (detail) =>
    new KalairosError(Codes.EMBEDDING_FAILED, `Embedding failed: ${detail}`, {
      recoverable: true,
      suggestion: "Check your embedFn configuration or retry.",
    }),

  persistFailed: (detail, cause) =>
    new KalairosError(Codes.PERSIST_FAILED, `Persistence failed: ${detail}`, {
      recoverable: true,
      suggestion: "Check disk space and file permissions.",
      context: { cause: cause?.code || cause?.message },
    }),

  loadFailed: (detail, line) =>
    new KalairosError(Codes.LOAD_FAILED, `Data load failed: ${detail}`, {
      recoverable: true,
      suggestion: "Inspect the data file for corruption. The malformed line was skipped.",
      context: { line },
    }),

  validation: (detail) =>
    new KalairosError(Codes.VALIDATION, detail, {
      recoverable: false,
      suggestion: "Check the input parameters.",
    }),

  workerFailed: (detail) =>
    new KalairosError(Codes.WORKER_FAILED, `Worker scoring failed: ${detail}`, {
      recoverable: true,
      suggestion: "Query will retry on the main thread if workers fail.",
    }),

  authFailed: () =>
    new KalairosError(Codes.AUTH_FAILED, "Authentication required. Provide a valid Bearer token.", {
      recoverable: false,
      suggestion: "Include an Authorization: Bearer <token> header.",
    }),

  forbidden: (detail) =>
    new KalairosError(Codes.FORBIDDEN, detail || "You do not have permission for this operation.", {
      recoverable: false,
      suggestion: "Check your workspace role. Required permission may be read, write, admin, or owner.",
    }),

  writeQueueFull: (depth, max) =>
    new KalairosError(Codes.WRITE_QUEUE_FULL,
      `Write queue is full (${depth}/${max} pending). Retry after a short delay.`, {
      recoverable: true,
      suggestion: "Reduce concurrent write rate or increase writeQueueMax in init().",
      context: { queueDepth: depth, queueMax: max },
    }),

  textTooLong: (actual, max) =>
    new KalairosError(Codes.TEXT_TOO_LONG,
      `Memory text is ${actual} characters, exceeds maxTextLen=${max}.`, {
      recoverable: false,
      suggestion: "Split the text into smaller memories, or raise the cap via init({ maxTextLen }) or KALAIROS_MAX_TEXT_LEN env.",
      context: { actual, max },
    }),
};

module.exports = { KalairosError, Codes, Err, emitError, onSignal, getSignals, resetSignals };
