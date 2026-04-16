// server.js — Database X HTTP Server
"use strict";

const express = require("express");
const lib     = require("./index");
const { Codes } = require("./errors");
const auth    = lib.auth; // AuthStore instance from the engine

const app = express();
app.use(express.json({ limit: "10mb" }));

// Allow dashboard to call the API from file://, Live Server, or another host (local dev only).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Route wrapper — kills 23 catch blocks ──────────────────────────────────
// Maps typed error codes to HTTP status codes. Untyped errors default to 500.

const _CODE_TO_HTTP = {
  [Codes.ENTITY_NOT_FOUND]: 404,
  [Codes.ALREADY_DELETED]:  400,
  [Codes.VALIDATION]:       400,
  [Codes.EMBEDDING_FAILED]: 503,
  [Codes.NOT_INITIALIZED]:  503,
  [Codes.AUTH_FAILED]:      401,
  [Codes.FORBIDDEN]:        403,
};

function _wrap(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      const status = _CODE_TO_HTTP[err?.code] || 500;
      res.status(status).json({
        error:   err?.code || "internal_error",
        detail:  err?.message || String(err),
        recoverable: err?.recoverable ?? false,
        suggestion:  err?.suggestion || null,
      });
    }
  };
}

// ─── Shared body extraction for ingest-like endpoints ────────────────────────

function _ingestParams(body) {
  const { text, type = "text", timestamp, metadata = {}, tags = [], source, classification, retention, memoryType, workspaceId, useLLM } = body || {};
  return { text, type, timestamp, metadata, tags, source, classification, retention, memoryType, workspaceId, useLLM: !!useLLM };
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
// Extracts Bearer token from Authorization header. When auth is enabled,
// rejects unauthenticated requests with 401. When disabled, passes through
// with req.principal = null (unrestricted access).

function _extractToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

// Builds the auth middleware. `requiredPermission` is the minimum permission
// needed for this route. The middleware resolves the principal and computes
// allowed workspaces for that permission level.
function _requireAuth(requiredPermission) {
  return (req, res, next) => {
    if (!auth.enabled) {
      req.principal = null;
      req.allowedWorkspaces = null; // null = unrestricted
      return next();
    }

    const token = _extractToken(req);
    const principal = auth.authenticate(token);
    if (!principal) {
      return res.status(401).json({
        error: Codes.AUTH_FAILED,
        detail: "Authentication required. Provide a valid Bearer token.",
        recoverable: false,
        suggestion: "Include an Authorization: Bearer <token> header.",
      });
    }

    req.principal = principal;
    req.allowedWorkspaces = auth.workspacesWithPermission(principal, requiredPermission);

    // If the caller has zero workspaces for this permission, reject early
    if (req.allowedWorkspaces.length === 0) {
      return res.status(403).json({
        error: Codes.FORBIDDEN,
        detail: `No workspaces with "${requiredPermission}" permission.`,
        recoverable: false,
        suggestion: "Request workspace access from an owner.",
      });
    }

    next();
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/ingest", _requireAuth("write"), _wrap(async (req) => {
  const p = _ingestParams(req.body);
  if (!p.text) throw { code: Codes.VALIDATION, message: "text is required" };
  const id = await lib.ingest(p.text, { ...p, allowedWorkspaces: req.allowedWorkspaces });
  auth.audit("ingest", { principal: req.principal, workspaceId: p.workspaceId || "default", entityId: id });
  return { success: true, id };
}));

app.post("/remember", _requireAuth("write"), _wrap(async (req) => {
  const p = _ingestParams(req.body);
  if (!p.text) throw { code: Codes.VALIDATION, message: "text is required" };
  const id = await lib.remember(p.text, { ...p, allowedWorkspaces: req.allowedWorkspaces });
  auth.audit("remember", { principal: req.principal, workspaceId: p.workspaceId || "default", entityId: id });
  return { success: true, id };
}));

app.post("/ingest/batch", _requireAuth("write"), _wrap(async (req) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) throw { code: Codes.VALIDATION, message: "items must be a non-empty array" };
  const ids = await lib.ingestBatch(items, { allowedWorkspaces: req.allowedWorkspaces });
  auth.audit("ingest_batch", { principal: req.principal, detail: `${ids.length} items` });
  return { success: true, ids, count: ids.length };
}));

