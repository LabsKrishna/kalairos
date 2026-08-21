# Ownership Layer — Spec

**Status:** Proposed
**Date:** 2026-08-17
**Repo:** engine (public) — E-series. Free tier per §22.

---

## 1. What this is

A first-class `ownership` entity type answering one question:

> **Who is in charge of scope X, right now — and how sure are we?**

Plus the corollary that makes it shippable while nearly empty:

> **Which ownership questions came back empty, how often, and for whom?**

The second half is the deliverable. An unanswered query is a demand signal; the
ranked list of them is the first artifact worth showing anyone.

## 2. Why the engine already fits

| Requirement | Existing mechanism |
|---|---|
| Handover is not a contradiction | `seriesSupersession` in `buildDelta` (`versioning.js:148`), gated at `index.js:889` |
| "Who owned this in March" | `effectiveAt` / `validFrom` / `validTo` on every version record (`index.js:276`) |
| Time-travel read | `queryAt(text, timestamp)` |
| Staleness | `computeTrustSignals` recency decay (`trust.js:196-198`) |
| Provenance on every answer | `source` + `who` + `why` per version |
| Audit of who-knew-what-when | `getHistory` + `trail()` (`trail.js`) |

Nothing here requires new storage, a new index, or an LLM in the hot path (§11.6).

## 3. Data model

An ownership fact is an entity with `type: "ownership"`.

```js
{
  type: "ownership",
  text: "Operation A in us-west is owned by priya@ (approver)",  // embedded form
  metadata: {
    scope:     "operation-a",     // required — the thing being owned
    region:    "us-west",         // optional — null means global
    holder:    "priya@corp.com",  // required — person or team id
    authority: "approver",        // "owner" | "approver" | "escalation" | "dri"
    confirmedAt: 1755300000000,   // last human confirmation, null if never
  },
  source: { type: "user", actor: "dev@corp.com" },  // who asserted it
}
```

**Identity key is `(scope, region, authority)`.** A new holder for the same key
supersedes rather than duplicating — this is the merge decision that makes the
version trail meaningful, and the reason the type must be wired into the
supersession branch.

`authority` is separate from `holder` on purpose. "Who runs the Phoenix program"
and "who approves a route change in Phoenix" are different questions with
different answers, and conflating them is exactly the Confluence failure.

## 4. Work items

### Slice 1 — minimum shippable (≈ 3d)

| ID | Item | Est. | Notes |
|---|---|---|---|
| **E2** | Add `ownership` to the supersession type set at `index.js:889` | 0.25d | Extend `isSeriesType` → a named `_supersedingType(type)` helper. Mirror `tests/test-series-supersession.js` |
| **E3** | `assertOwnership({ scope, region, holder, authority, effectiveAt, source, who, why })` | 0.5d | Builds canonical text + metadata, delegates to `ingest()`. Merge scan keyed on `(scope, region, authority)` **within workspace** — E1's isolation fix is load-bearing here |
| **E4** | `whoOwns(scope, { region, authority, asOf })` | 0.75d | Resolves via metadata key, not semantic search. Returns holder, `effectiveAt`, age, source chain, `confirmedAt`, trust breakdown — or a structured miss |
| **E5** | Gap log — every `whoOwns` miss appends a record | 0.5d | Append-only JSONL via the existing durable-append path (`store/file-store.js:125`) |
| **E6** | `ownershipGaps({ during, minCount })` → ranked report | 0.5d | Aggregate by `(scope, region, authority)`; count distinct askers and spread in days |
| **E9** | MCP tools: `kalairos_who_owns`, `kalairos_assert_ownership`, `kalairos_ownership_gaps` | 0.5d | Makes it usable from Claude Code / Cursor with **zero UI**. This is the whole Slice-1 delivery surface |

### Slice 2 — decay defence (≈ 1d)

