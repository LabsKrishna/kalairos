// bench/prior-auth/replay.js — load cases on one clock, capture what each
// reviewer saw at decision time, replay it later, and score the difference.
//
// Every write from every case, plus the payer policy library, goes into the
// engine in RECEIPT order (ingestAt), exactly as a live system would see it.
// When the clock reaches a case's decision, the harness captures
// queryAt(decisionAt) right then — before any later record exists — and
// freezes a checkpoint. After the whole stream has landed (late faxes,
// reversals, corrections, policy revisions), it asks the same questions
// again and compares.
//
// Cases live in their own workspace so a revision can only merge within its
// own case. Cross-case identity is a separate open problem (stable keys);
// this harness measures time, not identity, and fails loudly if identity
// goes wrong rather than letting it skew a time metric.
"use strict";

const lib = require("../..");
const F   = require("./fixtures");

const QUERY        = "prior authorization case record";
const POLICY_QUERY = "medical policy coverage criteria";
const DIM          = 64;

// Bag-of-words over alphabetic tokens — the same deterministic embedder the
// poisoning and latency benches use. No network, no model download.
function makeEmbedder(dim = DIM) {
  const vocab = new Map();
  return async (text) => {
    const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
    const vec = new Array(dim).fill(0);
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
      vec[vocab.get(w) % dim]++;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };
}

async function initEngine() {
  await lib.shutdown().catch(() => {});
  await lib.init({
    embedFn:      makeEmbedder(),
    embeddingDim: DIM,
    dataFile:     ":memory:",
    // Return every record in scope. Retrieval relevance is not under test
    // here; a relevance miss must never be able to pass as a time-travel hit.
    minFinalScore:    0,
    minSemanticScore: 0,
    // Revisions of the same record (a reversed determination, a corrected
    // report) must merge; first writes use forceNew, so these thresholds only
    // govern revisions. The identity check below proves each one landed.
    versionThreshold:       0.70,
    consolidationThreshold: 0.65,
  });
}

// The engine narrates every write on stderr. Mute that chatter while a few
// thousand writes stream in; anything else still gets through.
function muteEngineLog() {
  const original = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[kalairos]")) return;
    original(...args);
  };
  return () => { console.error = original; };
}

const snapshot = (res) => res.results.map(r => ({
  id:     r.id,
  text:   r.text,
  trust:  r.trust,
  source: r.source,
  // When each contradiction the trust explanation cites was recorded.
  contradictionTimes: (r.trustBreakdown?.contradictions?.details || []).map(d => d.timestamp),
}));

const checkpointName = (c) => `determination:${c.id}`;

/**
 * Stream every write in receipt order, capturing each case at its decision.
 * @returns {{ entityIds: Map, live: Map, identityMisses: object[] }}
 */
async function load(cases) {
  const items = [];
  for (const w of F.policyWrites()) {
    items.push({ at: w.ingestAt, rank: 0, ws: F.POLICY_WS, w });
  }
  for (const c of cases) {
    const ws = F.caseWorkspace(c.id);
    for (const w of c.writes) items.push({ at: w.ingestAt, rank: 0, ws, w, c });
    // rank 1: a write stamped at the decision instant (the determination
    // itself) lands before the capture.
    items.push({ at: c.decisionAt, rank: 1, ws, c, decision: true });
  }
  items.sort((a, b) => (a.at - b.at) || (a.rank - b.rank));

  const entityIds      = new Map(); // `${ws}|${key}` → entity id
  const live           = new Map(); // case id → decision-time snapshot
  const identityMisses = [];

  for (const it of items) {
    if (it.decision) {
      const res = await lib.queryAt(QUERY, it.c.decisionAt, { allowedWorkspaces: [it.ws], limit: 100 });
      live.set(it.c.id, snapshot(res));
      await lib.checkpoint(checkpointName(it.c), {
        workspace: it.ws,
        why:       `Decision-time record for ${it.c.id}`,
      });
      continue;
    }

    const { w, ws } = it;
    const k     = `${ws}|${w.key}`;
    const first = !entityIds.has(k);
    const id = await lib.ingest(w.text, {
      timestamp:   w.ingestAt,
      effectiveAt: w.effectiveAt,
      source:      w.source,
      who:         w.who,
      why:         w.why,
      tags:        w.tags || (it.c ? [`case:${it.c.id}`] : []),
      workspaceId: ws,
      forceNew:    first,
    });
    if (first) entityIds.set(k, id);
    else if (entityIds.get(k) !== id) {
      identityMisses.push({ workspace: ws, key: w.key, expected: entityIds.get(k), got: id, text: w.text });
    }
  }
  return { entityIds, live, identityMisses };
}

