// agent.js — Lightweight agent helper for Kalairos
// A thin, opinionated wrapper that gives agents a clean, high-level interface
// for durable memory. Completely optional — the raw API works just as well.
"use strict";

/**
 * Create an AgentMemory instance backed by a Kalairos engine.
 *
 * @param {object} engine — the core lib (index.js exports) or a remote client
 * @param {{ name: string, defaultClassification?: string, defaultTags?: string[] }} opts
 * @returns {AgentMemory}
 *
 * @example
 * const kalairos = require("kalairos");
 * await kalairos.init({ ... });
 * const agent = kalairos.createAgent({ name: "budget-planner" });
 * await agent.remember("Q2 budget is 2.4M");
 * await agent.update("Q2 budget is now 2.7M");
 * const results = await agent.recall("Q2 budget");
 */
class AgentMemory {
  /**
   * @param {object} engine — object with remember/query/getHistory methods
   * @param {object} opts
   * @param {string} opts.name — agent identity (stored in provenance)
   * @param {string} [opts.defaultClassification="internal"]
   * @param {string[]} [opts.defaultTags=[]]
   * @param {boolean} [opts.useLLM=false] — enable LLM enrichment by default for this agent
   */
  constructor(engine, { name, defaultClassification = "internal", defaultTags = [], useLLM = false }) {
    if (!name) throw new Error("agent name is required");
    if (!engine) throw new Error("engine is required");
    this._engine = engine;
    this.name = name;
    this.defaultClassification = defaultClassification;
    this.defaultTags = Array.isArray(defaultTags) ? [...defaultTags] : [];
    this.useLLM = !!useLLM;
  }

  /**
   * Build the source object for this agent.
   * @returns {{ type: "agent", actor: string }}
   */
  _source() {
    return { type: "agent", actor: this.name };
  }

  /**
   * Merge caller opts with agent defaults.
   * @param {object} opts
   * @returns {object}
   */
  _mergeOpts(opts = {}) {
    return {
      ...opts,
      source: opts.source || this._source(),
      classification: opts.classification || this.defaultClassification,
      tags: Array.from(new Set([...this.defaultTags, ...(opts.tags || [])])),
      useLLM: opts.useLLM !== undefined ? opts.useLLM : this.useLLM,
    };
  }

  /**
   * Store a new fact or update an existing one (version detection is automatic).
   * @param {string} text
   * @param {{ type?, timestamp?, metadata?, tags?, classification? }} [opts]
   * @returns {Promise<number>} stable entity ID
   */
  async remember(text, opts = {}) {
    const merged = this._mergeOpts(opts);
    if (opts.allowedWorkspaces) merged.allowedWorkspaces = opts.allowedWorkspaces;
    return this._engine.remember(text, merged);
  }

  /**
   * Alias for remember() — makes intent explicit when updating a known fact.
   * @param {string} text
   * @param {{ type?, timestamp?, metadata?, tags?, classification? }} [opts]
   * @returns {Promise<number>} stable entity ID
   */
  async update(text, opts = {}) {
    return this.remember(text, opts);
  }

  /**
   * Recall memories matching a query (current state, no time travel).
   * @param {string} text — natural language query
   * @param {{ limit?, maxTokens?, filter?, allowedWorkspaces? }} [opts]
   * @returns {Promise<{ count, results, filter, config }>}
   */
  async recall(text, opts = {}) {
    return this._engine.query(text, opts);
  }

  /**
   * Recall memory state as of a specific point in time.
   * @param {string} text — natural language query
   * @param {number} timestamp — Unix ms
   * @param {{ limit?, maxTokens?, filter?, allowedWorkspaces? }} [opts]
   */
  async recallAt(text, timestamp, opts = {}) {
    return this._engine.queryAt(text, timestamp, opts);
  }

  /**
   * Recall memories whose version timeline overlaps `[since, until]`.
   * @param {string} text — natural language query
   * @param {number|null} since — Unix ms
   * @param {number|null} until — Unix ms
   * @param {{ limit?, maxTokens?, filter?, allowedWorkspaces? }} [opts]
   */
  async recallRange(text, since, until, opts = {}) {
    return this._engine.queryRange(text, since, until, opts);
  }

  /**
   * Get the full version history and provenance trail for an entity.
   * @param {number} id — entity ID
   * @returns {Promise<object>} history object with versions array
   */
  async getHistory(id) {
    return this._engine.getHistory(id);
  }

