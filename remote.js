// remote.js — HTTP client for a running Kalairos server
// Mirrors the lib API surface so you can swap in-process ↔ remote by changing one line.
"use strict";

let _createAgentWarned = false;

/**
 * Connect to a Kalairos HTTP server.
 * @param {string} baseUrl — default: "http://localhost:3000"
 * @param {{ token?: string }} opts — optional auth token for Bearer authentication
 * @returns {object} client with the same method names as the core engine
 *
 * @example
 * const { connect } = require('kalairos/remote');
 * const db = connect('http://localhost:3000');
 * await db.ingest('The meeting is at 3pm');
 * const results = await db.query('when is the meeting?');
 *
 * @example // with auth
 * const db = connect('http://localhost:3000', { token: 'my-secret-token' });
 */
function connect(baseUrl = "http://localhost:3000", { token } = {}) {
  const base = baseUrl.replace(/\/$/, "");

  // Bearer tokens over plain HTTP to a non-loopback host leak credentials.
  // We don't refuse the connection — local proxies and dev tunnels are valid
  // use cases — but we warn loudly so the misconfig is visible in logs.
  if (token && /^http:\/\//i.test(base)) {
    const host = base.replace(/^http:\/\//i, "").split("/")[0].split(":")[0];
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (!isLoopback) {
      console.warn(
        `[kalairos] WARNING: connecting to ${base} with a bearer token over plain HTTP. ` +
        `The token will be sent in cleartext. Use https:// for any non-loopback host.`
      );
    }
  }

  function _headers() {
    const h = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  async function post(path, body) {
    const res  = await fetch(`${base}${path}`, {
      method:  "POST",
      headers: _headers(),
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { code: data.error });
    return data;
  }

  async function get(path) {
    const res  = await fetch(`${base}${path}`, { headers: _headers() });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { code: data.error });
    return data;
  }

  async function del(path) {
    const res  = await fetch(`${base}${path}`, { method: "DELETE", headers: _headers() });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { code: data.error });
    return data;
  }

  return {
    ingest:           (text, opts = {})               => post("/ingest", { text, ...opts }),
    remember:         (text, opts = {})               => post("/remember", { text, ...opts }),
    ingestBatch:      (items)                         => post("/ingest/batch", { items }),
    ingestTimeSeries: (label, points, opts = {})      => post("/ingest/timeseries", { label, points, ...opts }),
    ingestFile:       (filePath, opts = {})           => post("/ingest/file", { filePath, ...opts }),
    query:            (text, opts = {})               => post("/query", { text, ...opts }),
    queryAt:          (text, timestamp, opts = {})    => post("/query", { text, asOf: timestamp, ...opts }),
    queryValidAt:     (text, timestamp, opts = {})    => post("/query", { text, validAt: timestamp, ...opts }),
    queryRange:       (text, since, until, opts = {}) => post("/query", { text, since, until, ...opts }),
    get:              (id)                            => get(`/entity/${id}`),
    getMany:          (ids)                           => post("/entities/batch", { ids }),
    remove:           (id)                            => del(`/entity/${id}`),
    getHistory:       (id)                            => get(`/history/${id}`),
    listEntities:     (opts = {})                     => {
      const params = new URLSearchParams(
        Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
      );
      return get(`/entities?${params}`);
    },
    getGraph:         ()                              => get("/graph"),
    traverse:         (id, depth = 1)                => get(`/traverse/${id}?depth=${depth}`),
    getStatus:        ()                              => get("/status"),
    extractFacts:     (text, opts = {})               => post("/extract-facts", { text, ...opts }),
    consolidate:      (opts = {})                     => post("/consolidate", opts),
    exportMarkdown:   (opts = {})                     => {
      const params = new URLSearchParams(
        Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
      );
      return get(`/export/markdown?${params}`);
    },
    importMarkdown:   (markdown, opts = {})           => post("/import/markdown", { markdown, ...opts }),

    /**
     * Create a bounded remote memory scope. Returns a handle whose methods use
     * the flat-API vocabulary (`remember`, `query`, `queryAt`, `queryValidAt`,
     * `getHistory`,
     * `getContradictions`) and forward to the server under the hood.
     *
     * @param {object} [opts]
     * @param {{type:string, actor?:string, uri?:string}} [opts.source]
     * @param {string}   [opts.classification]
     * @param {string[]} [opts.tags]
     * @param {string}   [opts.memoryType]
     * @param {string}   [opts.workspaceId]
     * @returns {Promise<object>} remote scope proxy
     */
    async scope(opts = {}) {
      // Map flat-API opts to legacy /agent/create shape on the wire.
      const name = opts.name || opts.source?.actor || "scope";
      const payload = {
        name,
        defaultClassification: opts.classification || opts.defaultClassification,
        defaultTags:           opts.tags || opts.defaultTags,
        useLLM:                !!opts.useLLM,
      };
      const { agentId } = await post("/agent/create", payload);
      const actor = name;
      return {
        name:             actor,
        agentId,
        // Canonical flat-API verbs
        remember:         (text, o = {}) => post(`/agent/${agentId}/remember`, { text, ...o }),
        query:            (text, o = {}) => post(`/agent/${agentId}/recall`, { text, ...o }),
        queryAt:          (text, timestamp, o = {}) =>
                            post(`/agent/${agentId}/recall`, { text, asOf: Number(timestamp), ...o }),
        queryValidAt:     (text, timestamp, o = {}) =>
                            post(`/agent/${agentId}/recall`, { text, validAt: Number(timestamp), ...o }),
        queryRange:       (text, since, until, o = {}) =>
                            post(`/agent/${agentId}/recall`, { text, since, until, ...o }),
        getHistory:       (entityId)     => get(`/agent/${agentId}/history/${entityId}`),
        getContradictions:(entityId)     => get(`/agent/${agentId}/contradictions/${entityId}`),
        extractFacts:     (text, o = {}) => post(`/agent/${agentId}/learn-from`, { text, ...o }),
        // Deprecated aliases — preserved for back-compat with the old AgentMemory surface
        update:           (text, o = {}) => post(`/agent/${agentId}/update`, { text, ...o }),
        recall:           (text, o = {}) => post(`/agent/${agentId}/recall`, { text, ...o }),
        learnFrom:        (text, o = {}) => post(`/agent/${agentId}/learn-from`, { text, ...o }),
      };
    },

    /**
     * @deprecated Use `client.scope({ source: { type: "agent", actor: name }, ... })` instead.
     * Thin back-compat shim over the server's /agent/create endpoint.
     */
    async createAgent(opts) {
      if (!_createAgentWarned) {
        _createAgentWarned = true;
        console.warn(
          "[kalairos] remote createAgent() is deprecated and will be removed in 2.0. " +
          "Use client.scope({ source: { type: 'agent', actor: name }, classification, tags })."
        );
      }
      const { agentId } = await post("/agent/create", opts);
      return {
        name: opts.name,
        agentId,
        remember:         (text, o = {}) => post(`/agent/${agentId}/remember`, { text, ...o }),
        update:           (text, o = {}) => post(`/agent/${agentId}/update`, { text, ...o }),
        recall:           (text, o = {}) => post(`/agent/${agentId}/recall`, { text, ...o }),
        learnFrom:        (text, o = {}) => post(`/agent/${agentId}/learn-from`, { text, ...o }),
        getHistory:       (entityId)     => get(`/agent/${agentId}/history/${entityId}`),
        getContradictions:(entityId)     => get(`/agent/${agentId}/contradictions/${entityId}`),
      };
    },

    // ── Auth Management ──────────────────────────────────────────────────────
    auth: {
      enable:           ()                              => post("/auth/enable", {}),
      disable:          ()                              => post("/auth/disable", {}),
      status:           ()                              => get("/auth/status"),
      addPrincipal:     (opts)                          => post("/auth/principals", opts),
      removePrincipal:  (id)                            => del(`/auth/principals/${id}`),
      listPrincipals:   ()                              => get("/auth/principals"),
      grant:            (principalId, workspaceId, role) => post("/auth/grant", { principalId, workspaceId, role }),
      revoke:           (principalId, workspaceId)       => post("/auth/revoke", { principalId, workspaceId }),
      getAuditLog:      (opts = {})                     => {
        const params = new URLSearchParams(
          Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
        );
        return get(`/auth/audit?${params}`);
      },
    },
  };
}

module.exports = { connect };
