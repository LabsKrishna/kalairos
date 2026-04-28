// agent.js — Scoped memory helper for Kalairos.
//
// `MemoryScope` is a thin, opinionated wrapper around the core engine that
// pre-fills provenance, classification, and tags on every write, and exposes
// the same vocabulary as the flat top-level API (`remember`, `query`, `queryAt`,
// `getHistory`, `annotate`, `getContradictions`, `remove`).
//
// The legacy `AgentMemory` name and its `recall`/`update`/`forget` verbs are
// kept as deprecated aliases so existing callers (including `createAgent()`)
// continue to work unchanged.
"use strict";

/**
 * Bounded memory handle with prefilled provenance / classification / tags.
 *
 * @example
 * const kalairos = require("kalairos");
 * await kalairos.init({ embedFn });
 * const scope = kalairos.scope({
 *   source: { type: "agent", actor: "budget-planner" },
 *   classification: "confidential",
 *   tags: ["finance"],
 * });
 * await scope.remember("Q2 budget is 2.4M");
 * const { results } = await scope.query("Q2 budget");
 */
class MemoryScope {
  /**
   * @param {object} engine — object with remember/query/getHistory/... methods
   * @param {object} opts
   * @param {{type: string, actor?: string, uri?: string}} [opts.source]
   *   Provenance stamped on every write originating from this scope.
   * @param {string} [opts.classification="internal"] — default classification for writes.
   * @param {string[]} [opts.tags=[]] — tags merged into every write.
   * @param {string} [opts.memoryType] — optional default memoryType (e.g. "working").
   * @param {string} [opts.workspaceId] — optional default workspaceId.
   * @param {boolean} [opts.useLLM=false] — enable LLM enrichment by default.
   *
   * Back-compat: also accepts the legacy `{ name, defaultClassification, defaultTags }`
   * shape used by `createAgent()`. `name` becomes `source: { type: "agent", actor: name }`.
   */
  constructor(engine, opts = {}) {
    if (!engine) throw new Error("engine is required");

    // Legacy shape support: { name, defaultClassification, defaultTags }
    const legacyName = opts.name;
    const source = opts.source || (legacyName ? { type: "agent", actor: legacyName } : null);
    const classification = opts.classification || opts.defaultClassification || "internal";
    const tagsInput = opts.tags || opts.defaultTags || [];

    this._engine = engine;
    this.source = source;
    this.classification = classification;
    this.tags = Array.isArray(tagsInput) ? [...tagsInput] : [];
    this.memoryType = opts.memoryType || null;
    this.workspaceId = opts.workspaceId || null;
    this.useLLM = !!opts.useLLM;

    // Legacy read accessor used by tests/benches: scope.name
    if (legacyName) this.name = legacyName;
    else if (source && source.actor) this.name = source.actor;
  }

  /** @private */
  _mergeOpts(opts = {}) {
    const merged = { ...opts };
    if (!merged.source && this.source) merged.source = this.source;
    if (!merged.classification) merged.classification = this.classification;
    const extraTags = Array.isArray(opts.tags) ? opts.tags : [];
    merged.tags = Array.from(new Set([...this.tags, ...extraTags]));
    if (!merged.memoryType && this.memoryType) merged.memoryType = this.memoryType;
    if (!merged.workspaceId && this.workspaceId) merged.workspaceId = this.workspaceId;
    if (merged.useLLM === undefined) merged.useLLM = this.useLLM;

    // Auto-fill `who.agent` from the scope identity so trail events carry
    // attribution without the caller having to thread it through every call.
    const scopeAgent = (this.source && this.source.actor) || this.name || null;
    if (!merged.who && scopeAgent) {
      merged.who = { agent: scopeAgent };
    } else if (merged.who && !merged.who.agent && scopeAgent) {
      merged.who = { ...merged.who, agent: scopeAgent };
    }
    return merged;
  }

  // ─── Canonical (flat-API aligned) methods ──────────────────────────────────

  /**
   * Store or update a fact. Version detection is automatic — the engine decides
   * whether this is a new entity or a new version of an existing one.
   * @param {string} text
   * @param {object} [opts]
   * @returns {Promise<number>} stable entity id
   */
  async remember(text, opts = {}) {
    return this._engine.remember(text, this._mergeOpts(opts));
  }

  /**
   * Retrieve memories relevant to `text` (current state).
   * @param {string} text
   * @param {object} [opts]
   */
  async query(text, opts = {}) {
    return this._engine.query(text, opts);
  }

  /**
   * Time-travel query — state as we believed it at `timestamp` (Unix ms).
   */
  async queryAt(text, timestamp, opts = {}) {
    return this._engine.queryAt(text, timestamp, opts);
  }

  /**
   * Range query — entities whose version timeline overlaps `[since, until]`.
   */
  async queryRange(text, since, until, opts = {}) {
    return this._engine.queryRange(text, since, until, opts);
  }

  /**
   * Full version history and provenance trail for an entity.
   */
  async getHistory(id) {
    return this._engine.getHistory(id);
  }

  /**
   * Annotate an entity (trust, verified, notes, memoryType) without creating
   * a new content version.
   */
  async annotate(id, opts = {}) {
    if (typeof this._engine.annotate !== "function") {
      throw new Error("Engine does not support annotate(). Upgrade kalairos.");
    }
    return this._engine.annotate(id, { ...opts });
  }

  /**
   * Inspect contradictions across all versions of an entity.
   */
  async getContradictions(id) {
    if (typeof this._engine.getContradictions === "function") {
      return this._engine.getContradictions(id);
    }
    const history = await this._engine.getHistory(id);
    const contradictions = ((history && history.versions) || []).filter(v => v.delta?.contradicts);
    return { id, contradictions, total: contradictions.length };
  }

