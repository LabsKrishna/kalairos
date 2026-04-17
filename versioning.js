// versioning.js — Intelligent Delta Engine for Smriti

const { cosine } = require("./kernel");

// Tokenize text into meaningful terms (words, numbers, symbols)
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[\w$.,%]+/g) || [];
}

// Spelled-out numbers that indicate a value change (e.g. "fifty dollars" → "sixty dollars")
const WORD_NUMBERS = new Set([
  "zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen",
  "twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety",
  "hundred","thousand","million","billion","half","quarter",
]);

// Negation words whose addition or removal flips the assertion of a fact.
// Contractions are normalised (can't → cant, won't → wont) before lookup.
const NEGATIONS = new Set([
  "not","no","never","neither","nor","cannot","cant","wont","dont",
  "doesnt","didnt","isnt","wasnt","arent","werent","hasnt","havent","hadnt",
  "shouldnt","wouldnt","couldnt","mustnt","false","incorrect","wrong","invalid",
  "impossible","denied","rejected","failed","prohibited","forbidden",
]);

// Check if a term looks numeric/value-like (prices, dates, quantities, or spelled-out numbers)
function isNumericTerm(term) {
  return /[\d$%,.]/.test(term) || WORD_NUMBERS.has(term);
}

// Check if a term is a negation word (normalises contractions before lookup)
function isNegation(term) {
  return NEGATIONS.has(term.replace(/['']/g, "").toLowerCase());
}

// Compute added and removed terms between old and new text
function diffTerms(oldText, newText) {
  const oldTokens = new Set(tokenize(oldText));
  const newTokens = new Set(tokenize(newText));

  const added   = [...newTokens].filter(t => !oldTokens.has(t));
  const removed = [...oldTokens].filter(t => !newTokens.has(t));

  return { added, removed };
}

// Classify the type of change based on semantic shift + term changes
function detectDeltaType(semanticShift, addedTerms, removedTerms) {
  const allChanged       = [...addedTerms, ...removedTerms];
  const hasNumericChange = allChanged.some(isNumericTerm);
  const hasConceptChange = allChanged.some(t => !isNumericTerm(t));

  if (semanticShift < 0.05) {
    if (hasNumericChange && !hasConceptChange) return "update";     // $200 → $210
    if (hasConceptChange)                      return "correction"; // fixed a fact
    return "patch";                                                 // tiny wording fix
  }

  if (semanticShift < 0.15) {
    if (hasNumericChange) return "update";   // value + some context changed
    return "addition";                       // new concepts introduced
  }

  return "drift"; // significant meaning shift
}

// Generate a human-readable summary
function buildSummary(type, addedTerms, removedTerms, semanticShift) {
  const shift = (semanticShift * 100).toFixed(1);

  switch (type) {
    case "update":
      if (removedTerms.length && addedTerms.length) {
        return `Value changed: [${removedTerms.slice(0, 3).join(", ")}] → [${addedTerms.slice(0, 3).join(", ")}]`;
      }
      return `Numeric or value update detected (${shift}% semantic shift)`;

    case "correction":
      return `Factual correction: ${removedTerms.slice(0, 2).join(", ")} replaced with ${addedTerms.slice(0, 2).join(", ")}`;

    case "addition":
      return `New information added: ${addedTerms.slice(0, 3).join(", ")} (${shift}% semantic shift)`;

    case "drift":
      return `Significant meaning change detected (${shift}% semantic shift)`;

    case "patch":
      return "Minor wording adjustment, meaning unchanged";

    default:
      return "Content updated";
  }
}

