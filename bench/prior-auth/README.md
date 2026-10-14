# Prior-authorization replay benchmark

When a prior-authorization decision is challenged (an appeal, an audit, a state regulator sampling AI-assisted denials), the review asks about a past moment. Two of its questions sound alike and are not:

- **What did the reviewer have when they decided?** Answered by `queryAt(decisionAt)`. Nothing received after the decision may appear.
- **What was actually true at that moment?** Answered by `queryValidAt(decisionAt)`. Records that existed but arrived late must appear; anything that became true later must not.

The gap between the two answers is the substance of the review: evidence the reviewer never had, as opposed to evidence the reviewer had and overrode. This benchmark measures whether Kalairos answers both without hindsight, plus three things the same review asks about: the payer policy in force on the request date, an intact decision-day record, and who decided.

All data is synthetic. No real patients, clinicians, payers or policy text.

## Run it

```bash
npm run bench:prior-auth              # reference case + 300 generated cases, seed 114
node bench/prior-auth/run.js --cases 1000 --seed 7
node bench/prior-auth/case.js         # the reference case, narrated
```

Output is printed as a table and written to `bench/prior-auth/results.json`. The runner exits non-zero on any floor miss.

## Workload

**Reference case PA-0001** (`fixtures.js`, narrated by `case.js`). A lumbar microdiscectomy request is denied on day 2 because the MRI that satisfies policy MP-114 has not arrived. The scan was done a week before the request; the report is faxed in on day 4, and the medical director reverses on day 5. The policy is revised (six weeks of conservative therapy → twelve) after the request. On day 30 a review asks why the request was denied.

**Generated cases.** Seeded (mulberry32), across three payer policies, each revised at least once during 2026. Each case has a request, two to four clinical records, an AI recommendation, and a clinician determination. Probabilities are set so every hard path is common, not to model real approval rates:

| Shape | Rate | Why it matters |
|---|---|---|
| Record arrives after the decision | 35% per record | Must be absent from `queryAt`, present in `queryValidAt` |
| Clinician overrides the assistant at decision time | 10% | Authorship must survive the replay |
| Denial reversed after the late record lands | 70% of eligible | A later version of a known record |
| Record corrected after the decision, same event time | 25% | Event time must show the correction, ingest time must not |
| Event that only becomes true after the decision | 50% | Must not leak backwards on either axis |

Every write carries two clocks: `ingestAt` (when the payer received it) and `effectiveAt` (when it was true). The harness streams all writes from all cases, plus the policy library, in receipt order. When the clock reaches a case's decision, it captures `queryAt(decisionAt)` live and freezes a checkpoint. After the whole stream has landed, it asks every question again.

## Metrics and floors

Ground truth comes from the domain rule in `fixtures.js` (`knownAt`, `trueAt`), not from engine code. Retrieval relevance is switched off (`minFinalScore: 0`, `minSemanticScore: 0`) so a relevance miss can never pass as a time-travel result.

| Metric | Floor | What fails it |
|---|---|---|
| Hindsight leakage | 0 | Any record, or later version of a record, in the decision-day replay that was received after the decision |
| Decision-time recall | 1.0 | A record the reviewer had is missing from the replay |
| Replay drift | 0 | The replay, asked after later writes, differs from what was returned on the decision day |
| Event-time recall | 1.0 | A record true at the decision is missing from `queryValidAt` |
| Late-evidence recall | 1.0 | The same, restricted to records that arrived after the decision |
| Forward leakage | 0 | `queryValidAt` returns something that only became true after the decision |
| Criteria in force | 1.0 | The policy returned for the request date is not the version in force then |
| Frozen determination record | 1.0 | The decision-time checkpoint gained or lost events |
| Authorship preserved | 1.0 | The replay no longer shows an agent recommendation and a named clinician determination |
| Control: leak detection | 1.0 | Asking current state (`query()`) instead of `queryAt` failed to register leakage in a case that has post-decision writes |

Every floor is exact. On synthetic cases with known ground truth, a miss is a bug, not a tuning knob. The control row proves the leakage metric can see a leak: the wrong call must leak in every case where leaking is possible. `tests/test-prior-auth-replay.js` (part of `npm test`) injects each failure above into a real run and asserts the scorer catches it.

## Current result

Reference case + 300 generated cases, seed 114, 2026-10-14: **every floor met.** 242 cases had a record arrive after the decision (382 records), 126 had a record revised after the decision, 52 had their policy revised between request and review.

## Known gap: trust is not point-in-time

Reported, not gated:

| Metric | Result | Meaning |
|---|---|---|
| Trust drift | 0.40 of cases, max Δ 0.27 | A replayed record's trust differs from what it was on the decision day |
| Trust cites later | 0.30 of cases | The replayed trust explanation cites a contradiction recorded after the decision |

Record content in a replay is exact. Trust is not: `computeTrustSignals` scores an entity against its full version history, so a reversal recorded on day 5 lowers the trust a day-2 replay reports, and the explanation names it. In the reference case the determination reads 0.90 on the decision day and 0.63 when replayed for the same day. For a regulated review this is hindsight in the provenance payload. The fix is point-in-time trust for `queryAt` (score only versions received by `asOf`); when it lands, both rows should reach 0 and become gated.

## What this is not

- **Not a retrieval-quality benchmark.** Relevance floors are off; every record in scope is returned. Recall of the right record for a natural-language question is measured elsewhere (`bench/agent-memory/`, `bench/longmemeval/`).
- **Not a test of identity across cases.** Each case is its own workspace, so a revision can only merge within its case. Matching records by a stable key (case id, member id) instead of text similarity is an open engine gap; the runner fails as a fixture error if any revision lands on the wrong record, so identity can't skew a time metric.
- **Not the full bitemporal question.** No single call answers "on the decision day, which policy did we believe was in force on the request date?" when a retroactive policy correction arrives later. The generated policies have no retroactive corrections, so the criteria metric stays well-defined. That query is a gap, not a pass.
- **Not runtime replay.** Phase 4.4's replay determinism (re-running an agent and reproducing its state) is a different benchmark. This one covers the memory layer only.
- **Not real clinical data, and not a competitor comparison.** It reports Kalairos's own numbers on a reproducible synthetic workload.