  /**
   * Soft-delete an entity with a stated reason. Use `purge()` on the core API
   * for permanent GDPR-style erasure.
   */
  async remove(id, opts = {}) {
    const reason = opts.reason || "scope remove";
    const actor = (this.source && this.source.actor) || this.name || "scope";
    return this._engine.remove(id, {
      deletedBy: opts.deletedBy || { type: "scope", actor, reason },
      reason,
      who: opts.who || (actor ? { agent: actor } : null),
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Restore a previously forgotten entity. Pairs with `forget()`.
   */
  async restore(id, opts = {}) {
    if (typeof this._engine.restore !== "function") {
      throw new Error("Engine does not support restore(). Upgrade kalairos.");
    }
    const actor = (this.source && this.source.actor) || this.name || "scope";
    return this._engine.restore(id, {
      reason: opts.reason,
      who:    opts.who || (actor ? { agent: actor } : null),
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Read-only audit trail of memory mutations across the store, scoped to
   * this scope's workspace by default.
   */
  async trail(opts = {}) {
    if (typeof this._engine.trail !== "function") {
      throw new Error("Engine does not support trail(). Upgrade kalairos.");
    }
    const merged = { ...opts };
    if (!merged.workspace && this.workspaceId) merged.workspace = this.workspaceId;
    return this._engine.trail(merged);
  }

  /**
   * Create a named checkpoint over the trail.
   */
  async checkpoint(name, opts = {}) {
    if (typeof this._engine.checkpoint !== "function") {
      throw new Error("Engine does not support checkpoint(). Upgrade kalairos.");
    }
    const merged = { ...opts };
    if (!merged.workspace && this.workspaceId) merged.workspace = this.workspaceId;
    return this._engine.checkpoint(name, merged);
  }

  /**
   * Measure semantic drift of an entity across its versions.
   */
  async getDrift(id) {
    if (typeof this._engine.getDrift === "function") return this._engine.getDrift(id);
    throw new Error("Engine does not support getDrift(). Upgrade kalairos.");
  }

  /**
   * Extract discrete facts from raw text and ingest each as a separate memory.
   * Requires `factExtractFn` configured via `init()`.
   */
  async extractFacts(text, opts = {}) {
    return this._engine.extractFacts(text, this._mergeOpts(opts));
  }

  /**
   * Token-budgeted summary of the most critical memories for this scope.
   */
  async getStartupSummary(opts = {}) {
    return this._engine.getStartupSummary({ ...opts });
  }

  /**
   * Consolidate near-duplicate memories. Thin pass-through to `engine.consolidate()`.
   */
  async consolidate(opts = {}) {
    return this._engine.consolidate({ ...opts });
  }

  // ─── Deprecated aliases (kept for back-compat with AgentMemory callers) ────

  /** @deprecated use `remember()` */
  async update(text, opts = {}) { return this.remember(text, opts); }

  /** @deprecated use `query()` */
  async recall(text, opts = {}) { return this.query(text, opts); }

  /** @deprecated use `queryAt()` */
  async recallAt(text, timestamp, opts = {}) { return this.queryAt(text, timestamp, opts); }

  /** @deprecated use `queryRange()` */
  async recallRange(text, since, until, opts = {}) { return this.queryRange(text, since, until, opts); }

  /** @deprecated use `extractFacts()` */
  async learnFrom(text, opts = {}) { return this.extractFacts(text, opts); }

  /** @deprecated use `getStartupSummary()` */
  async boot(opts = {}) { return this.getStartupSummary(opts); }

  /** @deprecated use `getStartupSummary()` */
  async summarize(opts = {}) { return this.getStartupSummary(opts); }

  /**
   * Forget an entity with an explicit reason. First-class verb that pairs with
   * `restore()`. Delegates to the engine's `forget()` when available; older
   * engines still get a soft-delete via `remove()`.
   */
  async forget(id, reasonOrOpts = "explicit forget", legacyOpts = {}) {
    // Back-compat: forget(id, "reason", opts) AND forget(id, { reason, who })
    let opts;
    if (reasonOrOpts && typeof reasonOrOpts === "object") {
      opts = { ...reasonOrOpts };
    } else {
      opts = { reason: String(reasonOrOpts), ...legacyOpts };
    }
    const actor = (this.source && this.source.actor) || this.name || "scope";
    if (!opts.who && actor) opts.who = { agent: actor };
    if (typeof this._engine.forget === "function") {
      return this._engine.forget(id, opts);
    }
    return this.remove(id, opts);
  }

  /** @deprecated use `consolidate()` */
  async consolidateSession(opts = {}) { return this.consolidate(opts); }

  /** @deprecated use `annotate(id, { memoryType: "long-term" })` */
  async promote(id, opts = {}) {
    return this.annotate(id, { memoryType: "long-term", allowedWorkspaces: opts.allowedWorkspaces });
  }

  /** @deprecated — scope does not carry workspace filtering; call engine.listEntities directly. */
  async getWorkingMemory(opts = {}) {
    return this._engine.listEntities({
      memoryType: "working",
      limit: opts.limit || 50,
      workspaceId: opts.workspaceId || this.workspaceId,
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }
}

/**
 * Deprecated alias for `MemoryScope`. Prefer `kalairos.scope(...)`.
 * Kept so `new AgentMemory(engine, { name })` and direct imports keep working.
 * @deprecated
 */
const AgentMemory = MemoryScope;

module.exports = { MemoryScope, AgentMemory };