// Contradiction detector — flags updates where any of the following hold:
//
// 1. Numeric value flip: a numeric/value term was both removed and added
//    (e.g. "$50" → "$60", "3pm" → "4pm"). Signals a factual correction.
//
// 2. Negation flip: a negation word (not, no, cannot, …) was added or removed,
//    flipping the polarity of the assertion (e.g. "is ready" → "is not ready").
//    This catches factual reversals that have no numeric terms.
//
// 3. High-drift concept change: delta type is "drift" AND semanticShift > 0.25.
//    A very large shift with entirely different terms is almost always a topic flip.
//
// Note: "drift" type changes are intentionally included for cases 2 and 3 so that
// changes that are semantically massive but contain negation are still flagged.
function detectContradiction(type, addedTerms, removedTerms, semanticShift) {
  // 1. Numeric value flip
  if (type === "update" || type === "correction") {
    const removedNumeric = removedTerms.some(isNumericTerm);
    const addedNumeric   = addedTerms.some(isNumericTerm);
    if (removedNumeric && addedNumeric) return true;
  }

  // 2. Negation flip — works across all delta types
  const addedNegation   = addedTerms.some(isNegation);
  const removedNegation = removedTerms.some(isNegation);
  if (addedNegation !== removedNegation) return true;

  // 3. High-drift topic change
  if (type === "drift" && semanticShift > 0.25) return true;

  return false;
}

// Main — builds a full intelligent delta between two versions
function buildDelta(oldText, oldVector, newText, newVector) {
  const similarity    = cosine(oldVector, newVector);
  const semanticShift = Number((1 - similarity).toFixed(4));

  const { added, removed } = diffTerms(oldText, newText);
  const type        = detectDeltaType(semanticShift, added, removed);
  const summary     = buildSummary(type, added, removed, semanticShift);
  const contradicts = detectContradiction(type, added, removed, semanticShift);

  return {
    type,
    semanticShift,
    addedTerms:   added.slice(0, 20),
    removedTerms: removed.slice(0, 20),
    summary,
    contradicts,
  };
}

// ─── Changelog ────────────────────────────────────────────────────────────────

/**
 * Build a human-readable changelog from a version history array.
 * Expects oldest-first ordering (same order as getHistory() returns).
 *
 * @param {object[]} versions — array of version objects (oldest first)
 * @returns {object[]} changelog entries in chronological order
 */
function buildChangelog(versions) {
  return versions.map((v, i) => ({
    version:       i + 1,
    date:          new Date(v.timestamp).toISOString(),
    deltaType:     v.delta?.type  || (i === 0 ? "created" : "updated"),
    summary:       v.delta?.summary || (i === 0 ? "Initial version" : "Content updated"),
    contradicts:   v.delta?.contradicts  || false,
    semanticShift: v.delta?.semanticShift || 0,
    source:        v.source || null,
  }));
}

// ─── Drift Analysis ───────────────────────────────────────────────────────────

/**
 * Measure semantic drift across an entity's version history.
 * Expects oldest-first ordering (same order as getHistory() returns).
 *
 * @param {object[]} versions — array of version objects (oldest first)
 * @returns {{ totalDrift, averageDrift, trend, steps }}
 *   - totalDrift:   cumulative sum of all per-step semantic shifts
 *   - averageDrift: mean shift per version step
 *   - trend:        "stable" (<5%), "evolving" (<15%), "drifting" (≥15%)
 *   - steps:        per-step breakdown
 */
function measureDrift(versions) {
  if (versions.length < 2) {
    return { totalDrift: 0, averageDrift: 0, trend: "stable", steps: [] };
  }

  const steps = [];
  let totalDrift = 0;

  for (let i = 1; i < versions.length; i++) {
    const shift = Number(versions[i].delta?.semanticShift || 0);
    steps.push({ fromVersion: i, toVersion: i + 1, drift: +shift.toFixed(4) });
    totalDrift += shift;
  }

  const averageDrift = totalDrift / steps.length;
  const trend = averageDrift < 0.05 ? "stable"
              : averageDrift < 0.15 ? "evolving"
              :                       "drifting";

  return {
    totalDrift:   +totalDrift.toFixed(4),
    averageDrift: +averageDrift.toFixed(4),
    trend,
    steps,
  };
}

module.exports = { buildDelta, buildChangelog, measureDrift };