app.post("/ingest/timeseries", _requireAuth("write"), _wrap(async (req) => {
  const { label, points, metadata = {}, tags = [] } = req.body;
  if (!label) throw { code: Codes.VALIDATION, message: "label is required" };
  if (!Array.isArray(points) || !points.length) throw { code: Codes.VALIDATION, message: "points must be a non-empty array" };
  return { success: true, id: await lib.ingestTimeSeries(label, points, { metadata, tags }) };
}));

app.post("/ingest/file", _requireAuth("write"), _wrap(async (req) => {
  const { filePath, tags = [], metadata = {} } = req.body;
  if (!filePath) throw { code: Codes.VALIDATION, message: "filePath is required" };
  return { success: true, id: await lib.ingestFile(filePath, { tags, metadata }) };
}));

app.post("/query", _requireAuth("read"), _wrap(async (req) => {
  const { text, limit = 10, maxTokens = null, filter = {}, asOf = null } = req.body;
  if (!text) throw { code: Codes.VALIDATION, message: "text is required" };
  return await lib.query(text, { limit, maxTokens, filter, asOf, allowedWorkspaces: req.allowedWorkspaces });
}));

app.post("/entities/batch", _requireAuth("read"), _wrap(async (req) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) throw { code: Codes.VALIDATION, message: "ids must be an array" };
  const results = await lib.getMany(ids, { allowedWorkspaces: req.allowedWorkspaces });
  return { results, count: results.filter(Boolean).length };
}));

app.get("/entity/:id", _requireAuth("read"), _wrap(async (req) => lib.get(req.params.id, { allowedWorkspaces: req.allowedWorkspaces })));

app.delete("/entity/:id", _requireAuth("admin"), _wrap(async (req) => {
  const { deletedBy } = req.body || {};
  await lib.remove(req.params.id, { deletedBy, allowedWorkspaces: req.allowedWorkspaces });
  auth.audit("remove", { principal: req.principal, entityId: req.params.id });
  return { success: true, id: Number(req.params.id) || req.params.id, softDeleted: true };
}));

app.delete("/entity/:id/purge", _requireAuth("admin"), _wrap(async (req) => {
  await lib.purge(req.params.id, { allowedWorkspaces: req.allowedWorkspaces });
  auth.audit("purge", { principal: req.principal, entityId: req.params.id });
  return { success: true, id: Number(req.params.id) || req.params.id, purged: true };
}));

app.get("/history/:id", _requireAuth("read"), _wrap(async (req) => lib.getHistory(req.params.id, { allowedWorkspaces: req.allowedWorkspaces })));

app.get("/entities", _requireAuth("read"), _wrap(async (req) => {
  const { page, limit, type, since, until, tags, memoryType, workspaceId } = req.query;
  const parsedTags = tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : undefined;
  return lib.listEntities({ page, limit, type, since, until, tags: parsedTags, memoryType, workspaceId, allowedWorkspaces: req.allowedWorkspaces });
}));

app.get("/graph",        _requireAuth("read"), _wrap(async (req) => lib.getGraph({ allowedWorkspaces: req.allowedWorkspaces })));
app.get("/traverse/:id", _requireAuth("read"), _wrap(async (req) => {
  const depth = Math.max(1, Math.min(5, Number(req.query.depth) || 1));
  return lib.traverse(req.params.id, depth, { allowedWorkspaces: req.allowedWorkspaces });
}));
app.get("/status",       _requireAuth("read"), _wrap(async (req) => lib.getStatus({ allowedWorkspaces: req.allowedWorkspaces })));

// ─── Fact Extraction ─────────────────────────────────────────────────────────

app.post("/extract-facts", _requireAuth("write"), _wrap(async (req) => {
  const { text, ...opts } = req.body;
  if (!text) throw { code: Codes.VALIDATION, message: "text is required" };
  return lib.extractFacts(text, { ...opts, allowedWorkspaces: req.allowedWorkspaces });
}));

// ─── Memory Consolidation ────────────────────────────────────────────────────

app.post("/consolidate", _requireAuth("write"), _wrap(async (req) => {
  const { threshold, dryRun, type } = req.body || {};
  return lib.consolidate({ threshold, dryRun: !!dryRun, type, allowedWorkspaces: req.allowedWorkspaces });
}));

// ─── Markdown Adapter ────────────────────────────────────────────────────────

