# CLAUDE.md - Product Direction and Engineering Constitution

**Last Updated:** 2026-04-17  
**Project:** Kalairos

This file defines the product direction, engineering goals, and transformation path for Kalairos. All major decisions should support this document.

Change Recording Rule
Core Best Practices
-Make Atomic Commits: Keep every commit focused on a single task. Avoid mixing unrelated changes, like a bug fix and a style update, to ensure easy reviews and safe reverts.
-Write Descriptive Messages: Use the imperative mood for your summary (e.g., "Add login" vs. "Added login"). Follow with a blank line and a "why" if the logic isn't obvious.
-Commit Frequently: Save small, incremental updates often. This minimizes merge conflicts and makes it easier to pinpoint where bugs were introduced.
-Use a .gitignore: Keep your repo clean by excluding build artifacts, dependencies, and sensitive credentials (like API keys) from the version history.


## 1. Product Goal

Kalairos is no longer just a lightweight semantic memory engine.

The target product is:

**A durable, private, time-aware memory system for long-running AI agents.**

The goal is to make Kalairos useful for teams building:

- AI agents with long-term memory
- Enterprise copilots with private context
- Research and workflow assistants that need historical recall
- Systems that must understand what changed, when, and why

## 2. Strategic Positioning

We are not trying to become a generic vector database.

We are building toward a stronger position:

- Agent memory, not just retrieval
- Time-aware knowledge, not just embeddings
- Private local-first infrastructure, not cloud dependency
- Versioned recall with auditability, not opaque storage

The core story should be:

**Kalairos helps AI systems remember accurately over time.**

## 3. Target Outcomes

To be compelling to advanced AI companies or serious product teams, Kalairos should achieve these outcomes:

### Outcome A: Production-usable agent memory

- Durable memory across sessions
- Stable identity for entities over time
- High-quality retrieval for current and past facts
- Memory that improves agent task completion, not just search quality

### Outcome B: Time-aware knowledge tracking

- Clear version history for important entities
- Ability to answer questions like:
  - what changed?
  - when did it change?
  - what was true before?
- Support for drift detection, contradiction handling, and recency-aware retrieval

### Outcome C: Private and enterprise-friendly deployment

- Local-first operation
- Clear audit trail
- Predictable persistence
- Easy integration into internal tools and agent systems

## 4. Product Principles

These are non-negotiable:

1. **Simple by default**
Kalairos must remain readable, explicit, and easy to integrate.

2. **Built for agents**
The system should optimize for long-running agent workflows, not only developer demos.

3. **Time matters**
The product must treat change over time as a first-class feature.

4. **Private by design**
Local-first and privacy-preserving behavior should remain a core strength.

5. **Useful over impressive**
We prefer practical memory quality, auditability, and retrieval accuracy over flashy architecture.

## 5. Clear Transformation Steps

The product should evolve in phases.

### Phase 1: Tighten the core memory engine

Goals:

- Keep the API small and reliable
- Improve retrieval quality on current and historical facts
- Make versioning more useful, not just present

Required improvements:

- Better entity update detection
- Better delta summaries
- Recency-aware scoring
- Historical query support
- Contradiction and drift detection

### Phase 2: Become an agent memory layer

Goals:

- Make Kalairos useful inside real agent loops
- Support separation between short-term and long-term memory
- Improve memory selection and storage decisions

Required improvements:

- Memory importance scoring
- Consolidation of repeated facts
- Session memory vs long-term memory separation
- Fact extraction from raw text
- Retrieval optimized for agent actions, not only similarity

### Phase 3: Become enterprise-ready

Goals:

- Support real organizational use
- Make memory inspectable, governed, and safe

Required improvements:

- Access control model
- Audit logs
- Source provenance
- Encryption options
- Connectors to common enterprise knowledge sources

## 6. Regulatory and Compliance Requirements

Kalairos is not a compliance product by default, but it should be built so regulated teams can adopt it safely.

The relevant regulatory and compliance targets include:

- SOC 2 for operational and security trust
- GDPR for personal data handling and deletion rights
- CCPA for consumer privacy rights
- HIPAA for protected health information if healthcare use cases are pursued
- ISO 27001-style security controls for enterprise readiness

These requirements should influence product design from the start.

### Data handling requirements

- Support data classification for stored memory:
  - public
  - internal
  - confidential
  - regulated
- Clearly distinguish raw user input, derived memory, metadata, and system-generated summaries
- Track source provenance for stored facts and memory updates
- Support configurable retention and deletion behavior

### Access and isolation requirements

- Support tenant-aware or workspace-aware data isolation
- Add role-based access controls for reading, writing, deleting, and exporting memory
- Log access to sensitive records and administrative actions
- Prevent cross-project or cross-tenant memory leakage

### Privacy requirements

- Support deletion workflows for user data and derived memory
- Support export workflows for user-associated records where needed
- Minimize stored sensitive content when full retention is not required
- Make it possible to disable or restrict storage of raw content in high-sensitivity environments

### Security requirements

- Encryption in transit must be supported for remote deployments
- Encryption at rest should be supported for persisted memory files or storage backends
- Sensitive configuration and secrets must not be stored in memory records
- Audit logs should be tamper-evident or append-only where possible

### AI-specific governance requirements

- Retrieval results should include provenance when possible
- Important memory changes should be inspectable by humans
- High-risk domains should support review, override, or rollback workflows
- The system should make it easy to understand why a memory was returned

### Product implication

