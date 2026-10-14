// bench/prior-auth/fixtures.js — synthetic prior-authorization cases.
//
// Everything here is invented: members, clinicians, imaging centers, policy
// numbers. No real patient data, no real payer policy text.
//
// A case is a list of WRITES. Each write has two clocks:
//
//   ingestAt     — when the payer's system received it (a fax lands, a
//                  reviewer signs). This is what a reviewer could have seen.
//   effectiveAt  — when it was true in the world (the MRI was performed, the
//                  therapy ended). Records routinely arrive days after this.
//
// Writes that share a `key` within a case are versions of ONE record: the
// first creates it, later ones revise it (a reconsidered determination, a
// corrected report). The runner checks every revision landed on its own
// record, so a fixture that silently forks or cross-merges fails loudly
// instead of skewing the numbers.
//
// The ground-truth helpers at the bottom are written from the domain rule,
// not from engine code, so the benchmark cannot pass by agreeing with itself.
"use strict";

const HOUR = 3_600_000;
const DAY  = 24 * HOUR;
const at   = (iso) => Date.parse(iso);

const POLICY_WS = "payer-policy";

// ─── Payer medical policy library ───────────────────────────────────────────
// One record per policy; each revision is a new version of that record.
// Revisions are published ahead of their effective date, the usual pattern,
// which is exactly where "latest known" and "in force" part ways.

const POLICY_LIBRARY = [
  {
    id: "MP-114",
    procedure: "lumbar microdiscectomy",
    template: (n) =>
      `Medical policy MP-114, lumbar discectomy: covered when spine imaging confirms nerve root compression ` +
      `and the member has completed at least ${n} weeks of conservative therapy, unless a progressive ` +
      `neurological deficit is documented.`,
    versions: [
      { n: "six",    ingestAt: at("2025-12-15T12:00:00Z"), effectiveAt: at("2026-01-01T00:00:00Z") },
      { n: "twelve", ingestAt: at("2026-03-10T12:00:00Z"), effectiveAt: at("2026-03-15T00:00:00Z") },
    ],
  },
  {
    id: "MP-207",
    procedure: "knee arthroscopy with partial meniscectomy",
    template: (n) =>
      `Medical policy MP-207, knee arthroscopy: covered when a meniscal tear causes locking or catching of ` +
      `the knee and ${n} weeks of supervised physical therapy have failed.`,
    versions: [
      { n: "four",  ingestAt: at("2025-12-10T12:00:00Z"), effectiveAt: at("2026-01-01T00:00:00Z") },
      { n: "six",   ingestAt: at("2026-03-25T12:00:00Z"), effectiveAt: at("2026-04-01T00:00:00Z") },
      { n: "eight", ingestAt: at("2026-08-20T12:00:00Z"), effectiveAt: at("2026-09-01T00:00:00Z") },
    ],
  },
  {
    id: "MP-310",
    procedure: "upper airway surgery for obstructive sleep apnea",
    template: (n) =>
      `Medical policy MP-310, sleep apnea surgery: covered when a sleep study shows moderate or severe ` +
      `obstructive apnea and the patient could not tolerate positive airway pressure for ${n} months.`,
    versions: [
      { n: "three", ingestAt: at("2025-12-01T12:00:00Z"), effectiveAt: at("2026-01-01T00:00:00Z") },
      { n: "six",   ingestAt: at("2026-06-25T12:00:00Z"), effectiveAt: at("2026-07-01T00:00:00Z") },
    ],
  },
];

const POLICY_SOURCE = { type: "file", actor: "payer-policy-library" };

/** Policy library as writes, in the same shape as case writes. */
function policyWrites() {
  const out = [];
  for (const p of POLICY_LIBRARY) {
    for (const v of p.versions) {
      out.push({
        key:         p.id,
        role:        "policy",
        text:        p.template(v.n),
        ingestAt:    v.ingestAt,
        effectiveAt: v.effectiveAt,
        source:      POLICY_SOURCE,
        who:         { agent: "policy-sync" },
        tags:        [`policy:${p.id}`],
      });
    }
  }
  return out;
}

