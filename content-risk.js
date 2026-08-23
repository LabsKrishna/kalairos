// content-risk.js — content-level adversarial signal for the trust composite
//
// Every other trust signal in trust.js is STRUCTURAL: it reasons about the
// shape of an entity's version history — who asserted it, how many distinct
// voices back it, whether anything later contradicted it, how stale it is.
// None of them ever look at what the claim actually says.
//
// That leaves a specific hole. A poisoned fact that arrives *cleanly* — first
// assertion about an entity, plausible source type, nothing yet to contradict
// it — scores base × recency and sails through at full trust. The existing
// poisoning defense is reactive: it fires once a conflicting truth shows up.
// This module makes it proactive by scoring the content itself at ingest,
// before there is anything to contradict.
//
// Design constraints (CLAUDE.md §15, §21):
//
//   - EXPLAINABLE. The verdict is a named term in the breakdown with the
//     detector and score attached, never an opaque adjustment to the scalar.
//   - MONOTONIC AND BOUNDED. Higher risk never increases trust; the penalty
//     is a multiplier floored at MIN_MULTIPLIER so a flagged fact is buried,
//     not erased.
//   - OVERRIDABLE, NOT A HARD REJECT. Classifiers produce false positives —
//     a legal agent storing "witness stated they were threatened into
//     recanting" is evidence, not an injection. A human can clear the verdict
//     (`override`), which neutralizes the penalty while PRESERVING the
//     original verdict in the provenance chain. Provenance is not strippable.
//   - OPT-IN. No detector configured → no network call, no stored field, and
//     a multiplier of exactly 1.0, so trust output is byte-identical to a
//     build without this module. The free tier takes no cloud dependency.
"use strict";

// Below this normalized risk the verdict is treated as clean: multiplier is
// exactly 1.0 and no term appears in the formula string. Without a deadband,
// a benign 0.02 from the classifier would nudge every score in the store and
// clutter every breakdown for no informational gain.
const RISK_THRESHOLD = 0.5;

// Penalty at maximum risk. 1 - 0.8 = 0.2 floor: an agent-sourced fact at base
// 0.75 lands at 0.15, well under any sane retrieval threshold, while still
// being non-zero and recoverable by human override.
const MAX_PENALTY    = 0.8;
const MIN_MULTIPLIER = 1 - MAX_PENALTY;

/**
 * Normalize a raw detector result into the stored verdict shape.
 *
 * Detectors disagree on their output format — NemoGuard JailbreakDetect
 * returns `{ jailbreak: bool, score: -1..1 }`, content-safety models return a
 * label string, a custom fn may return a plain 0..1 number. Everything is
 * normalized to a single `score` in [0, 1] where 1 is maximum risk, so
 * trust.js has exactly one shape to reason about.
 *
 * @param {number|object} raw
 * @param {{ detector?: string, now?: number }} [opts]
 * @returns {{ score, flagged, detector, at, label? } | null}
 */
function normalizeVerdict(raw, { detector = "custom", now = Date.now() } = {}) {
  if (raw == null) return null;

  let score = null;
  let label = null;

  if (typeof raw === "number") {
    score = raw;
  } else if (typeof raw === "object") {
    if (Number.isFinite(raw.risk))        score = raw.risk;
    else if (Number.isFinite(raw.score))  score = raw.score;
    // Boolean-only detector: no confidence available, so treat a positive as
    // full risk rather than silently dropping the signal.
    else if (typeof raw.flagged === "boolean")   score = raw.flagged   ? 1 : 0;
    else if (typeof raw.jailbreak === "boolean") score = raw.jailbreak ? 1 : 0;

    if (typeof raw.label === "string") label = raw.label.slice(0, 60);
    if (typeof raw.detector === "string") detector = raw.detector.slice(0, 60);
  }

  if (!Number.isFinite(score)) return null;

  const verdict = {
    score:    +Math.max(0, Math.min(1, score)).toFixed(4),
    flagged:  false,
    detector: String(detector).slice(0, 60),
    at:       now,
  };
  verdict.flagged = verdict.score >= RISK_THRESHOLD;
  if (label) verdict.label = label;
  return verdict;
}

/**
 * Trust multiplier for a stored verdict.
 *
 * Ramps linearly from 1.0 at RISK_THRESHOLD down to MIN_MULTIPLIER at score 1,
 * so the threshold is the zero point rather than a cliff. A cleared (overridden)
 * verdict returns 1.0 — the human decision wins, and the verdict stays on the
 * record for the auditor.
 *
 * @param {object|null} verdict
 * @returns {number} multiplier in [MIN_MULTIPLIER, 1]
 */