| ID | Item | Est. | Notes |
|---|---|---|---|
| **E7** | `orphanOwnerships({ departed: [holderId] })` | 0.5d | Flags every fact held by a departed/moved holder. Kills the dead-wiki-page failure mode |
| **E8** | Read-triggered verification signal | 0.5d | `whoOwns` marks a fact `needsConfirmation` when `queryCount` is high and `confirmedAt` is stale. `confirmOwnership(id)` bumps `confirmedAt` **without** a new content version (reuse `annotate`) |

### Not in scope

- No Slack/HRIS connectors (that's the Enterprise line, §22).
- No web UI — MCP is the Slice-1 interface (§12.1, MCP before SDKs).
- No permission model beyond existing workspace ACLs (`auth.js:15-22`).
- No LLM extraction of ownership from chat logs. Manual `assertOwnership` first;
  extraction only after the gap log proves which scopes are worth capturing.

## 5. Benchmark (§17 — required, no feature ships without one)

New bench: `bench/ownership.js`, results to `bench/RESULTS.md`.

1. **Temporal correctness** — seed a fixture org: 50 scopes, 3 regions, 120
   handovers over a simulated 18 months. Assert `whoOwns(scope, { asOf })`
   returns the correct holder at **every** handover boundary ±1ms.
   Floor: 100%. This is a correctness gate, not a score.
2. **Handover is not a contradiction** — after N handovers, unresolved
   contradiction count is 0 and trust has not been penalised.
   Floor: 0 contradictions, trust ≥ base.
3. **Latency** — p95 `whoOwns` under 10ms at 10k entities (metadata-keyed lookup,
   so it should beat the 64.8ms semantic-query p95 by an order of magnitude).
4. **Gap capture completeness** — every miss produces exactly one gap record;
   no double-counting on retry. Floor: 1.0.

## 6. Governance — this needs a §28 amendment first

CLAUDE.md §4 names **Stage 3 (Vertical AI)** as current focus, and §26 forbids
building for personas beyond the current stage without an explicit amendment.
This work serves a *new* persona (multi-team ops, closest to Persona B).

Two honest options:

- **(a)** Frame it as Stage-3 infrastructure. Defensible on the merits:
  "who authorised this operation, on what date, under whose sign-off" is the
  provenance story with teeth, and in a regulated vertical it is the audit
  question. Ownership-with-history is a compliance primitive.
- **(b)** Write a §29 amendment opening a new stage.

Either way the entry must exist **before** code lands, or the constitution is
decoration. Recommendation: **(a)** — it is true rather than convenient, and it
keeps one product instead of two.

Tier per §22: engine primitives are **Free**. Connectors, cross-team permissioned
access, and the gap dashboard are **Enterprise**.

## 7. Running in parallel — five calls

Not a gate on the code (the engine work is correct regardless). But the former
AV-company colleagues are the warmest discovery pipeline available, and the
gap-log design predicts something falsifiable:

> Most delay came from **small**, never-documented ownership — not from the
> stale headline pages.

Ask: *tell me the last time you didn't know who owned something — what did you
do, how long did it take, what slipped?* Listen for whether they say it
unprompted and whether they can name a delay in days. If the pain is
concentrated in big-and-stale instead, E7/E8 lead and E5/E6 drop down.

## 8. Definition of done (Slice 1)

- [ ] `assertOwnership` → `whoOwns` round-trips with region + authority scoping
- [ ] A handover produces a superseding version, zero contradictions, no trust penalty
- [ ] `whoOwns(..., { asOf })` correct at every handover boundary in the fixture
- [ ] Every answer carries holder, age, asserting source, and confirmation state
- [ ] A miss returns a structured miss **and** appends exactly one gap record
- [ ] `ownershipGaps()` ranks by ask count and distinct askers over a window
- [ ] Three MCP tools work from Claude Code against a live store
- [ ] Test + benchmark + one-paragraph doc for each public capability (§23.8)
- [ ] Nothing enterprise-only on `main` (§22)
