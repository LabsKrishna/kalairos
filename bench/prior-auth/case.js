// bench/prior-auth/case.js — the reference case, narrated.
//
// One synthetic prior-authorization request, denied on day 2 because the MRI
// that met the policy had not arrived yet. It lands on day 4 and the denial is
// reversed. On day 30 a regulator's review asks why it was denied.
//
// The review's questions, and the call that answers each:
//
//   1. What did the reviewer have on the decision day?   queryAt
//   2. What was actually true on that day?               queryValidAt
//   3. Which policy governed the request?                queryValidAt (policy)
//   4. Was the AI the only basis for the denial?         provenance on results
//   5. Is the decision-day record intact?                frozen checkpoint
//
// Exits non-zero if any answer is wrong, so it doubles as a check.
//
// Usage: node bench/prior-auth/case.js
"use strict";

const lib = require("../..");
const F   = require("./fixtures");
const R   = require("./replay");

const C  = F.REFERENCE_CASE;
const ws = F.caseWorkspace(C.id);

const when  = (t) => new Date(t).toISOString().replace(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d).*/, (_, m, d, hm) =>
  `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m]} ${d} ${hm}`);
const day   = (t) => when(t).slice(0, 6);
const short = (s, n = 74) => {
  const body = s.replace(/^Case PA-\d+ /, "");
  return body.length > n ? body.slice(0, n - 1) + "…" : body;
};

let failures = 0;
function check(ok, what) {
  if (!ok) { failures++; console.log(`     ✗ ${what}`); }
}

