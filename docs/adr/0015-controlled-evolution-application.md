# ADR 0015: Controlled Evolution Application

- Status: Accepted
- Date: 2026-08-11

## Context

Phases 1 and 2 can validate, audit, and durably restore bounded-evolution
proposals, but a promoted proposal does not by itself prove that a repository
prompt or custom strategy was applied. Updating a target and updating the
catalog are separate durable operations, so crashes between them must not
create a false application record.

Phase 3 adds a local application transaction. It does not add HTTP, UI,
automatic evaluation, automatic promotion, agent execution, or publication.

## Decision

`EvolutionApplicationCoordinator` is the exclusive mutation facade around one
`DurableEvolutionCatalog`. Opening the coordinator claims a writer lease on
that catalog instance; direct catalog mutation through a retained reference is
then rejected. The coordinator exposes proposal/evaluation use cases, immutable
previews, promote-and-apply, rollback, and explicit reconciliation of legacy
Phase-2 promotions.

### Material and targets

- Role-prompt proposal ingress accepts bytes once, validates the proposal
  first, requires strict UTF-8, a matching lowercase SHA-256 digest, and at
  most 256 KiB, then stores an immutable local object at
  `<stateDirectory>/evolution/objects/sha256/<digest>`.
- Apply and rollback commands never accept replacement bytes or caller-chosen
  paths. They resolve the candidate's configured Markdown `promptFile` and its
  immutable object.
- Prompt targets must already be regular, non-symlink, Git-tracked files. The
  write is same-directory `wx`, file fsync, rename, directory fsync; existing
  permission bits are preserved. `GitManager` authorizes a clean primary
  worktree before mutation and creates an exact one-file forward commit.
- Strategy candidates can create, replace, or delete only custom strategy
  blueprints, using an exact expected-before snapshot. Config-defined
  strategies and `agent-team.yaml` are never modified.
- Prompt objects are local recovery material, not a secret store. Configured
  prompt files must not contain credentials or other secrets.

### Preview and command boundary

Previews are immutable, short-lived, in-memory capabilities. A token binds the
operation, proposal and candidate digests, catalog revision, active pointer,
live target digest, operator label, and expiry. Returned target projections do
not expose strategy recovery definitions.

Mutation commands require a unique command ID, the preview revision and token,
operator label, and reason. A durable command binding stores the original
response proposal snapshot, so an exact retry returns the same response even
after a later lifecycle change. Reusing a command ID with different parameters
fails with `COMMAND_CONFLICT`.

Operator labels are trusted inputs to this library, not authenticated identity.
The Phase-4 loopback service must derive them from its local authenticated
session rather than accepting a body-supplied actor.

### Journal and recovery

`application-state.json` version 1 is a strict, digest-witnessed document with a
monotonic application revision. It contains active application proofs, at most
one write-ahead pending operation, append-only completions, and command
bindings. Nested records, uniqueness, proposal/candidate/target links, catalog
revisions, audit digests, and application history are validated on reopen.
Writes use `0600`, file fsync, rename, and directory fsync. The current primary
contents are compared before every write. A write failure seals the coordinator;
the caller must reopen instead of continuing with possibly divergent memory.

Transaction order is:

1. validate the complete catalog transition on an isolated catalog clone;
2. acquire quiescence and, for prompts, clean-worktree Git authorization;
3. persist pending journal state;
4. apply the target (and exact prompt Git commit);
5. commit the catalog promotion or rollback;
6. persist the completed application record and idempotency response.

On open, recovery classifies the live target and verifies the exact expected
catalog audit, active pointer, and revision. Old target plus old catalog becomes
`aborted`; new target plus verified new catalog is finalized; a new strategy
plus old catalog finishes the preflighted catalog transition. For prompts, a
new target is accepted only when HEAD is a clean direct child of the recorded
base and that commit changes exactly the configured prompt. If the process died
after prompt rename but before Git commit, the old object is restored and the
operation is aborted. Any unrelated revision, commit, digest, symlink, index,
or audit state fails closed with `RECOVERY_REQUIRED`.

Application records retain the full before target snapshot and the previous
application proof. This permits rollback of an initially hand-created custom
strategy and preserves an A -> B -> rollback B -> rollback A chain without
guessing material from audit history.

Legacy `adopt` proves only that the current target matches the promoted
candidate, while legacy `apply` proves the new candidate target but not that
the captured live baseline belongs to the catalog predecessor. Neither mode
creates a rollback-safe predecessor proof. A reconciled record may be replaced
by a later fully journaled application, but it cannot itself be rolled back.
The operator must reconcile predecessor material explicitly instead of
allowing catalog and target state to diverge.

## Consequences

- A catalog promotion and a repository target now have a durable, inspectable
  application proof rather than an inferred relationship.
- Exact retries and restart recovery do not need caller-supplied evidence,
  provenance, file paths, or apply-time bytes.
- The coordinator still assumes one process writer. The writer lease protects
  one catalog instance; it is not a cross-process filesystem lock.
- Synchronous compatibility getters publish only the last durable application
  snapshot. Phase-4 HTTP/SSE code must use the queued aggregate control snapshot
  so catalog and application revisions are observed after the same coordinator
  operation boundary.
- Phase-2 promotions require explicit `reconcilePromoted`: adopt only when the
  live digest already matches, or apply through the same journal. Legacy prompt
  material may be supplied only to that privileged reconciliation ingress.

## References

- Implementation: `src/evolution/application.ts`, `src/evolution/persistence.ts`
- Tests: `test/evolution-application.test.ts`
- Prior durability boundary: [ADR 0014](./0014-durable-evolution-catalog.md)
- Phase guide: [docs/evolution-phase-1.zh-CN.md](../evolution-phase-1.zh-CN.md)
