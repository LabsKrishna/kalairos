// filters.js — pure query/selection helpers.
//
// Natural-language time/type filter extraction, structured entity filtering,
// and the importance heuristic. All pure: no engine state, no I/O — they take
// inputs and return values, which keeps them trivially testable and lets the
// query path in index.js stay focused on orchestration.
"use strict";

// Relative-time phrases → a lookback window in ms. First match wins, so order
// matters where phrases overlap (e.g. "last week" vs "last 2 weeks").
const TIME_RULES = [
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

const TYPE_RULES = [
  { re: /\bimages?\b|\bphotos?\b/i,       type: "image" },
  { re: /\baudios?\b|\brecordings?\b/i,   type: "audio" },
  { re: /\bvideos?\b|\bclips?\b/i,        type: "video" },
  { re: /\btime.?series\b|\bmetrics?\b/i, type: "timeseries" },
  { re: /\bdocuments?\b|\bnotes?\b/i,     type: "document" },
];

/** Extract a `{ since?, type? }` filter from a natural-language query. Pure. */
function parseNLFilters(text) {
  const filter = {}, now = Date.now();
  for (const r of TIME_RULES) {
    const m = text.match(r.re);
    if (m) { filter.since = now - r.ms(m); break; }
  }
  for (const r of TYPE_RULES) {
    if (r.re.test(text)) { filter.type = r.type; break; }
  }
  return filter;
}

/** Filter entities by type/time-window/tags/memoryType/workspace. Pure. */
function applyFilter(entities, { type, since, until, tags, memoryType, workspaceId } = {}) {
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

/**
 * Derive an importance score [0,1] for an entity. Explicit importance wins,
 * then LLM-derived, then a structural heuristic (version count + link count +
 * contradiction presence). Pure.
 */
function computeImportance(entity) {
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

module.exports = { parseNLFilters, applyFilter, computeImportance, TIME_RULES, TYPE_RULES };