  /**
   * Extract discrete facts from raw text and ingest each as a separate memory.
   * Requires factExtractFn to be configured via init().
   * @param {string} text — raw text (meeting notes, paragraphs, etc.)
   * @param {{ type?, timestamp?, metadata?, tags?, classification? }} [opts]
   * @returns {Promise<{ facts: string[], ids: number[] }>}
   */
  async learnFrom(text, opts = {}) {
    const merged = this._mergeOpts(opts);
    if (opts.allowedWorkspaces) merged.allowedWorkspaces = opts.allowedWorkspaces;
    return this._engine.extractFacts(text, merged);
  }

  /**
   * Boot the agent with a token-budgeted summary of the most critical memories.
   * Call once at startup instead of searching the full store.
   *
   * @param {{ maxTokens?, maxItems?, depth?, filter? }} [opts]
   *   - maxTokens:  token budget (default 500)
   *   - maxItems:   hard cap on returned items
   *   - depth:      "essential" | "standard" | "full"
   *   - filter:     standard filter object (type, tags, memoryType, workspaceId)
   * @returns {Promise<{ summary, items }>}
   */
  async boot(opts = {}) {
    return this._engine.getStartupSummary({
      ...opts,
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Inspect contradictions across all versions of an entity.
   * Returns an array of versions that have contradicts === true.
   * @param {number} id — entity ID
   * @returns {Promise<{ id, contradictions: object[] }>}
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
   * Promote a short-term or working memory to long-term memory.
   * Does not create a new content version — only changes the memory tier.
   *
   * @param {number} id — entity ID to promote
   * @param {{ allowedWorkspaces? }} [opts]
   * @returns {Promise<object>} updated entity
   */
  async promote(id, opts = {}) {
    if (typeof this._engine.annotate !== "function") {
      throw new Error("Engine does not support annotate(). Upgrade kalairos.");
    }
    return this._engine.annotate(id, {
      memoryType: "long-term",
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Explicitly forget (soft-delete) an entity with a stated reason.
   * The memory is removed from retrieval but kept for audit. Use purge() for GDPR erasure.
   *
   * @param {number} id — entity ID to forget
   * @param {string} [reason] — why this memory is being discarded
   * @param {{ allowedWorkspaces? }} [opts]
   */
  async forget(id, reason = "explicit forget", opts = {}) {
    return this._engine.remove(id, {
      deletedBy: { type: "agent", actor: this.name, reason },
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Consolidate short-term and working memories at the end of a session.
   * Merges near-duplicates and returns a report of what was merged.
   * Call this before shutting the agent down to keep long-term memory clean.
   *
   * @param {{ threshold?, dryRun? }} [opts]
   * @returns {Promise<{ merged, totalMerged }>}
   */
  async consolidateSession(opts = {}) {
    return this._engine.consolidate({
      ...opts,
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Get all entities currently in working memory for this agent's workspace.
   * Useful for inspecting transient context before deciding what to promote or forget.
   *
   * @param {{ limit?, workspaceId? }} [opts]
   * @returns {Promise<{ total, page, pages, entities }>}
   */
  async getWorkingMemory(opts = {}) {
    return this._engine.listEntities({
      memoryType: "working",
      limit: opts.limit || 50,
      workspaceId: opts.workspaceId,
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Measure semantic drift of an entity — how much its meaning has changed over time.
   * @param {number} id — entity ID
   * @returns {Promise<{ id, versionCount, totalDrift, averageDrift, trend, steps }>}
   */
  async getDrift(id) {
    if (typeof this._engine.getDrift === "function") {
      return this._engine.getDrift(id);
    }
    throw new Error("Engine does not support getDrift(). Upgrade kalairos.");
  }

  /**
   * Annotate an entity with trust signals without creating a new content version.
   * @param {number} id
   * @param {{ trustScore?, verified?, notes?, memoryType? }} opts
   * @returns {Promise<object>} updated entity
   */
  async annotate(id, opts = {}) {
    if (typeof this._engine.annotate !== "function") {
      throw new Error("Engine does not support annotate(). Upgrade kalairos.");
    }
    return this._engine.annotate(id, {
      ...opts,
      allowedWorkspaces: opts.allowedWorkspaces,
    });
  }

  /**
   * Alias for boot() — returns a token-budgeted summary of the most important memories.
   * @param {{ maxTokens?, depth?, filter? }} [opts]
   * @returns {Promise<{ summary, items }>}
   */
  async summarize(opts = {}) {
    return this.boot(opts);
  }
}

module.exports = { AgentMemory };