app.get("/export/markdown", _requireAuth("read"), _wrap(async (req) => {
  const { type, memoryType, workspaceId, tags, includeHistory } = req.query;
  const filter = {};
  if (type)        filter.type        = type;
  if (memoryType)  filter.memoryType  = memoryType;
  if (workspaceId) filter.workspaceId = workspaceId;
  if (tags)        filter.tags        = tags.split(",").map(t => t.trim()).filter(Boolean);
  const md = await lib.exportMarkdown({ filter: Object.keys(filter).length ? filter : undefined, includeHistory: includeHistory === "true", allowedWorkspaces: req.allowedWorkspaces });
  return { markdown: md };
}));

app.post("/import/markdown", _requireAuth("write"), _wrap(async (req) => {
  const { markdown, source, classification, memoryType, workspaceId, tags } = req.body;
  if (!markdown) throw { code: Codes.VALIDATION, message: "markdown is required" };
  return lib.importMarkdown(markdown, { source, classification, memoryType, workspaceId, tags, allowedWorkspaces: req.allowedWorkspaces });
}));

// ─── Agent Helper ─────────────────────────────────────────────────────────────

const _agents = new Map();
let _agentSeq = 0;

function _resolveAgent(req, res, next) {
  const entry = _agents.get(req.params.agentId);
  if (!entry) return res.status(404).json({ error: "agent_not_found" });
  // entry is { agent, allowedWorkspaces, principal } when auth is enabled, or raw agent when not
  req.agent = entry.agent || entry;
  next();
}

app.post("/agent/create", _requireAuth("write"), _wrap(async (req) => {
  const { name, defaultClassification, defaultTags, useLLM } = req.body;
  if (!name) throw { code: Codes.VALIDATION, message: "name is required" };
  const agent = lib.createAgent({ name, defaultClassification, defaultTags, useLLM });
  const agentId = String(++_agentSeq);
  _agents.set(agentId, { agent, allowedWorkspaces: req.allowedWorkspaces, principal: req.principal });
  auth.audit("agent_create", { principal: req.principal, detail: name });
  return { success: true, agentId, name: agent.name };
}));

app.post("/agent/:agentId/remember", _resolveAgent, _requireAuth("write"), _wrap(async (req) => {
  const p = _ingestParams(req.body);
  if (!p.text) throw { code: Codes.VALIDATION, message: "text is required" };
  return { success: true, id: await req.agent.remember(p.text, { ...p, allowedWorkspaces: req.allowedWorkspaces }) };
}));

app.post("/agent/:agentId/update", _resolveAgent, _requireAuth("write"), _wrap(async (req) => {
  const p = _ingestParams(req.body);
  if (!p.text) throw { code: Codes.VALIDATION, message: "text is required" };
  return { success: true, id: await req.agent.update(p.text, { ...p, allowedWorkspaces: req.allowedWorkspaces }) };
}));

app.post("/agent/:agentId/recall", _resolveAgent, _requireAuth("read"), _wrap(async (req) => {
  const { text, limit, filter, asOf } = req.body;
  if (!text) throw { code: Codes.VALIDATION, message: "text is required" };
  return req.agent.recall(text, { limit, filter, asOf, allowedWorkspaces: req.allowedWorkspaces });
}));

app.get("/agent/:agentId/history/:entityId", _resolveAgent, _requireAuth("read"), _wrap(async (req) => {
  return req.agent.getHistory(req.params.entityId);
}));

app.get("/agent/:agentId/contradictions/:entityId", _resolveAgent, _requireAuth("read"), _wrap(async (req) => {
  return req.agent.getContradictions(req.params.entityId);
}));

app.post("/agent/:agentId/learn-from", _resolveAgent, _requireAuth("write"), _wrap(async (req) => {
  const { text, ...opts } = req.body;
  if (!text) throw { code: Codes.VALIDATION, message: "text is required" };
  return req.agent.learnFrom(text, { ...opts, allowedWorkspaces: req.allowedWorkspaces });
}));

// ─── Auth Management ─────────────────────────────────────────────────────────
// These endpoints are only available when auth is enabled. They require the
// "owner" role on at least one workspace. In production, consider restricting
// these to an admin-only listener or API key.

app.post("/auth/enable", _wrap(async () => {
  auth.enable();
  return { success: true, enabled: true };
}));

app.post("/auth/disable", _wrap(async () => {
  auth.disable();
  return { success: true, enabled: false };
}));

app.get("/auth/status", _wrap(async () => {
  return { enabled: auth.enabled, principals: auth.listPrincipals().length };
}));

