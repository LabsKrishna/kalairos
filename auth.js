// auth.js — Authentication & Workspace ACL for Smriti
//
// Token-based auth with role-per-workspace ACL. When enabled, every HTTP
// request must carry a Bearer token that resolves to a principal. Each
// principal has a role per workspace: owner > admin > write > read.
// When disabled (default), everything works as before — zero friction.
"use strict";

const crypto = require("crypto");

// ─── Role Hierarchy ──────────────────────────────────────────────────────────
// Higher number = more privilege. A principal's role for a workspace must meet
// or exceed the required permission level for the operation.

const ROLES = Object.freeze({ read: 1, write: 2, admin: 3, owner: 4 });

const PERMISSIONS = Object.freeze({
  read:  1,   // query, get, getMany, list, history, graph, traverse, status, export
  write: 2,   // ingest, remember, batch, timeseries, file, extractFacts, import, consolidate
  admin: 3,   // remove, purge
  owner: 4,   // grant/revoke workspace access
});

// ─── Token hashing ────────────────────────────────────────────────────────────
// Tokens are stored as SHA-256 hashes so the backing map never holds plaintext
// credentials. The plaintext token is returned to the caller once (at creation)
// and is never persisted or re-exposed. A timing-safe compare is not needed
// here because we use the hash as a Map key (exact lookup, not string compare).

function _hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// ─── AuthStore ───────────────────────────────────────────────────────────────

class AuthStore {
  constructor() {
    this._tokens     = new Map();   // token → principalId
    this._principals = new Map();   // principalId → principal
    this._auditLog   = [];
    this._maxAudit   = 1000;
    this._enabled    = false;
  }

  // ── Enable / Disable ─────────────────────────────────────────────────────

  enable()  { this._enabled = true; }
  disable() { this._enabled = false; }
  get enabled() { return this._enabled; }

  // ── Principal Management ─────────────────────────────────────────────────

  /**
   * Register a principal and return its token.
   * @param {{ id: string, name: string, workspaces?: Record<string, string>, token?: string }} opts
   * @returns {{ id, name, workspaces, token, createdAt }}
   */
  addPrincipal({ id, name, workspaces = {}, token } = {}) {
    if (!id || !name) throw new Error("principal requires id and name");
    // Validate roles
    for (const [ws, role] of Object.entries(workspaces)) {
      if (!ROLES[role]) throw new Error(`Invalid role "${role}" for workspace "${ws}". Must be: ${Object.keys(ROLES).join(", ")}`);
    }
    const tok = token || crypto.randomBytes(32).toString("hex");
    const principal = { id, name, workspaces: { ...workspaces }, createdAt: Date.now() };
    this._principals.set(id, principal);
    this._tokens.set(_hashToken(tok), id); // store hash, never plaintext
    return { ...principal, token: tok };   // plaintext returned once to caller
  }

  /**
   * Remove a principal and all its tokens.
   */
  removePrincipal(principalId) {
    for (const [hash, pid] of this._tokens) {
      if (pid === principalId) this._tokens.delete(hash);
    }
    this._principals.delete(principalId);
  }

  /**
   * Get a principal by ID (without token).
   */
  getPrincipal(principalId) {
    return this._principals.get(principalId) || null;
  }

  /**
   * List all principals (without tokens).
   */
  listPrincipals() {
    return Array.from(this._principals.values());
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /**
   * Resolve a bearer token to a principal.
   * Returns null if the token is invalid or auth is disabled.
   */
  authenticate(token) {
    if (!this._enabled) return null;
    if (!token) return null;
    const pid = this._tokens.get(_hashToken(token));
    if (!pid) return null;
    return this._principals.get(pid) || null;
  }

  // ── Authorization ────────────────────────────────────────────────────────

  /**
   * Check whether a principal has at least `permission` for `workspaceId`.
   * When auth is disabled, returns true for everything.
   */
  authorize(principal, workspaceId, permission) {
    if (!this._enabled) return true;
    if (!principal) return false;
    const role = principal.workspaces[workspaceId];
    if (!role) return false;
    return (ROLES[role] || 0) >= (PERMISSIONS[permission] || 0);
  }

  /**
   * Return all workspace IDs a principal can access at any role.
   * Returns null when auth is disabled (meaning "unrestricted").
   */
  allowedWorkspaces(principal) {
    if (!this._enabled) return null;
    if (!principal) return [];
    return Object.keys(principal.workspaces);
  }

  /**
   * Return workspace IDs where principal has at least `permission`.
   * Returns null when auth is disabled.
   */
  workspacesWithPermission(principal, permission) {
    if (!this._enabled) return null;
    if (!principal) return [];
    const required = PERMISSIONS[permission] || 0;
    return Object.entries(principal.workspaces)
      .filter(([, role]) => (ROLES[role] || 0) >= required)
      .map(([ws]) => ws);
  }

  // ── Workspace Grants ─────────────────────────────────────────────────────

  /**
   * Grant a principal a role on a workspace.
   */
  grant(principalId, workspaceId, role) {
    const p = this._principals.get(principalId);
    if (!p) throw new Error(`Principal ${principalId} not found`);
    if (!ROLES[role]) throw new Error(`Invalid role: ${role}. Must be: ${Object.keys(ROLES).join(", ")}`);
    p.workspaces[workspaceId] = role;
  }

  /**
   * Revoke a principal's access to a workspace.
   */
  revoke(principalId, workspaceId) {
    const p = this._principals.get(principalId);
    if (!p) return;
    delete p.workspaces[workspaceId];
  }

  // ── Audit Log ────────────────────────────────────────────────────────────

  /**
   * Append an audit entry. Returns the entry for chaining.
   */
  audit(action, { principal, workspaceId, entityId, detail } = {}) {
    const entry = {
      timestamp:     Date.now(),
      action,
      principalId:   principal?.id || null,
      principalName: principal?.name || null,
      workspaceId:   workspaceId || null,
      entityId:      entityId || null,
      detail:        detail || null,
    };
    this._auditLog.push(entry);
    if (this._auditLog.length > this._maxAudit) this._auditLog.shift();
    return entry;
  }

  /**
   * Query the audit log with optional filters.
   */
  getAuditLog({ workspaceId, principalId, action, since, limit = 100 } = {}) {
    let log = this._auditLog;
    if (workspaceId) log = log.filter(e => e.workspaceId === workspaceId);
    if (principalId) log = log.filter(e => e.principalId === principalId);
    if (action)      log = log.filter(e => e.action === action);
    if (since)       log = log.filter(e => e.timestamp >= since);
    return log.slice(-limit);
  }

  // ── Serialization ────────────────────────────────────────────────────────

  toJSON() {
    return {
      principals: Array.from(this._principals.values()),
      // Persist the already-hashed values — plaintext tokens are never stored.
      tokens: Array.from(this._tokens.entries()).map(([hash, pid]) => ({ hash, principalId: pid })),
    };
  }

  load(data) {
    if (!data) return;
    if (Array.isArray(data.principals)) {
      for (const p of data.principals) {
        if (p.id) this._principals.set(p.id, p);
      }
    }
    if (Array.isArray(data.tokens)) {
      for (const entry of data.tokens) {
        const { principalId } = entry;
        // Support both new format { hash } and legacy format { token }.
        // Legacy plaintext tokens are re-hashed on load.
        const raw  = entry.hash || entry.token;
        const hash = /^[0-9a-f]{64}$/.test(raw) ? raw : _hashToken(raw);
        if (hash && principalId) this._tokens.set(hash, principalId);
      }
    }
  }
}

module.exports = { AuthStore, ROLES, PERMISSIONS };
