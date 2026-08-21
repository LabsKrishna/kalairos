// trust.js — Multi-signal trust aggregator
//
// Given an entity (with version history) and the current time, compute a
// composite trust score in [0, 1] and the breakdown of how we got there.
// The breakdown is what makes trust *actionable*: agents can see the math
// ("−0.24 from 2 contradictions") and reason about whether to surface a
// conflict to the user rather than silently trust a single scalar.
//
// Formula (documented in CLAUDE.md direction + design discussion):
//
//   base           = entity.trustScore ?? 0.5
//                    (stored per-entity trust, which today is source-default
//                    0.6–0.9 or an explicit annotation. 0.5 neutral only when
//                    no stored value exists, preserving legacy-data back-compat.)
//
//   corroboration  = min(0.4, 0.1 × (distinctSources − 1))
//                    Subtract 1 because the first source IS the base, not a
//                    corroboration. Cap at +0.4 (5 total sources) with
//                    diminishing returns. `distinctSources` here is the count
//                    of (type, actor) voices that support the CURRENT head
//                    claim — versions older than the most-recent contradiction
//                    corroborate the prior truth, not the new head, and are
//                    excluded. URIs without an authenticated actor do not
//                    multiply voices (see `sourceKey`).
//
//   contradiction  = Σ  −0.3 × severity(v) × sourceTrust(v)
//                    over UNRESOLVED contradictions. A contradiction is
//                    "unresolved" if no newer version has delta.type
//                    === "correction". Scaling by the contradicting source's
//                    own trust is critical — a sketchy agent contradicting a
//                    user-asserted fact shouldn't wipe out three strong
//                    corroborations at full weight.
//
//   rawTrust       = base + corroboration + contradiction
//
//   actor          = 1.0  (placeholder this release — shape is correct so
//                    breakdown callers don't break when real reputation lands)
//
//   recency        = max(0.5, exp(−LN2 × age / halfLife))
//                    Trust decays with staleness. Old unrefreshed facts are
//                    less trustworthy even if still semantically relevant.
//
//   contentRisk    = 1.0 when no detector verdict is stored, otherwise a
//                    multiplier ramping 1.0 → 0.2 as adversarial-content risk
//                    rises past threshold (see content-risk.js). This is the
//                    ONLY signal here that looks at what the claim says rather
//                    than at the shape of its history — it catches a poison
//                    that arrives cleanly, before any contradiction exists to
//                    fire the structural defenses. Neutral (1.0) unless a
//                    detector is configured, so stores without one are
//                    unaffected.
//
//   trust          = clamp(0, 1, rawTrust × actor × recency × contentRisk)
//
//   KILL SWITCH    contradiction ≤ −0.6 → trust = 0.1 regardless.
//                  A proven falsehood in history invalidates the present.
//
"use strict";

const { riskMultiplier } = require("./content-risk");

// Source-type trust defaults — single source of truth. index.js re-exports
// the _defaultTrustScore helper; keeping the table here avoids a circular
// require during trust computation.
const SOURCE_TRUST_DEFAULTS = {
  user:   0.90,
  agent:  0.75,
  tool:   0.80,
  file:   0.70,
  system: 0.60,
};

function sourceTrust(source) {
  const t = source?.type;
  return SOURCE_TRUST_DEFAULTS[t] ?? 0.70;
}

// Identity tuple for a source — two versions are independent voices iff their
// (type, actor) pair differs. URI alone is NOT part of the identity: a tool
// without an authenticated actor is one voice regardless of how many domains
// it's fronted from, because we cannot tell five tool URIs from one adversary
// cycling domains (this is the repetition-attack defense). An anonymous user
// (no actor) collapses to a single identity for the same reason.
// Render a normalized `who` tuple ({ user?, agent?, onBehalfOf?, session? })
// as a short label for the formula string. Falls back to "human" so an
// override recorded without attribution still reads sensibly.
function _whoLabel(who) {
  if (!who || typeof who !== "object") return "human";
  return who.user || who.agent || who.onBehalfOf || "human";
}

function sourceKey(source) {
  if (!source) return "||";
  return `${source.type || ""}|${source.actor || ""}`;
}