function riskMultiplier(verdict) {
  if (!verdict || !Number.isFinite(verdict.score)) return 1;
  if (verdict.override) return 1;
  if (verdict.score < RISK_THRESHOLD) return 1;
  const ramp = (verdict.score - RISK_THRESHOLD) / (1 - RISK_THRESHOLD);
  return Math.max(MIN_MULTIPLIER, 1 - MAX_PENALTY * ramp);
}

/**
 * Build a contentRiskFn backed by NVIDIA's NemoGuard JailbreakDetect NIM.
 *
 * Request/response contract (docs.nvidia.com/nim/nemoguard-jailbreakdetect):
 *   POST <baseUrl><endpoint>   { "input": "<text>" }
 *   → { "jailbreak": bool, "score": <float -1..1> }
 * where score +1 is high confidence jailbreak and -1 high confidence safe.
 * We map that to [0, 1] risk via (score + 1) / 2.
 *
 * The path differs by deployment, so baseUrl and endpoint are separate knobs:
 *
 *   hosted (default)  baseUrl "https://ai.api.nvidia.com"
 *                     endpoint "/v1/security/nvidia/nemoguard-jailbreak-detect"
 *   self-hosted NIM   baseUrl "http://0.0.0.0:8000"  endpoint "/v1/classify"
 *
 * Returns null on ANY failure — network, timeout, auth, malformed body. A
 * detector outage must never block ingest or silently downrank good memory;
 * a missing verdict means "no opinion", which yields a 1.0 multiplier.
 *
 * @param {{ apiKey?, baseUrl?, endpoint?, model?, timeoutMs?, fetchImpl? }} [opts]
 * @returns {(text: string) => Promise<object|null>}
 */
function nemoguardJailbreakFn({
  apiKey   = process.env.NVIDIA_API_KEY,
  baseUrl  = process.env.KALAIROS_JAILBREAK_URL      || "https://ai.api.nvidia.com",
  endpoint = process.env.KALAIROS_JAILBREAK_ENDPOINT || "/v1/security/nvidia/nemoguard-jailbreak-detect",
  // Some deployments (NeMo microservices nim-proxy) additionally require a
  // model name in the body. Omitted unless supplied.
  model,
  timeoutMs = Number(process.env.KALAIROS_CONTENT_RISK_TIMEOUT_MS || 4000),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("nemoguardJailbreakFn requires fetch (Node 18+) or an explicit fetchImpl");
  }

  return async function contentRiskFn(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/${String(endpoint).replace(/^\/+/, "")}`;
      const res = await fetchImpl(url, {
        method:  "POST",
        signal:  controller.signal,
        headers: {
          "content-type": "application/json",
          accept:         "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          input: String(text || "").slice(0, 5000),
          ...(model ? { model } : {}),
        }),
      });
      if (!res.ok) {
        // Surface the body on failure — a 4xx here is nearly always a wrong
        // path or a missing field, and the silent-null contract would
        // otherwise hide the one detail needed to fix it.
        let detail = "";
        try { detail = ` — ${(await res.text()).slice(0, 200)}`; } catch {}
        console.warn(`[kalairos] content-risk: HTTP ${res.status} from ${url} (non-blocking)${detail}`);
        return null;
      }
      const body = await res.json();

      // Parse STRICTLY. An unrecognised body must become "no opinion" (null),
      // never risk 0. Mapping an unparseable response to zero risk is a
      // fail-open in a security control: it marks every fact assessed-and-clean
      // while the detector is effectively disconnected, and it does so
      // silently. A 200 with the wrong shape means the endpoint contract
      // changed or we are pointed at the wrong route — both need to be loud.
      const hasScore = Number.isFinite(body?.score);
      const hasBool  = typeof body?.jailbreak === "boolean";
      if (!hasScore && !hasBool) {
        console.warn(
          `[kalairos] content-risk: unrecognised response from ${url} ` +
          `(expected { jailbreak, score }, got keys: ${Object.keys(body || {}).join(",") || "none"}) — treating as NO OPINION`
        );
        return null;
      }

      // score is -1..1 (+1 = jailbreak); fall back to the boolean when absent.
      const risk = hasScore ? (body.score + 1) / 2 : (body.jailbreak ? 1 : 0);
      return {
        risk,
        detector: "nemoguard-jailbreak-detect",
        label:    body.jailbreak ? "jailbreak" : "clean",
      };
    } catch (err) {
      console.warn(`[kalairos] content-risk check failed (non-blocking): ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  normalizeVerdict,
  riskMultiplier,
  nemoguardJailbreakFn,
  RISK_THRESHOLD,
  MAX_PENALTY,
  MIN_MULTIPLIER,
};
