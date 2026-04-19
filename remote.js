// remote.js — HTTP client for a running Kalairos server
// Mirrors the lib API surface so you can swap in-process ↔ remote by changing one line.
"use strict";

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
     * Create a remote agent helper. Returns the same AgentMemory-like interface
     * backed by the server's /agent/* endpoints.
     *
     * @param {{ name: string, defaultClassification?: string, defaultTags?: string[] }} opts
     * @returns {Promise<object>} remote agent proxy
     */
    async createAgent(opts) {
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