(async () => {
  // Engine chatter goes to stderr; the narration is on stdout.
  R.muteEngineLog();
  await R.initEngine();
  const { live } = await R.load([C]);
  const D     = C.decisionAt;
  const scope = { allowedWorkspaces: [ws], limit: 100 };
  const byText = new Map(C.writes.map(w => [w.text, w]));

  console.log("");
  console.log("═".repeat(78));
  console.log(`  PRIOR AUTHORIZATION ${C.id} — a denial, replayed ${Math.round((C.reviewAt - D) / F.DAY)} days later`);
  console.log("═".repeat(78));
  console.log("");
  console.log("  As the payer received it:");
  const timeline = [...C.writes, ...F.policyWrites().filter(w => w.key === C.policy && w.ingestAt > C.requestAt)]
    .sort((a, b) => a.ingestAt - b.ingestAt);
  let markedDecision = false;
  for (const w of timeline) {
    if (!markedDecision && w.ingestAt > D) {
      console.log(`  ${"─".repeat(14)} decision made ${"─".repeat(48)}`);
      markedDecision = true;
    }
    const lag = w.ingestAt - w.effectiveAt;
    const note = w.role === "policy"
      ? `   (in force from ${day(w.effectiveAt)})`
      : lag > F.DAY ? `   (true since ${day(w.effectiveAt)})` : "";
    console.log(`  ${when(w.ingestAt)}  ${short(w.text, 64)}${note}`);
  }

  console.log("");
  console.log(`  ${day(C.reviewAt)}: the review asks five questions.`);

  // ── 1. What did the reviewer have? ─────────────────────────────────────────
  const had = (await lib.queryAt(R.QUERY, D, scope)).results;
  console.log("");
  console.log(`  1. What did the reviewer have at ${when(D)}?      queryAt`);
  for (const r of had) console.log(`     · ${short(r.text)}`);
  check(had.every(r => byText.get(r.text)?.ingestAt <= D), "a record received after the decision appears in the replay");
  check(!had.some(r => /MRI/.test(r.text)), "the MRI appears, but it arrived after the decision");
  check(had.some(r => /denied/.test(r.text)) && !had.some(r => /reconsideration/.test(r.text)),
    "the replay shows the reversal instead of the denial");
  const liveKeys = new Set(live.get(C.id).map(r => `${r.id}|${r.text}`));
  check(had.length === liveKeys.size && had.every(r => liveKeys.has(`${r.id}|${r.text}`)),
    "the replay differs from what was returned on the decision day");
  const liveTrust = new Map(live.get(C.id).map(r => [r.id, r.trust]));
  const hadDet    = had.find(r => /determination/.test(r.text));
  console.log(`     Trust on the determination: ${liveTrust.get(hadDet?.id)} on the decision day, ${hadDet?.trust} replayed.`);
  check(had.every(r => r.trust === liveTrust.get(r.id)), "a replayed trust differs from the decision day");
  check(!had.some(r => (r.trustBreakdown?.contradictions?.details || []).some(d => d.timestamp > D)),
    "a trust explanation cites a contradiction recorded after the decision");

  // ── 2. What was true? ──────────────────────────────────────────────────────
  const wasTrue = (await lib.queryValidAt(R.QUERY, D, scope)).results;
  const hadTexts = new Set(had.map(r => r.text));
  const gap = wasTrue.filter(r => !hadTexts.has(r.text));
  console.log("");
  console.log(`  2. What was actually true at ${when(D)}?          queryValidAt`);
  console.log(`     The same ${had.length} records, plus what existed but had not arrived:`);
  for (const r of gap) {
    const w = byText.get(r.text);
    console.log(`     + ${short(r.text)}`);
    console.log(`       true since ${day(w.effectiveAt)}, received ${day(w.ingestAt)}`);
  }
  check(gap.length === 1 && /MRI/.test(gap[0].text), "the MRI should be the one record true but not yet received");
  check(!wasTrue.some(r => /scheduling/.test(r.text)), "a record that became true after the decision leaked backwards");

  // ── 3. Which policy governed the request? ─────────────────────────────────
  const policyScope = { allowedWorkspaces: [F.POLICY_WS], filter: { tags: [`policy:${C.policy}`] }, limit: 10 };
  const inForce = (await lib.queryValidAt(R.POLICY_QUERY, C.requestAt, policyScope)).results;
  const current = (await lib.query(R.POLICY_QUERY, policyScope)).results;
  const weeks = (s) => (s.match(/at least (\w+) weeks/) || [])[1];
  console.log("");
  console.log(`  3. Which policy governed the request on ${day(C.requestAt)}?    queryValidAt on ${C.policy}`);
  console.log(`     ${weeks(inForce[0]?.text || "")} weeks of conservative therapy (in force on the request date)`);
  console.log(`     Current policy says ${weeks(current[0]?.text || "")} weeks; it took effect after the request.`);
  check(inForce.length === 1 && weeks(inForce[0].text) === "six", "wrong policy version for the request date");
  check(weeks(current[0]?.text || "") === "twelve", "expected the current policy to be the later revision");

  // ── 4. Was the AI the only basis? ─────────────────────────────────────────
  const ai  = had.find(r => /recommendation/.test(r.text));
  const det = had.find(r => /determination/.test(r.text));
  const detWrite = byText.get(det?.text || "");
  console.log("");
  console.log("  4. Was the AI the only basis for the denial?      provenance on each result");
  console.log(`     Recommendation: ${ai?.source?.type} "${ai?.source?.actor}"`);
  console.log(`     Determination:  ${det?.source?.type} "${det?.source?.actor}", why: "${detWrite?.why}"`);
  check(ai?.source?.type === "agent", "the recommendation lost its agent authorship");
  check(det?.source?.type === "user" && det?.source?.actor === "dr-reyes", "the determination lost its clinician authorship");

  // ── 5. Is the decision-day record intact? ─────────────────────────────────
  const frozen = await lib.trail({ checkpoint: R.checkpointName(C), limit: 1000 });
  const now    = await lib.trail({ workspace: ws, limit: 1000 });
  console.log("");
  console.log("  5. Is the decision-day record intact?              frozen checkpoint");
  console.log(`     ${frozen.length} events frozen at the decision; the case holds ${now.length} events today.`);
  console.log(`     Frozen: ${frozen.map(ev => ev.action).join(", ")}`);
  console.log(`     Since:  ${now.filter(ev => ev.ingestAt > D).map(ev => ev.action).join(", ")}`);
  const expectedFrozen = C.writes.filter(w => w.ingestAt <= D).length;
  check(frozen.length === expectedFrozen && frozen.every(ev => ev.ingestAt <= D),
    "the frozen record gained or lost events after the decision");

  await lib.shutdown().catch(() => {});
  console.log("");
  if (failures) {
    console.log(`  ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("  All five answers correct.");
  console.log("");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
