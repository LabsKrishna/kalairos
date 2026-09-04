// store/entity-normalizer.js — entity shape normalization, shared module
//
// Pure functions extracted from index.js so the SQLite rebuild path
// (KAL-104+) can apply the same legacy-data defaulting and version-chain
// backfill that the in-memory hot-cache uses. Keeping a single source of
// truth here is what guarantees that "rebuild from JSONL" produces the
// same entity shape that ingest produces — no SQLite-vs-Map drift.
//
// No I/O, no module state. Inputs are mutated in place where the original
// code did so (e.g. normalizeRaw); pure helpers return new values.
"use strict";

const { synthesizeAction } = require("../versioning");

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

function defaultTrustScore(sourceType) {
  return _SOURCE_TRUST_DEFAULTS[sourceType] ?? 0.70;
}

// Canonicalizes sensitivity labels while allowing custom strings for caller-defined policies.
function normalizeClassification(input) {
  if (!input) return "internal";
  return String(input).trim().toLowerCase() || "internal";
}

// Canonicalizes retention policy. Defaults to { policy: "keep", expiresAt: null }.
function normalizeRetention(input) {
  if (!input || typeof input !== "object") return { policy: "keep", expiresAt: null };
  return {
    policy:    String(input.policy || "keep").trim().toLowerCase(),
    expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : null,
  };
}

// Canonicalizes memory type. Defaults to "long-term".
const _VALID_MEMORY_TYPES = new Set(["short-term", "long-term", "working"]);
function normalizeMemoryType(input) {
  if (!input) return "long-term";
  const v = String(input).trim().toLowerCase();
  return _VALID_MEMORY_TYPES.has(v) ? v : "long-term";
}

// Canonicalizes workspace ID. Defaults to "default".
function normalizeWorkspaceId(input) {
  if (!input) return "default";
  return String(input).trim() || "default";
}

// Deterministic versionId derived from entity id + chain length. Cheap, stable
// across reloads, and sortable when paired with the entity id.
function makeVersionId(entityId, ordinal) {
  return `${entityId}:${ordinal}`;
}

// Normalise a raw entity object (from JSONL or DB row) into a live entity.
// Mutates `raw` in-place (same as the old _loadData loop) and returns it.
function normalizeRaw(raw) {
  raw.links    = new Set(raw.links   || []);
  raw.versions = raw.versions || [];
  raw.type     = raw.type     || "text";
  raw.metadata = raw.metadata || {};
  raw.tags     = raw.tags     || [];

  const versionSource         = raw.versions.find(v => v?.source)?.source;
  const versionClassification = raw.versions.find(v => v?.classification)?.classification;
  raw.source         = raw.source || versionSource || { type: "user" };
  raw.classification = normalizeClassification(raw.classification || versionClassification);
  raw.retention      = normalizeRetention(raw.retention);

  // Preserve soft-delete fields; default to not-deleted
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    raw.deletedAt = Number(raw.deletedAt);
    raw.deletedBy = raw.deletedBy || null;
  } else {
    raw.deletedAt = null;
    raw.deletedBy = null;
  }

  // Backfill fields added in later schema versions
  raw.memoryType  = normalizeMemoryType(raw.memoryType);
  raw.workspaceId = normalizeWorkspaceId(raw.workspaceId);
  if (!Array.isArray(raw.llmKeywords)) raw.llmKeywords = raw.metadata?.llm?.keywords || [];
  if (raw.importance === undefined)    raw.importance  = null;
  if (raw.trustScore === undefined)    raw.trustScore  = defaultTrustScore(raw.source?.type || "user");
  // null = never assessed by a content detector. Distinct from a verdict of
  // score 0 ("assessed and clean"), which an auditor must be able to tell apart.
  if (raw.contentRisk === undefined)   raw.contentRisk = null;

  // Backfill per-version metadata
  for (const v of raw.versions) if (!v.source) v.source = raw.source;
  for (const v of raw.versions) {
    v.classification = normalizeClassification(v.classification || raw.classification);
    if (!Array.isArray(v.linkIds)) v.linkIds = [];
  }

  // Migrate old data: if versions are oldest-first, reverse to newest-first
  if (raw.versions.length > 1 &&
      raw.versions[0].timestamp < raw.versions[raw.versions.length - 1].timestamp) {
    raw.versions.reverse();
  }

  // Lazy back-compat: synthesise audit fields on legacy version records that
  // were written before the trail shape existed. We walk oldest-first so
  // previousVersionId chains correctly. Newly-written versions already carry
  // these fields; we only fill what's missing.
  if (raw.versions.length > 0) {
    const oldestFirst = [...raw.versions].reverse();
    let prevVersionId = null;
    for (let i = 0; i < oldestFirst.length; i++) {
      const v = oldestFirst[i];
      if (!v.versionId)         v.versionId   = makeVersionId(raw.id, i + 1);
      if (v.ingestAt == null)   v.ingestAt    = v.timestamp;
      if (v.effectiveAt == null) v.effectiveAt = v.timestamp;
      if (v.validFrom == null)  v.validFrom   = v.effectiveAt;
      if (v.validTo === undefined) {
        // Closed by the next version; latest stays open until forgotten.
        v.validTo = (i < oldestFirst.length - 1)
          ? (oldestFirst[i + 1].effectiveAt ?? oldestFirst[i + 1].timestamp)
          : null;
      }
      if (!v.previousVersionId) v.previousVersionId = prevVersionId;
      if (v.who === undefined)  v.who = null;
      if (v.why === undefined)  v.why = null;
      if (!v.action)            v.action = synthesizeAction(i, v.delta);
      prevVersionId = v.versionId;
    }
    // If the entity is soft-deleted, the latest version's validTo should be
    // closed at deletedAt rather than left open. Use an explicit null check
    // (not truthy) — deletedAt=0 is a legitimate epoch timestamp and must
    // still close the version, matching the !== null/undefined convention
    // used for deletedAt everywhere else in this function.
    if (raw.deletedAt !== null && raw.versions[0]?.validTo == null) {
      raw.versions[0].validTo = raw.deletedAt;
    }
  }

  if (!Array.isArray(raw.trailEvents)) raw.trailEvents = [];

  return raw;
}

module.exports = {
  defaultTrustScore,
  normalizeClassification,
  normalizeRetention,
  normalizeMemoryType,
  normalizeWorkspaceId,
  makeVersionId,
  normalizeRaw,
};
