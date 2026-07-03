// trail.js — read-side observability projection + checkpoint filtering.
//
// The trail is Kalairos's headline observability surface (§11.7, §17): a
// read-only projection of every memory mutation. This module is intentionally
// PURE — it shapes entity/version objects into trail events and filters event
// lists. All stateful orchestration (init guard, the write lock, the
// checkpoints Map, persistence) stays in index.js. Where a filter needs to
// reach back into the store (tags/workspace), the caller injects a lookup, so
// these functions never touch engine singletons and stay trivially testable.
"use strict";

const { emitError, Err } = require("./errors");

/**
 * Snapshot one content version into a trail-event projection. Pure.
 * @returns {object} trail event
 */
function versionToTrailEvent(entity, v) {
  return {
    entityId:          entity.id,
    versionId:         v.versionId,
    action:            v.action,
    who:               v.who || null,
    why:               v.why ?? null,
    effectiveAt:       v.effectiveAt ?? v.timestamp,
    ingestAt:          v.ingestAt    ?? v.timestamp,
    previousVersionId: v.previousVersionId || null,
    source:            v.source || entity.source || { type: "user" },
    contentChanged:    true,
    deltaSummary:      v.delta?.summary || null,
    classification:    v.classification || entity.classification || "internal",
  };
}

/**
 * Collect every trail event for a single entity, oldest-first within the
 * entity: content versions projected to events, then metadata-only trail
 * events. Pure — the caller is responsible for any workspace-allowed gating.
 * @returns {object[]} trail events
 */
function collectTrailEvents(entity) {
  const out = [];
  // Content versions → events (oldest-first within the entity)
  const versionsOldestFirst = [...(entity.versions || [])].reverse();
  for (const v of versionsOldestFirst) {
    out.push(versionToTrailEvent(entity, v));
  }
  // Metadata-only trail events (oldest-first)
  const trailOldestFirst = [...(entity.trailEvents || [])].reverse();
  for (const ev of trailOldestFirst) out.push({ ...ev });
  return out;
}

/** True when an event's `who` matches the filter's `who`. Pure. */
function matchesWho(eventWho, filterWho) {
  if (!filterWho) return true;
  if (!eventWho) return false;
  if (filterWho.agent && eventWho.agent !== filterWho.agent) return false;
  if (filterWho.user  && eventWho.user  !== filterWho.user)  return false;
  return true;
}

/**
 * Normalize checkpoint options into a stored filter shape. Pure — timestamp
 * coercion is injected so this module reuses index.js's single normalizer
 * (no duplicate parsing logic).
 * @param {object} opts — { during?, entity?, tags?, workspace?, action? }
 * @param {(value:any, fieldName:string) => number|null} normalizeTimestamp
 * @returns {object} filter
 */
function normalizeCheckpointFilter(opts, normalizeTimestamp) {
  const filter = {};
  if (opts.during) {
    if (!Array.isArray(opts.during) || opts.during.length !== 2) {
      throw emitError(Err.validation("checkpoint.during must be a [from, to] pair"));
    }
    filter.during = [
      normalizeTimestamp(opts.during[0], "checkpoint.during[0]"),
      normalizeTimestamp(opts.during[1], "checkpoint.during[1]"),
    ];
  }
  if (opts.entity != null) {
    filter.entity = Array.isArray(opts.entity)
      ? opts.entity.map(x => Number(x) || x)
      : [Number(opts.entity) || opts.entity];
  }
  if (Array.isArray(opts.tags) && opts.tags.length) {
    filter.tags = opts.tags.map(String);
  }
  if (opts.workspace) filter.workspace = String(opts.workspace);
  if (opts.action) {
    filter.action = Array.isArray(opts.action) ? opts.action.map(String) : [String(opts.action)];
  }
  return filter;
}

/**
 * Apply a stored checkpoint filter to a list of trail events. Pure — the
 * tags/workspace branches need the owning entity, so the caller injects an
 * `entityById` lookup rather than this module holding a store reference.
 * @param {object[]} events
 * @param {object} filter
 * @param {(id:any) => object|undefined} [entityById]
 * @returns {object[]} filtered events
 */
function applyCheckpointFilter(events, filter, entityById = () => undefined) {
  let out = events;
  if (filter.during) {
    const [from, to] = filter.during;
    out = out.filter(ev => ev.ingestAt >= from && ev.ingestAt <= to);
  }
  if (filter.entity) {
    const ids = new Set(filter.entity);
    out = out.filter(ev => ids.has(ev.entityId));
  }
  if (filter.action) {
    const actions = new Set(filter.action);
    out = out.filter(ev => actions.has(ev.action));
  }
  if (filter.tags) {
    const wanted = new Set(filter.tags);
    out = out.filter(ev => {
      const ent = entityById(ev.entityId);
      if (!ent) return false;
      return (ent.tags || []).some(t => wanted.has(t));
    });
  }
  if (filter.workspace) {
    out = out.filter(ev => {
      const ent = entityById(ev.entityId);
      return ent && (ent.workspaceId || "default") === filter.workspace;
    });
  }
  return out;
}

module.exports = {
  versionToTrailEvent,
  collectTrailEvents,
  matchesWho,
  normalizeCheckpointFilter,
  applyCheckpointFilter,
};