// ─── Reference case PA-0001 ─────────────────────────────────────────────────
// The worked example (see case.js for the narrated walkthrough).
//
//   Feb 25  MRI performed — shows the compression the policy requires
//   Mar  2  request filed with primary care + physical therapy records
//   Mar  3  AI recommends deny (no imaging in the record); medical director denies
//   Mar  5  MRI report arrives by fax, eight days after the scan
//   Mar  6  medical director reverses on reconsideration
//   Mar 10  policy MP-114 revised (six → twelve weeks), effective Mar 15
//   Mar 21  surgery scheduled
//   Apr  1  a regulator's review asks why this was denied on Mar 3

const REF = "PA-0001";
const FAX = { type: "file", actor: "fax-intake" };

const REFERENCE_CASE = {
  id:         REF,
  policy:     "MP-114",
  requestAt:  at("2026-03-02T09:00:00Z"),
  decisionAt: at("2026-03-03T14:00:00Z"),
  reviewAt:   at("2026-04-01T10:00:00Z"),
  writes: [
    {
      key: "request", role: "request",
      text: `Case ${REF} prior authorization request: lumbar microdiscectomy at L5-S1 for member M-4471, ` +
            `submitted by Dr. Okafor, orthopedic spine surgery, for left leg radicular pain.`,
      ingestAt: at("2026-03-02T09:00:00Z"), effectiveAt: at("2026-03-02T09:00:00Z"),
      source: { type: "tool", actor: "provider-portal", uri: `portal://requests/${REF}` },
      who: { agent: "intake" },
    },
    {
      key: "primary-care", role: "evidence",
      text: `Case ${REF} primary care visit: anti-inflammatory medication and activity modification for ` +
            `left leg radicular pain, symptoms persisting.`,
      ingestAt: at("2026-03-02T09:05:00Z"), effectiveAt: at("2026-01-12T15:30:00Z"),
      source: { ...FAX, uri: "fax://riverside-family-medicine/0112" },
      who: { agent: "intake" },
    },
    {
      key: "physical-therapy", role: "evidence",
      text: `Case ${REF} physical therapy discharge summary: eight weeks of supervised therapy completed ` +
            `without relief of radicular leg pain.`,
      ingestAt: at("2026-03-02T09:10:00Z"), effectiveAt: at("2026-02-20T17:00:00Z"),
      source: { ...FAX, uri: "fax://northside-physical-therapy/0220" },
      who: { agent: "intake" },
    },
    {
      key: "ai-recommendation", role: "recommendation",
      text: `Case ${REF} utilization review recommendation: deny. Conservative therapy requirement met, ` +
            `but required spine imaging is not in the submitted record.`,
      ingestAt: at("2026-03-03T11:00:00Z"), effectiveAt: at("2026-03-03T11:00:00Z"),
      source: { type: "agent", actor: "um-assistant" },
      who: { agent: "um-assistant" },
    },
    {
      key: "determination", role: "determination",
      text: `Case ${REF} determination by medical director Dr. Reyes: denied, required spine imaging ` +
            `is not in the record.`,
      ingestAt: at("2026-03-03T14:00:00Z"), effectiveAt: at("2026-03-03T14:00:00Z"),
      source: { type: "user", actor: "dr-reyes" },
      who: { user: "dr-reyes" },
      why: "Reviewed the AI recommendation and the submitted record; MP-114 imaging requirement not met.",
    },
    {
      key: "imaging", role: "evidence",
      text: `Case ${REF} lumbar MRI report: L5-S1 disc herniation compressing the left S1 nerve root.`,
      ingestAt: at("2026-03-05T16:20:00Z"), effectiveAt: at("2026-02-25T10:00:00Z"),
      source: { ...FAX, uri: "fax://valley-imaging/0225" },
      who: { agent: "intake" },
    },
    {
      key: "determination", role: "determination",
      text: `Case ${REF} determination by medical director Dr. Reyes: approved on reconsideration, ` +
            `required spine imaging is now in the record.`,
      ingestAt: at("2026-03-06T10:00:00Z"), effectiveAt: at("2026-03-06T10:00:00Z"),
      source: { type: "user", actor: "dr-reyes" },
      who: { user: "dr-reyes" },
      why: "MRI received Mar 5 confirms nerve root compression; MP-114 criteria met.",
    },
    {
      key: "follow-up", role: "evidence",
      text: `Case ${REF} surgical scheduling confirmation: microdiscectomy booked with Dr. Okafor.`,
      ingestAt: at("2026-03-21T09:00:00Z"), effectiveAt: at("2026-03-20T16:00:00Z"),
      source: { type: "tool", actor: "provider-portal", uri: `portal://scheduling/${REF}` },
      who: { agent: "intake" },
    },
  ],
};