// Walk versions newest→oldest and mark each contradiction as resolved / unresolved.
// A contradiction at index i is RESOLVED if any version with index < i (i.e. newer,
// since versions are stored newest-first) has delta.type === "correction".
//
// Returns an array of { version, severity, sourceTrust, resolved } for every
// contradicting version in the history (in newest→oldest order). Non-contradicting
// versions are omitted.
function classifyContradictions(versions) {
  const out = [];
  if (!Array.isArray(versions) || versions.length === 0) return out;

  // Versions are stored newest-first. Walk in array order; track whether we've
  // seen a correction yet (that correction resolves any OLDER contradictions,
  // which have higher array indices).
  let correctionSeenAt = -1;

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const delta = v?.delta;
    if (!delta?.contradicts) {
      if (delta?.type === "correction" && correctionSeenAt < 0) correctionSeenAt = i;
      continue;
    }
    // Severity: prefer the field if present (newer data); fall back to 1.0
    // if the delta was written before severity was tracked (safer to treat
    // as full-strength contradiction than silently drop it).
    const severity = Number.isFinite(delta.contradictionSeverity)
      ? delta.contradictionSeverity
      : 1.0;

    // Resolved iff some newer version (smaller index) is a correction
    const resolved = correctionSeenAt >= 0 && correctionSeenAt < i;

    out.push({
      severity,
      sourceTrust: sourceTrust(v.source),
      resolved,
      timestamp:   v.timestamp,
      type:        delta.type,
    });
  }

  return out;
}

// Count distinct source identities that corroborate the CURRENT head claim.
//
// Versions are stored newest-first. Walking from index 0 forward, each version
// supports the head until — and including — the most recent contradicting
// version. That contradicting version introduced the head text, so its source
// IS a corroborator of head; but anything older corroborated the *prior*
// (pre-contradiction) claim and must not count here.
//
// If the history contains no contradictions, every non-contradicting source
// counts (equivalent to the original semantics for clean histories).
//
// This is the source-spoofing defense: a contradicting poison cannot inherit
// the corroboration bonus earned by the truth it overturned.
function countCorroborators(versions) {
  const seen = new Set();
  if (!Array.isArray(versions) || versions.length === 0) return 0;
  for (const v of versions) {
    seen.add(sourceKey(v.source));
    if (v?.delta?.contradicts) break; // head-introducing version; stop
  }
  return seen.size;
}

/**
 * Compute trust signals for an entity.
 *
 * @param {object} entity — stored entity with `versions`, `source`, `trustScore`,
 *                          `updatedAt`, and optionally `contentRisk` (detector verdict)
 * @param {object} opts
 * @param {number} [opts.now] — reference time for recency decay (default: Date.now())
 * @param {number} [opts.recencyHalfLifeMs] — halflife for recency decay (default: 30 days)
 * @returns {{
 *   trust: number,                   // final score in [0, 1]
 *   breakdown: {
 *     base:          number,         // starting value (stored trustScore or 0.5 legacy)
 *     corroboration: number,         // signed adjustment (+0 .. +0.4)
 *     contradiction: number,         // signed adjustment (−inf .. 0)
 *     actor:         number,         // multiplier (placeholder 1.0)
 *     recency:       number,         // multiplier (0.5 .. 1.0)
 *     contentRisk:   number,         // multiplier (0.2 .. 1.0); 1.0 = no verdict
 *     killed:        boolean,        // true if kill switch triggered
 *     sources:       number,         // distinct corroborators
 *     content:       null | {        // null when no detector ever ran
 *       score, flagged, detector, assessedAt, label, overridden, override
 *     },
 *     contradictions: {
 *       total:      number,
 *       unresolved: number,
 *       details:    Array<{ severity, sourceTrust, resolved, penalty }>,
 *     },
 *     formula: string,               // human-readable math ("0.5 + 0.2 − 0.24 ...")
 *   }
 * }}
 */
