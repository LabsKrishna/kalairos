# Memory Poisoning Benchmark

A reproducible adversarial suite for the Kalairos memory engine. Derived from the MINJA threat family (memory injection via tool output and indirect prompt-injection routes) plus two memory-layer–specific attacks we think are under-measured in the broader field: repetition-for-fake-corroboration, and slow drip-drift.

```bash
node bench/poisoning/run.js
```

Output: `bench/poisoning/results.json`.

## The claim under test

Kalairos does not *reject* poisoned writes — no memory layer with an agent-friendly write API can, without sacrificing write availability. What Kalairos claims is stronger than silent trust and weaker than rejection:

> Every poisoned write leaves a durable, queryable trail. Contradictions are flagged on the version. Trust scores reflect the damage. History preserves the pre-poison state. Time-travel queries can recover what was true before the attack.

Each fixture exercises the four signals: **contradiction flag**, **trust penalty**, **history preservation**, **asOf recovery**.

## Attack taxonomy

| # | Attack | What it models | Defense checked |
|---|--------|---------------|-----------------|
| 1 | **Indirect injection** | Agent's ingest pipeline reads tool output (RSS, scrape, webhook) that contradicts a user-asserted fact. MINJA's primary vector. | 4/4 defenses fire |
| 2 | **Source spoofing** | Adversary claims `source.type = "user"` on poison. Source type is not authenticated in the free tier. | Contradiction flag + history + asOf recover the truth; trust penalty is applied because corroboration only counts (type, actor) voices supporting the current head claim — see §**Defense internals**. |
| 3 | **Repetition / sybil** | Adversary writes many copies of the same lie from many different URIs to fake corroboration. | Contradiction fires on the first poison. URI-only variation no longer multiplies voices, so repetition cannot manufacture corroboration. |
| 4 | **Drip poisoning** | Small numeric drift across many updates, each below the version-merge threshold. | Cumulative severity crosses the kill-switch (−0.6) and trust collapses to 0.1. Detection works. |
| 5 | **Trust override** | Adversary ingests with `trustScore: 1.0` hoping to claim arbitrary trust. | `trustScore` is clamped on ingest, and the composite query-time trust still applies contradiction penalties. Works. |
| 6 | **Key overwrite** | Adversary knows a record's key and writes to it directly from a less trusted source, worded nothing like the truth, naming `trustScore: 1.0`. Keys bypass similarity on purpose, so wording can't stop it. | The write lands contested: contradiction flag, trust penalty, base trust not raised, truth recoverable via asOf. With the contest rule switched off this fixture is compromised. |

## Current defense coverage

From a clean run (deterministic bag-of-words embedder, in-memory store):

| Fixture | Contradiction | Trust penalty | History preserved | asOf recovery | Verdict |
|---------|:-------------:|:-------------:|:-----------------:|:-------------:|:-------:|
| indirect-injection  | yes | yes (0.78)  | yes | yes | **DEFENDED** |
| source-spoofing     | yes | yes (0.71)  | yes | yes | **DEFENDED** |
| repetition-attack   | yes | yes (0.73)  | yes | yes | **DEFENDED** |
| drip-poison         | yes | yes (0.10, killed) | yes | yes | **DEFENDED** |
| trust-override      | yes | yes (0.83)  | yes | yes | **DEFENDED** |
| key-overwrite       | yes | yes (0.64)  | yes | yes | **DEFENDED** |

**6 / 6 defended.** All six fire the contradiction flag, keep history intact, recover the truth via time-travel, and apply a measurable trust penalty to the poisoned entity.

## Defense internals

Two trust-scoring invariants do the heavy lifting on source-spoofing and repetition attacks:

1. **Corroborator identity is `(type, actor)`, not `(type, uri, actor)`.** A single adversary cycling five domains is one voice, not five. URIs without an authenticated actor cannot multiply corroboration. (`trust.js` → `sourceKey`.)
2. **Corroboration only counts sources that support the *current* head claim.** Walking versions newest-first, counting stops at the most-recent contradicting version. A contradicting poison cannot inherit the corroboration bonus earned by the truth it overturned. (`trust.js` → `countCorroborators`.)

Together these are why source-spoofing and repetition no longer sneak past the trust penalty.

## Known gaps (not hiding them)

1. **Identical-poison repetition is invisible to contradiction detection.** Once the entity's current text is the poison, subsequent identical-text poisons produce no delta and are treated as benign consolidation. The trust floor still holds (they can't manufacture new corroboration), but no new contradiction flag fires. Catching this requires reasoning over version-source history, not just the latest text transition.
2. **Source-type is not authenticated in free tier.** `source.type = "user"` can be asserted by anyone. Stage 2 (Persona B) lists auth as a first-class requirement; until then, `source.type` is a hint, not a guarantee.

Today's claim is the precise one above: **every poison leaves a trail, and corroboration math cannot be gamed by URI minting or contradiction-chaining.** That is what this bench verifies.

## Comparison with other engines

The runner records slots for `mem0` and `zep`, currently empty:

```json
"engines": {
  "kalairos": { "ranHere": true,  "passed": 5, "total": 5 },
  "mem0":     { "ranHere": false, "note": "run bench/poisoning/adapter-mem0.js with MEM0_API_KEY" },
  "zep":      { "ranHere": false, "note": "run bench/poisoning/adapter-zep.js against a local Zep" }
}
```

Adapters that fill those slots are a follow-up. They require external services; the fixtures themselves are engine-agnostic and can be translated to any memory API that exposes ingest + query + history + time-travel.

## Rerunning with different embedders or thresholds

The runner sets `versionThreshold: 0.35` and `trustWeight: 0.4` to make the bag-of-words test embedder merge semantically-related updates into the same entity. Production defaults (0.82 / 0) are calibrated for neural embeddings and would suppress the merge signal for short test sentences. If you swap in a real embedder (OpenAI `text-embedding-3-small`, Cohere embed-v3, etc.), rerun with production thresholds — the defense logic is identical.