/** Ask every question again, after the whole stream has landed. */
async function observe(c) {
  const scope = { allowedWorkspaces: [F.caseWorkspace(c.id)], limit: 100 };
  return {
    replayKnown: snapshot(await lib.queryAt(QUERY, c.decisionAt, scope)),
    replayTrue:  snapshot(await lib.queryValidAt(QUERY, c.decisionAt, scope)),
    naive:       snapshot(await lib.query(QUERY, scope)),
    criteria:    snapshot(await lib.queryValidAt(POLICY_QUERY, c.requestAt, {
      allowedWorkspaces: [F.POLICY_WS],
      filter: { tags: [`policy:${c.policy}`] },
      limit: 10,
    })),
    frozen: await lib.trail({ checkpoint: checkpointName(c), limit: 1000 }),
  };
}

/**
 * Score one case against its ground truth. Pure: takes the case, the
 * decision-time capture, the later observations, and the key → entity id map.
 */
function scoreCase(c, live, obs, entityIds) {
  const D       = c.decisionAt;
  const ws      = F.caseWorkspace(c.id);
  const records = F.recordsOf(c.writes);
  const byText  = new Map(c.writes.map(w => [w.text, w]));
  const textsOf = (rows) => new Set(rows.map(r => r.text));

  // What the reviewer could have had, and what was actually true, at D.
  const known = [], truth = [], late = [];
  for (const versions of records.values()) {
    const k = F.knownAt(versions, D);
    const t = F.trueAt(versions, D);
    if (k) known.push(k);
    if (t) {
      truth.push(t);
      if (t.ingestAt > D) late.push(t);
    }
  }

  // 1. Hindsight leakage: anything in the day-D replay received after day D,
  //    or not part of this case at all.
  const leaked = obs.replayKnown.filter(r => {
    const w = byText.get(r.text);
    return !w || w.ingestAt > D;
  }).map(r => r.text);

  // 2. Decision-time recall: everything the reviewer had is still there.
  const replayKnownTexts = textsOf(obs.replayKnown);
  const knownFound = known.filter(w => replayKnownTexts.has(w.text)).length;

  // 3. Replay drift: the day-D answer, asked later, matches the answer given
  //    on day D.
  const key       = (r) => `${r.id}|${r.text}`;
  const liveKeys  = new Set(live.map(key));
  const laterKeys = new Set(obs.replayKnown.map(key));
  const drift = liveKeys.size !== laterKeys.size || [...liveKeys].some(k => !laterKeys.has(k));

  // Trust hindsight (reported, not gated): same records, same day — is the
  // trust the same, and does its explanation cite only what existed by then?
  const liveTrust = new Map(live.map(r => [r.id, r.trust]));
  let trustDelta = 0;
  for (const r of obs.replayKnown) {
    if (liveTrust.has(r.id)) trustDelta = Math.max(trustDelta, Math.abs(r.trust - liveTrust.get(r.id)));
  }
  const trustCitesLater = obs.replayKnown.some(r => r.contradictionTimes.some(t => t > D));

  // 4–6. Event time: everything true at D, including what arrived late, and
  //      nothing that only became true afterwards.
  const replayTrueTexts = textsOf(obs.replayTrue);
  const truthFound = truth.filter(w => replayTrueTexts.has(w.text)).length;
  const lateFound  = late.filter(w => replayTrueTexts.has(w.text)).length;
  const forward = obs.replayTrue.filter(r => {
    const w = byText.get(r.text);
    return !w || w.effectiveAt > D;
  }).map(r => r.text);

  // 7. Criteria in force on the request date, not the latest revision.
  const policy = F.policyInForce(c.policy, c.requestAt);
  const criteriaOk = obs.criteria.length === 1 && obs.criteria[0].text === policy.text;

  // 8. Frozen determination record: exactly the writes received by D.
  const expectedEvents = new Set(
    c.writes.filter(w => w.ingestAt <= D).map(w => `${entityIds.get(`${ws}|${w.key}`)}@${w.ingestAt}`)
  );
  const frozenEvents = new Set(obs.frozen.map(ev => `${ev.entityId}@${ev.ingestAt}`));
  const frozenOk = expectedEvents.size === frozenEvents.size &&
    [...expectedEvents].every(e => frozenEvents.has(e));

  // 9. Authorship: the replay still says the assistant recommended and a
  //    named clinician decided.
  const bySourceText = new Map(obs.replayKnown.map(r => [r.text, r.source]));
  const aiWrite  = F.knownAt(records.get("ai-recommendation"), D);
  const detWrite = F.knownAt(records.get("determination"), D);
  const aiSrc    = bySourceText.get(aiWrite.text);
  const detSrc   = bySourceText.get(detWrite.text);
  const authorshipOk = !!aiSrc && aiSrc.type === "agent" &&
    !!detSrc && detSrc.type === "user" && detSrc.actor === detWrite.source.actor;

  // Control: the same review asked of current state (query(), no time
  // travel). Every case with a post-decision write MUST show leakage here, or
  // the leakage metric above cannot see leaks at all.
  const hasLaterWrites = c.writes.some(w => w.ingestAt > D);
  const naiveLeaked = obs.naive.some(r => {
    const w = byText.get(r.text);
    return !w || w.ingestAt > D;
  });

  // Coverage: which hard paths this case actually exercised.
  const firstSeen = new Set();
  let revisedAfter = 0;
  for (const w of [...c.writes].sort((a, b) => a.ingestAt - b.ingestAt)) {
    if (firstSeen.has(w.key) && w.ingestAt > D) revisedAfter++;
    firstSeen.add(w.key);
  }
  const policyVersions = F.policyWrites().filter(w => w.key === c.policy);
  const policyRevised  = F.knownAt(policyVersions, c.reviewAt).text !== policy.text;

  return {
    id: c.id,
    revisedAfter, policyRevised,
    leaked, knownExpected: known.length, knownFound,
    drift, trustDelta: +trustDelta.toFixed(4), trustCitesLater,
    truthExpected: truth.length, truthFound,
    lateExpected: late.length, lateFound,
    forward,
    criteriaOk, criteriaReturned: obs.criteria.map(r => r.text),
    frozenOk, frozenExpected: expectedEvents.size, frozenGot: frozenEvents.size,
    authorshipOk,
    hasLaterWrites, naiveLeaked,
  };
}

