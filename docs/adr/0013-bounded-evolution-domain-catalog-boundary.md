# ADR 0013: Bounded Evolution Domain And Catalog Boundary

- Status: Accepted
- Date: 2026-08-11

## Context

The project needs a Phase-1 building block for **bounded**, OpenRSI-inspired
evolution of strategy blueprints and role prompts. The approved implementation
already exists in `src/evolution/domain.ts` and `src/evolution/catalog.ts`.

Without a sharp ownership split, future persistence, API, or worker integration
could:

- trust self-declared policy allowlists instead of project role configuration;
- mix pure lifecycle rules with mutable indexes;
- accept caller-supplied promotion provenance on rollback;
- apply prompt or strategy files while the catalog only intended to record
  candidates;
- let advisory (LLM) approvals override failing deterministic evidence.

Phase 1 must remain a **library-grade, in-memory, human-gated** record of
candidates. It must not become a background self-modification loop.

## Decision

### Domain ownership (`src/evolution/domain.ts`)

The domain module is the pure authority for:

- versioned schemas for policy, candidates, evidence, evaluation results, human
  decisions, lifecycle transitions, and audit records;
- `EvolutionTrustContext` validation for a caller-supplied role map; the trusted
  integration must derive that map from loaded role configuration (`promptFile`
  paths and `allowedProfiles`), never from proposal payloads alone;
- SHA-256 digests that bind evidence to an immutable candidate snapshot;
- the lifecycle transition matrix and guarded operations
  (`evaluateProposal`, `promoteProposal`, `rejectProposal`, `rollbackProposal`);
- evaluation rules that **require at least one deterministic evidence item**,
  treat empty advisory sets as non-blocking when deterministic checks pass
  (independent review is recommended workflow, not automated enforcement),
  reject present non-approving advisory verdicts, and let any deterministic
  failure veto advisory approvals;
- capability flags fixed to
  `automaticExecution`, `automaticPromotion`, `networkPublication`, and
  `secretStorage` all literal `false`;
- path safety for repository-relative Markdown prompt targets (no absolute
  paths, traversal, or source-tree prefixes).

The domain does not index proposals, retain active pointers, open the network,
read or write repository files, or spawn agents.

### Catalog ownership (`src/evolution/catalog.ts`)

The catalog module is the runtime-private, in-memory authority for:

- proposal identity uniqueness and lookup;
- ordered audit history;
- per-target **active** proposal pointers
  (`strategy-blueprint` by name, `role-prompt` by path);
- **internal** promotion provenance used only for rollback restoration;
  callers cannot inject or replace it;
- deterministic, deeply isolated `snapshot()` output;
- transactional `#commit` so validation or multi-field update failures leave no
  partial state;
- reentrancy guards around mutations.

Lifecycle and trust checks are **delegated exclusively** to the domain. The
catalog does not reimplement schema rules and does not persist to disk in
Phase 1.

### Trust boundary

```text
trusted caller + project roles (allowedProfiles, promptFile)
  -> EvolutionTrustContext
  -> parse policy / candidate / proposal
  -> catalog mutations
```

- `policy.allowedPromptPaths` must be a subset of configured role `promptFile`
  targets.
- Strategy candidate `roleProfiles` must name configured roles and profiles
  allowed for those roles.
- Role-prompt candidates store only a path and content digest, never raw prompt
  text, and never apply files.
- Promotion, rejection, and rollback require explicit human `actor` and
  `reason`. The schema treats `actor` as a non-empty audit label, not
  authenticated human provenance; identity authentication belongs to the
  calling control plane.
- Phase 1 does not load `agent-team.yaml` or authenticate trust-context
  provenance. The caller must construct the context from already trusted,
  loaded configuration.
- Rollback is allowed only for the proposal that is **currently active** for its
  candidate target; restoration comes solely from the catalog-retained
  promotion record.

### Explicit non-goals (Phase 1)

- Durable catalog storage or automatic reopen on process start
- Applying prompt files or strategy definitions to the repository
- Agent execution, evaluation automation, API/UI surfaces
- Network publication, secret storage, background loops, automatic promotion

## Consequences

- Maintainers can evolve persistence or UI later without rewriting lifecycle
  rules, as long as they keep domain pure and catalog authoritative for indexes.
- Tests can assert atomicity, deterministic snapshots, and provenance isolation
  without filesystem fixtures.
- Documentation and operators must describe Phase 1 as **recording** candidates,
  not as live configuration management.
- Reopening any future durable form must re-supply trust context; self-declared
  allowlists alone are insufficient.
- Worker and strategy budgets documented elsewhere (for example Grok
  `maxTurns: 16` and strict `maxReworkAttempts: 2`) remain workflow controls;
  they are not evolution-catalog features.

## Deferred work

See the phased roadmap in
[docs/evolution-phase-1.zh-CN.md](../evolution-phase-1.zh-CN.md). All future
phases are **unimplemented** until separate tasks land:

1. durable catalog and trusted reopen;
2. controlled file application under human gates;
3. workflow/API evaluation integration without auto-promotion;
4. optional stronger automation only behind explicit multi-gate policy.

## References

- Implementation: `src/evolution/domain.ts`, `src/evolution/catalog.ts`
- Tests: `test/evolution-domain.test.ts`, `test/evolution-catalog.test.ts`
- User/maintainer guide: [docs/evolution-phase-1.zh-CN.md](../evolution-phase-1.zh-CN.md)
- Related: [ADR 0012](./0012-grok-headless-worker-adapter.md),
  [architecture.md](../architecture.md), [security.md](../security.md)