// ─── Generator ──────────────────────────────────────────────────────────────
// Seeded so every run builds the same cases. Probabilities are chosen to make
// every interesting shape common (late records, reversals, corrections,
// post-decision events, criteria revisions mid-case), not to model real
// approval rates.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Evidence templates per policy. `required` marks the record the policy
// cannot be met without; when it arrives late, the case is denied for it.
const EVIDENCE = {
  "MP-114": [
    { key: "primary-care", label: "primary care record",
      text: (id, r) => `Case ${id} primary care visit: anti-inflammatory medication and activity modification for ${r.pick(["left", "right"])} leg radicular pain, symptoms persisting.` },
    { key: "physical-therapy", label: "physical therapy summary",
      text: (id, r) => `Case ${id} physical therapy discharge summary: ${r.pick(["seven", "eight", "ten"])} weeks of supervised therapy completed without relief of radicular leg pain.` },
    { key: "imaging", label: "spine imaging", required: true,
      text: (id, r) => `Case ${id} lumbar MRI report: ${r.pick(["L4-L5", "L5-S1"])} disc herniation compressing the ${r.pick(["left", "right"])} nerve root.`,
      corrected: (id, r) => `Case ${id} corrected lumbar MRI report: ${r.pick(["L3-L4", "L4-L5"])} disc herniation compressing the ${r.pick(["left", "right"])} nerve root, level revised on second read.` },
    { key: "neurology", label: "neurology consult",
      text: (id, r) => `Case ${id} neurology consult: ${r.pick(["strength and reflexes intact", "mild ankle weakness, stable over two visits"])}.` },
  ],
  "MP-207": [
    { key: "orthopedic", label: "orthopedic visit",
      text: (id, r) => `Case ${id} orthopedic visit: ${r.pick(["left", "right"])} knee locking and catching after a twisting injury.` },
    { key: "physical-therapy", label: "physical therapy report", required: true,
      text: (id, r) => `Case ${id} physical therapy progress report: ${r.pick(["five", "six", "nine"])} weeks of supervised knee therapy with persistent mechanical symptoms.`,
      corrected: (id, r) => `Case ${id} corrected physical therapy progress report: ${r.pick(["three", "four"])} weeks of supervised knee therapy with persistent mechanical symptoms, attendance log reconciled.` },
    { key: "imaging", label: "knee imaging",
      text: (id, r) => `Case ${id} knee MRI report: complex tear of the ${r.pick(["medial", "lateral"])} meniscus posterior horn.` },
  ],
  "MP-310": [
    { key: "sleep-study", label: "sleep study", required: true,
      text: (id, r) => `Case ${id} sleep study report: apnea hypopnea index in the ${r.pick(["moderate", "severe"])} range with oxygen desaturation.`,
      corrected: (id, r) => `Case ${id} corrected sleep study report: apnea hypopnea index in the ${r.pick(["mild", "moderate"])} range after manual rescoring of the recording.` },
    { key: "sleep-medicine", label: "sleep medicine visit",
      text: (id, r) => `Case ${id} sleep medicine visit: positive airway pressure stopped after ${r.pick(["four", "five", "seven"])} months because of mask intolerance.` },
    { key: "ent-exam", label: "ear nose and throat exam",
      text: (id, r) => `Case ${id} ear nose and throat exam: enlarged tonsils and a narrow airway at the soft palate.` },
  ],
};

const SURGEONS  = ["Okafor", "Lindqvist", "Haddad", "Moreau", "Tanaka", "Ivanova"];
const REVIEWERS = ["Reyes", "Achebe", "Kowalski", "Brennan"];