function computeTrustSignals(entity, { now = Date.now(), recencyHalfLifeMs = 30 * 86_400_000 } = {}) {
  const versions = entity?.versions || [];

  // Base: explicit stored trustScore (user-set or source-default) or 0.5 neutral
  const base = Number.isFinite(entity?.trustScore) ? entity.trustScore : 0.5;

  // Corroboration: distinct non-contradicting sources beyond the first
  const distinctSources  = Math.max(1, countCorroborators(versions));
  const corroboration    = Math.min(0.4, 0.1 * (distinctSources - 1));

  // Contradictions: sum signed penalties over unresolved ones
  const contradictions   = classifyContradictions(versions);
  let contradictionSum = 0;
  const detailed = contradictions.map(c => {
    const penalty = c.resolved ? 0 : -0.3 * c.severity * c.sourceTrust;
    contradictionSum += penalty;
    return { ...c, penalty: +penalty.toFixed(4) };
  });

  // Actor multiplier — placeholder. Real implementation (future PR) tracks a
  // rolling success rate per (source.type, source.actor) tuple; for now the
  // multiplier is neutral so the breakdown shape stays stable.
  const actor = 1.0;

  // Recency multiplier — capped at 0.5 so ancient facts still contribute
  const updatedAt = entity?.updatedAt || now;
  const ageMs     = Math.max(0, now - updatedAt);
  const recency   = Math.max(0.5, Math.exp(-Math.LN2 * ageMs / recencyHalfLifeMs));

  // Content-risk multiplier — 1.0 (no-op) unless a detector verdict was stored
  // at ingest. An overridden verdict also yields 1.0 but stays on the record.
  const riskVerdict   = entity?.contentRisk || null;
  const contentRisk   = riskMultiplier(riskVerdict);

  // Raw and final
  const rawTrust = base + corroboration + contradictionSum;
  let trust      = Math.max(0, Math.min(1, rawTrust * actor * recency * contentRisk));

  // Kill switch: weighted contradiction total past threshold wipes trust.
  // Expressed as a CAP rather than an assignment so a content-risk penalty
  // that already pushed trust below the cap is not raised back up to it.
  const killed = contradictionSum <= -0.6;
  if (killed) trust = Math.min(trust, 0.1 * contentRisk);

  // Human-readable formula string for the breakdown surface
  const formula = [
    `base ${base.toFixed(2)}`,
    corroboration > 0 ? `+${corroboration.toFixed(2)} corroboration (${distinctSources} sources)` : null,
    contradictionSum < 0 ? `${contradictionSum.toFixed(2)} contradictions` : null,
    recency < 1 ? `×${recency.toFixed(2)} recency` : null,
    contentRisk < 1
      ? `×${contentRisk.toFixed(2)} content-risk (${riskVerdict.detector}: ${riskVerdict.score.toFixed(2)})`
      : null,
    riskVerdict?.override ? `⚑ risk cleared by ${_whoLabel(riskVerdict.override.who)}` : null,
    killed ? "⚠ KILL SWITCH" : null,
  ].filter(Boolean).join(" ");

  const unresolvedCount = detailed.filter(c => !c.resolved).length;

  return {
    trust: +trust.toFixed(4),
    breakdown: {
      base:          +base.toFixed(4),
      corroboration: +corroboration.toFixed(4),
      contradiction: +contradictionSum.toFixed(4),
      actor:         +actor.toFixed(4),
      recency:       +recency.toFixed(4),
      contentRisk:   +contentRisk.toFixed(4),
      killed,
      sources:       distinctSources,
      // Present only when a detector actually ran, so callers can distinguish
      // "assessed and clean" from "never assessed" — an auditor needs that
      // difference. Carries the verdict through to the query surface.
      content: riskVerdict ? {
        score:      riskVerdict.score,
        flagged:    !!riskVerdict.flagged,
        detector:   riskVerdict.detector,
        assessedAt: riskVerdict.at,
        label:      riskVerdict.label || null,
        overridden: !!riskVerdict.override,
        override:   riskVerdict.override || null,
      } : null,
      contradictions: {
        total:      detailed.length,
        unresolved: unresolvedCount,
        details:    detailed,
      },
      formula:       `Trust ${trust.toFixed(2)} = ${formula}`,
    },
  };
}

module.exports = {
  computeTrustSignals,
  classifyContradictions,
  countCorroborators,
  sourceTrust,
  SOURCE_TRUST_DEFAULTS,
};