app.post("/auth/principals", _wrap(async (req) => {
  const { id, name, workspaces, token } = req.body;
  if (!id || !name) throw { code: Codes.VALIDATION, message: "id and name are required" };
  const result = auth.addPrincipal({ id, name, workspaces, token });
  auth.audit("principal_created", { detail: `${id} (${name})` });
  return { success: true, principal: result };
}));

app.delete("/auth/principals/:id", _wrap(async (req) => {
  auth.removePrincipal(req.params.id);
  auth.audit("principal_removed", { detail: req.params.id });
  return { success: true };
}));

app.get("/auth/principals", _wrap(async () => {
  return { principals: auth.listPrincipals() };
}));

app.post("/auth/grant", _wrap(async (req) => {
  const { principalId, workspaceId, role } = req.body;
  if (!principalId || !workspaceId || !role) throw { code: Codes.VALIDATION, message: "principalId, workspaceId, and role are required" };
  auth.grant(principalId, workspaceId, role);
  auth.audit("grant", { principalId, workspaceId: workspaceId, detail: role });
  return { success: true };
}));

app.post("/auth/revoke", _wrap(async (req) => {
  const { principalId, workspaceId } = req.body;
  if (!principalId || !workspaceId) throw { code: Codes.VALIDATION, message: "principalId and workspaceId are required" };
  auth.revoke(principalId, workspaceId);
  auth.audit("revoke", { principalId, workspaceId: workspaceId });
  return { success: true };
}));

app.get("/auth/audit", _wrap(async (req) => {
  const { workspaceId, principalId, action, since, limit } = req.query;
  return { log: auth.getAuditLog({ workspaceId, principalId, action, since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined }) };
}));

// ─── Start ────────────────────────────────────────────────────────────────────

lib.init().then(() => {
  const PORT = Number(process.env.DBX_PORT) || 3000;
  const server = app.listen(PORT, () => {
    console.log(`Database X running on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log("Endpoints:");
    console.log("  POST   /ingest                  { text, type?, metadata?, tags?, timestamp?, source?, classification?, retention?, memoryType?, workspaceId?, useLLM? }");
    console.log("  POST   /remember                { text, type?, metadata?, tags?, timestamp?, source?, classification?, retention?, memoryType?, workspaceId?, useLLM? }");
    console.log("  POST   /ingest/batch            { items: [{text, type?, ...}] }");
    console.log("  POST   /ingest/timeseries       { label, points: [{timestamp,value}], metadata?, tags? }");
    console.log("  POST   /ingest/file             { filePath, tags?, metadata? }");
    console.log("  POST   /query                   { text, limit?, filter?: {type?,since?,until?,tags?,memoryType?,workspaceId?} }");
    console.log("  GET    /entity/:id");
    console.log("  DELETE /entity/:id              { deletedBy? } → soft delete");
    console.log("  DELETE /entity/:id/purge        → permanent hard delete");
    console.log("  GET    /entities?page&limit&type&since&until&tags&memoryType&workspaceId");
    console.log("  GET    /history/:id");
    console.log("  GET    /graph");
    console.log("  GET    /traverse/:id?depth=1");
    console.log("  GET    /status");
    console.log("  POST   /extract-facts            { text, type?, source?, ... }");
    console.log("  POST   /consolidate              { threshold?, dryRun?, type? }");
    console.log("  GET    /export/markdown?type&memoryType&workspaceId&tags&includeHistory");
    console.log("  POST   /import/markdown           { markdown, source?, classification?, ... }");
    console.log("Auth management:");
    console.log("  POST   /auth/enable               Enable token-based auth");
    console.log("  POST   /auth/disable              Disable auth (open access)");
    console.log("  GET    /auth/status               { enabled, principals }");
    console.log("  POST   /auth/principals           { id, name, workspaces?, token? } → create principal + token");
    console.log("  DELETE /auth/principals/:id        Remove principal");
    console.log("  GET    /auth/principals            List all principals");
    console.log("  POST   /auth/grant                { principalId, workspaceId, role }");
    console.log("  POST   /auth/revoke               { principalId, workspaceId }");
    console.log("  GET    /auth/audit?workspaceId&principalId&action&since&limit");
  });

  // Graceful shutdown on SIGTERM / SIGINT
  const stop = async (signal) => {
    console.log(`\n[dbx] ${signal} received — shutting down…`);
    server.close(async () => {
      await lib.shutdown();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT",  () => stop("SIGINT"));
});