const YEAR_START = at("2026-01-05T09:00:00Z");
const YEAR_SPAN  = at("2026-11-15T09:00:00Z") - YEAR_START;

/**
 * Build `n` cases from `seed`. Case ids start at PA-1001 so they never clash
 * with the reference case.
 * @returns {object[]} cases, each { id, policy, requestAt, decisionAt, reviewAt, writes }
 */
function generateCases(n, seed = 114) {
  const rand = mulberry32(seed);
  const r = {
    float: () => rand(),
    int:   (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick:  (arr) => arr[Math.floor(rand() * arr.length)],
    p:     (prob) => rand() < prob,
  };

  const cases = [];
  for (let i = 0; i < n; i++) {
    const id       = `PA-${1001 + i}`;
    const policy   = r.pick(POLICY_LIBRARY);
    const surgeon  = r.pick(SURGEONS);
    const reviewer = r.pick(REVIEWERS);
    const member   = `M-${r.int(1000, 9999)}`;

    const requestAt  = YEAR_START + Math.floor(r.float() * YEAR_SPAN);
    const decisionAt = requestAt + r.int(1, 3) * DAY + r.int(1, 6) * HOUR;
    const reviewAt   = decisionAt + 30 * DAY;

    const writes = [];
    const fax = (key) => ({ type: "file", actor: "fax-intake", uri: `fax://${id.toLowerCase()}/${key}` });

    writes.push({
      key: "request", role: "request",
      text: `Case ${id} prior authorization request: ${policy.procedure} for member ${member}, submitted by Dr. ${surgeon}.`,
      ingestAt: requestAt, effectiveAt: requestAt,
      source: { type: "tool", actor: "provider-portal", uri: `portal://requests/${id}` },
      who: { agent: "intake" },
    });

    // Clinical records: true weeks before the request; most arrive with it,
    // some arrive after the decision (the fax that came in late).
    const lateRequired = [];
    const evidence = [];
    for (const tmpl of EVIDENCE[policy.id]) {
      const effectiveAt = requestAt - r.int(3, 90) * DAY - r.int(0, 8) * HOUR;
      const late        = r.p(0.35);
      const ingestAt    = late
        ? decisionAt + r.int(1, 10 * 24) * HOUR
        : requestAt + r.int(0, Math.max(0, Math.floor((decisionAt - requestAt) / HOUR) - 2)) * HOUR + r.int(1, 50) * 60_000;
      const w = {
        key: tmpl.key, role: "evidence",
        text: tmpl.text(id, r),
        ingestAt, effectiveAt,
        source: fax(tmpl.key),
        who: { agent: "intake" },
      };
      writes.push(w);
      evidence.push({ tmpl, write: w, late });
      if (late && tmpl.required) lateRequired.push(tmpl);
    }

    // AI recommendation, then the clinician's determination at decisionAt.
    // Usually the clinician concurs; sometimes they override the assistant
    // at decision time — the human-in-the-loop the state laws require.
    const missing   = lateRequired[0] || null;
    const aiDenies  = !!missing;
    const overrideAtDecision = r.p(0.1);
    const denied    = overrideAtDecision ? !aiDenies : aiDenies;
    const reason    = missing
      ? `required ${missing.label} is not in the submitted record`
      : `submitted record meets policy ${policy.id}`;

    const issuedAt = decisionAt - r.int(1, 5) * HOUR;
    writes.push({
      key: "ai-recommendation", role: "recommendation",
      text: `Case ${id} utilization review recommendation: ${aiDenies ? "deny" : "approve"}. ${reason[0].toUpperCase()}${reason.slice(1)}.`,
      ingestAt: issuedAt, effectiveAt: issuedAt,
      source: { type: "agent", actor: "um-assistant" },
      who: { agent: "um-assistant" },
    });

    const determinationText = (verdict, why) =>
      `Case ${id} determination by medical director Dr. ${reviewer}: ${verdict}, ${why}.`;
    writes.push({
      key: "determination", role: "determination",
      text: denied
        ? determinationText("denied", missing ? `required ${missing.label} is not in the record` : `clinical findings do not meet policy ${policy.id}`)
        : determinationText("approved", overrideAtDecision && aiDenies ? `clinical findings meet policy ${policy.id} despite the assistant recommendation` : `record meets policy ${policy.id}`),
      ingestAt: decisionAt, effectiveAt: decisionAt,
      source: { type: "user", actor: `dr-${reviewer.toLowerCase()}` },
      who: { user: `dr-${reviewer.toLowerCase()}` },
      why: overrideAtDecision ? "Medical director overrode the assistant recommendation." : "Concurred with the assistant recommendation.",
    });

    // Reconsideration: a denial for a missing record is reversed once it lands.
    if (denied && missing && r.p(0.7)) {
      const lastLate = Math.max(...evidence.filter(e => e.late).map(e => e.write.ingestAt));
      const t = lastLate + r.int(2, 30) * HOUR;
      writes.push({
        key: "determination", role: "determination",
        text: determinationText("approved on reconsideration", `required ${missing.label} is now in the record`),
        ingestAt: t, effectiveAt: t,
        source: { type: "user", actor: `dr-${reviewer.toLowerCase()}` },
        who: { user: `dr-${reviewer.toLowerCase()}` },
        why: `${missing.label[0].toUpperCase()}${missing.label.slice(1)} received after the decision.`,
      });
    }

    // Correction: a record is amended after the decision. The amendment is
    // about the original event, so it keeps the original effectiveAt.
    const correctable = evidence.filter(e => e.tmpl.corrected);
    if (correctable.length && r.p(0.25)) {
      const target = correctable[0];
      writes.push({
        key: target.tmpl.key, role: "evidence",
        text: target.tmpl.corrected(id, r),
        ingestAt: Math.max(decisionAt, target.write.ingestAt) + r.int(1, 15) * DAY,
        effectiveAt: target.write.effectiveAt,
        source: target.write.source,
        who: { agent: "intake" },
        why: "Source amended the record after the determination.",
      });
    }

    // Something that only becomes true after the decision.
    if (r.p(0.5)) {
      const effectiveAt = decisionAt + r.int(2, 20) * DAY;
      writes.push({
        key: "follow-up", role: "evidence",
        text: `Case ${id} post-decision follow-up visit with Dr. ${surgeon}: ${r.pick(["symptoms unchanged", "procedure scheduled", "member requested a second opinion"])}.`,
        ingestAt: effectiveAt + r.int(1, 48) * HOUR, effectiveAt,
        source: { type: "tool", actor: "provider-portal", uri: `portal://visits/${id}` },
        who: { agent: "intake" },
      });
    }

    cases.push({ id, policy: policy.id, requestAt, decisionAt, reviewAt, writes });
  }
  return cases;
}

// ─── Ground truth (domain rule, independent of engine code) ────────────────

/** Group a case's writes into records: key → versions in ingest order. */
function recordsOf(writes) {
  const byKey = new Map();
  for (const w of [...writes].sort((a, b) => a.ingestAt - b.ingestAt)) {
    if (!byKey.has(w.key)) byKey.set(w.key, []);
    byKey.get(w.key).push(w);
  }
  return byKey;
}

/** What a reviewer could have seen at `t`: the latest version received by then. */
function knownAt(versions, t) {
  let found = null;
  for (const v of versions) if (v.ingestAt <= t) found = v;
  return found;
}

/**
 * What was true at `t`: the version with the latest effectiveAt at or before
 * `t`. A correction to the same event (same effectiveAt, later receipt)
 * replaces what it corrects.
 */
function trueAt(versions, t) {
  let found = null;
  for (const v of versions) {
    if (v.effectiveAt > t) continue;
    if (!found || v.effectiveAt > found.effectiveAt ||
        (v.effectiveAt === found.effectiveAt && v.ingestAt > found.ingestAt)) {
      found = v;
    }
  }
  return found;
}

/** The policy text in force at `t` for `policyId`. */
function policyInForce(policyId, t) {
  const versions = policyWrites().filter(w => w.key === policyId);
  return trueAt(versions, t);
}

module.exports = {
  HOUR, DAY, POLICY_WS, POLICY_LIBRARY, REFERENCE_CASE,
  policyWrites, generateCases, recordsOf, knownAt, trueAt, policyInForce,
  caseWorkspace: (id) => `case:${id}`,
};