If Kalairos targets enterprise agents, internal copilots, or regulated workflows, compliance cannot be treated as a later add-on.

It must shape:

- storage design
- API design
- metadata model
- auditability
- deletion behavior
- deployment architecture

## 7. What We Should Build Next

The highest-value next steps are:

1. Make retrieval time-aware
2. Improve version semantics and change tracking
3. Add memory evaluation benchmarks
4. Design an explicit agent-memory workflow
5. Add provenance and trust signals to stored knowledge

If a feature does not strengthen one of those five areas, it is probably not the next best use of time.

## 8. What We Should Avoid

Avoid these traps:

- Becoming a generic vector database clone
- Adding many data types without strong retrieval behavior
- Shipping broad features without a clear agent use case
- Prioritizing demos over durable memory quality
- Growing the API surface without stronger product focus

## 9. Canonical Product Thesis

Use this framing consistently:

**Kalairos is a memory engine for long-running AI agents that need durable, private, and time-aware recall.**

Secondary framing:

- Versioned memory for AI systems
- Local-first memory infrastructure
- Temporal retrieval for evolving knowledge

## 10. Engineering Rules

All implementation work should follow these rules:

1. Public APIs must stay explicit and predictable.
2. `init()` remains required before use.
3. All public methods should remain async.
4. Version history must never be treated as secondary metadata.
5. New features must improve either:
   - memory quality
   - temporal understanding
   - agent usability
   - privacy and trust
6. Keep code readable and modular.
7. Avoid duplicate embedding or retrieval logic.
8. Preserve backward compatibility unless there is a strong product reason to break it.

## 11. Canonical Data Expectations

Every stored entity should continue to support:

- stable identity
- latest state
- version history
- type-aware embeddings
- metadata
- graph relationships
- timestamps

The data model should evolve only when it strengthens time-aware agent memory.

In addition, the data model should be able to evolve toward:

- provenance metadata
- retention policy metadata
- sensitivity classification
- access-control hooks
- deletion and audit status

## 12. Success Criteria

We are moving in the right direction if Kalairos can eventually demonstrate:

- Better agent recall across sessions
- Better answers about changing information over time
- Reliable auditability for stored knowledge
- Strong local/private deployment value
- Clear differentiation from generic embedding stores

## 13. Decision Filter

Before adding a feature, ask:

1. Does this make Kalairos better as an agent memory system?
2. Does this improve time-aware recall or change understanding?
3. Does this strengthen privacy, trust, or auditability?
4. Does this support enterprise or regulatory readiness?
5. Does this help us differentiate from a generic vector database?

If the answer is no to most of these, do not prioritize it.

## 14. Product Tiers

Kalairos is open-core. Two editions exist with a clear boundary in the codebase.

### Free Edition (`main` branch — published to npm as `kalairos`)

The free edition is the complete, production-usable memory engine. It is the product we lead with publicly.

| Capability | Free |
|---|---|
| Core memory API (`ingest`, `query`, `remember`, `getHistory`, etc.) | yes |
| JSONL file-based persistence (`store/file-store.js`) | yes |
| Versioning, delta detection, contradiction tracking | yes |
| Graph linking and traversal | yes |
| Agent memory layer (`AgentMemory`, `createAgent`) | yes |
| MCP server | yes |
| Token-based workspace auth | yes |
| Rate limiting and input validation | yes |
| All benchmarks and eval tooling | yes |
| PostgreSQL / pgvector backing store | **no — Enterprise** |
| `kalairos migrate` (JSONL → PostgreSQL) | **no — Enterprise** |
| `docker-compose.yml` with pgvector | **no — Enterprise** |
| `sql/init.sql` schema | **no — Enterprise** |
| Multi-tenant workspace isolation (production-grade) | **no — Enterprise** |

### Enterprise Edition (`enterprise` branch — private, distributed separately)

The enterprise edition extends the free edition with PostgreSQL infrastructure and team-scale features. It is never published to npm and never pushed to the public GitHub repo.

Enterprise-only files (must not be committed to `main`):

- `store/kalairos-store.js` — KalairosStore adapter (PostgreSQL + pgvector, hot-cache)
- `sql/init.sql` — reference schema with IVFFlat ANN index
- `docker-compose.yml` — self-hosted pgvector stack
- `bin/cli.js` → full `kalairos migrate` implementation
- `index.js` → `KALAIROS_STORE=pg` routing to KalairosStore
- `package.json` → `pg` optional dependency, `start:pg` / `migrate` scripts

Future enterprise-only additions (do not ship in free):

- Audit log export endpoint
- SSO / SAML authentication
- Encryption-at-rest option
- Retention policy enforcement
- GDPR deletion workflows (export + purge by principal)
- Cross-workspace admin API
- Role management UI

### Branch discipline

- **Never commit enterprise-only files or code paths to `main`.**
- Any commit to `enterprise` that touches shared files (`index.js`, `server.js`, etc.) must be reviewed before cherry-picking to `main` — strip all pg-specific additions first.
- The `main` branch is the source of truth for the npm package. The `enterprise` branch is the source of truth for customer deployments.
- If `init()` receives `store: "pg"` on the free edition, it throws a clear upgrade error — this is intentional behaviour, not a bug.

### Tier decision rule

Before adding any feature, decide its tier:

- If it improves the core memory engine for any user → **Free**
- If it requires infrastructure (PostgreSQL, external services, org admin) or is a paid differentiator → **Enterprise**
- If unsure, default to **Free** and add to Enterprise later if needed