/** Roll per-case scores up into the published metrics. */
function summarize(scores) {
  const n     = scores.length;
  const rate  = (pred) => +(scores.filter(pred).length / n).toFixed(4);
  const ratio = (num, den) => {
    const d = scores.reduce((s, x) => s + x[den], 0);
    return d === 0 ? 1 : +(scores.reduce((s, x) => s + x[num], 0) / d).toFixed(4);
  };
  const withLater = scores.filter(s => s.hasLaterWrites);

  return {
    cases: n,
    hindsightLeakage:    rate(s => s.leaked.length > 0),
    decisionTimeRecall:  ratio("knownFound", "knownExpected"),
    replayDrift:         rate(s => s.drift),
    eventTimeRecall:     ratio("truthFound", "truthExpected"),
    lateEvidenceRecall:  ratio("lateFound", "lateExpected"),
    lateEvidenceRecords: scores.reduce((s, x) => s + x.lateExpected, 0),
    forwardLeakage:      rate(s => s.forward.length > 0),
    criteriaInForce:     rate(s => s.criteriaOk),
    frozenRecord:        rate(s => s.frozenOk),
    authorshipPreserved: rate(s => s.authorshipOk),
    trustDrift:          rate(s => s.trustDelta > 1e-9),
    trustDriftMax:       Math.max(0, ...scores.map(s => s.trustDelta)),
    trustCitesLater:     rate(s => s.trustCitesLater),
    controlCases:        withLater.length,
    controlDetection:    withLater.length
      ? +(withLater.filter(s => s.naiveLeaked).length / withLater.length).toFixed(4)
      : 0,
    coverage: {
      lateRecords:          scores.filter(s => s.lateExpected > 0).length,
      revisedAfterDecision: scores.filter(s => s.revisedAfter > 0).length,
      policyRevisedByReview: scores.filter(s => s.policyRevised).length,
    },
  };
}

// Published floors. Every gated metric is exact: on synthetic cases with known
// ground truth, anything short of the floor is a bug, not a tuning knob.
const FLOORS = [
  { metric: "hindsightLeakage",    op: "<=", value: 0, label: "Hindsight leakage" },
  { metric: "decisionTimeRecall",  op: ">=", value: 1, label: "Decision-time recall" },
  { metric: "replayDrift",         op: "<=", value: 0, label: "Replay drift" },
  { metric: "eventTimeRecall",     op: ">=", value: 1, label: "Event-time recall" },
  { metric: "lateEvidenceRecall",  op: ">=", value: 1, label: "Late-evidence recall" },
  { metric: "forwardLeakage",      op: "<=", value: 0, label: "Forward leakage" },
  { metric: "criteriaInForce",     op: ">=", value: 1, label: "Criteria in force" },
  { metric: "frozenRecord",        op: ">=", value: 1, label: "Frozen determination record" },
  { metric: "authorshipPreserved", op: ">=", value: 1, label: "Authorship preserved" },
  { metric: "controlDetection",    op: ">=", value: 1, label: "Control: leak detection" },
];

function checkFloors(summary) {
  return FLOORS.map(f => {
    const v  = summary[f.metric];
    const ok = f.op === "<=" ? v <= f.value : v >= f.value;
    return { ...f, actual: v, ok };
  });
}

/** Full run: load, capture, replay, score. Leaves the engine shut down. */
async function runReplay(cases) {
  const unmute = muteEngineLog();
  try {
    await initEngine();
    const { entityIds, live, identityMisses } = await load(cases);
    const scores = [];
    for (const c of cases) {
      const obs = await observe(c);
      scores.push(scoreCase(c, live.get(c.id), obs, entityIds));
    }
    return { scores, summary: summarize(scores), identityMisses };
  } finally {
    await lib.shutdown().catch(() => {});
    unmute();
  }
}

module.exports = {
  QUERY, POLICY_QUERY, FLOORS,
  initEngine, muteEngineLog, load, observe, scoreCase, summarize, checkFloors, runReplay,
  checkpointName,
};
