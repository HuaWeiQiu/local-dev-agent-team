# Architecture

## Design Goals

Local Dev Agent Team coordinates existing coding agents without becoming a
model provider or authentication broker. The control plane owns workflow
state, Git isolation, quality gates, retry limits, and GitHub publication. Agent
CLIs own model access, authentication, tool execution, and model-specific
configuration.

The optional local control service is a long-running owner around this core:

```text
browser or CLI
  -> loopback REST commands
  -> run supervisor
  -> workflow core
  -> agent CLI processes

workflow and process events
  -> SQLite event ledger
  -> cursor-based SSE
  -> browser projections
  -> OTLP JSON trace export
```

Only the control service starts and cancels managed runs. A browser never
spawns an agent process or edits run snapshots directly.

The React workbench is built as static assets and served by the same loopback
HTTP service. It renders run snapshots as a task DAG and uses the event ledger
only for live projections. Desktop and mobile layouts share the same REST/SSE
contract; the UI has no adapter-specific process control.

A workspace service can place several project runtimes behind the same HTTP/UI
process. Discovery is shared, but execution is not: every project owns a
separate supervisor, process lease, SQLite event ledger, state directory,
worktrees, and artifacts. Commands and SSE use `/api/projects/:projectId`; the
single-project `/api` routes remain compatible. A workspace never starts in a
partially available state.

## Control And Execution Planes

The deterministic control plane:

- validates configuration and role/profile policy;
- invokes agents through typed adapters;
- validates structured agent output;
- creates and removes isolated Git worktrees;
- schedules dependency-safe worker waves;
- runs configured commands and records exact exit codes;
- applies retry and escalation limits;
- publishes an integration branch and pull request when requested.

The agent execution plane:

- interprets goals and repository context;
- proposes a task DAG;
- implements bounded tasks;
- reviews diffs independently;
- analyzes test coverage and failures;
- recommends accept, rework, or escalation.

Deterministic policy always wins over agent recommendations.

## Budgets And Telemetry

Named strategies bound every active execution segment, cumulative agent
invocations, captured output per stream, and total run artifacts. Budget usage
is stored in the run snapshot and rendered by the workbench. Approval waits do
not consume execution timeout, while continuation and recovery retain the
run-wide invocation and artifact counters.

Each strategy also compiles a declared topology into an immutable stage graph.
The first supported modes are dependency-aware `parallel-dag` and `sequential`;
both retain mandatory deterministic gates and final human approval. The same
compiled graph is projected to the workbench and stored with the run so UI
layout cannot redefine backend execution semantics.

Every event has a stable run trace ID and an event span ID. The REST control
plane can project retained events into OTLP/HTTP JSON without sending data to a
remote collector. The SQLite ledger remains authoritative for retained events;
the run snapshot remains authoritative for current budgets, approvals, and
checkpoints.

## Configuration Layers

```text
project defaults
  -> role default profile
  -> task profile override
  -> explicit human run override
```

The resolved profile contains an adapter name, optional model, reasoning level,
permission mode, external-tool policy, optional native CLI profile, timeout,
and safe argument list. The scheduler may select only profiles listed by the
role policy. Only the worker role can receive workspace-write permission.

Every adapter publishes a versioned local-process contract covering supported
reasoning levels, permissions, external-tool policies, structured output, and
reported usage fields.
Before spawn, the control plane verifies adapter/profile ownership, working
directory, managed stdin-or-file prompt delivery, output path, and timeout. `agent-team interop`
and `GET /api/interop` expose the same machine-readable contract.

MCP and A2A have separate ownership boundaries. MCP `2026-07-28` integration is
profile-controlled and provider-managed: `deny` is the default, while `inherit`
lets the selected Agent CLI use its own MCP configuration. The control plane is
not an MCP Host and stores no MCP credentials. Because MCP tools can execute
outside the CLI filesystem sandbox, only workspace-write worker profiles may
select `inherit`. A2A `1.0` remote task ingress is disabled because the loopback
service has no remote identity or authorization layer; it must sit behind a
separately authenticated HTTPS gateway before that boundary can change.

## Workflow State

```text
created
  -> orchestrating
  -> architecting
  -> planned
  -> implementing
  -> reviewing/testing
  -> reworking (bounded loop)
  -> integrating
  -> final-checks
  -> awaiting-human
  -> ready-to-merge
  -> completed
```

Any state can transition to `blocked` on a non-recoverable infrastructure or
policy failure. State is persisted after every transition for audit and
diagnosis.

Control-service cancellation transitions a run to `cancelled`. When a new
service instance finds a non-terminal run owned by a previous service instance,
it records `interrupted` while preserving worktrees, branches, and artifacts.
Recovery is allowed only when the integration HEAD matches the latest durable
task-boundary checkpoint. Work from a partial wave is retained as abandoned
evidence and rerun on new branches; an interrupted agent process is never
continued in place.

## Git Isolation

Each worker receives a branch and worktree created from the current integration
commit. Workers in the same scheduling wave must have disjoint declared path
ownership. Passing worker commits are merged into the integration branch in a
deterministic order. The primary working tree is never used for agent edits.

## Trust Boundaries

- Agent text is untrusted data.
- Profile arguments are passed to child processes without a shell.
- Adapter-managed directory, permission, MCP, model, and output arguments cannot
  be overridden by profile extras.
- Model names are opaque strings, not executable fragments.
- Reviewer and tester sessions cannot approve their own implementation.
- The worker cannot convert a failed command into a passing result.
- GitHub publication is opt-in and never implies automatic merge.

## Bounded Evolution (Phases 1-6)

Phase 1 adds a **library-grade** bounded-evolution surface inspired by
OpenRSI-style candidate records without copying external sources. Phase 6 adds
an explicitly started, hard-bounded strategy loop on top of those records.

| Layer | Module | Owns |
| --- | --- | --- |
| Domain | `src/evolution/domain.ts` | Schemas, trust context from role config, digests, evidence binding, lifecycle, pure guarded promote/reject/rollback |
| Catalog | `src/evolution/catalog.ts` | Pure synchronous in-memory indexes, audit trail, per-target active pointers, internal promotion provenance, deterministic snapshots, atomic commit, trust-validating restore |
| Persistence | `src/evolution/persistence.ts` | Repository-local versioned document, exact revision witness, ordered audit replay, full pre-write document validation/comparison, symlink-safe paths, atomic file commit, fail-closed reopen |
| Application | `src/evolution/application.ts` | Exclusive catalog writer, immutable preview capabilities, prompt object ingress, target/Git apply, write-ahead journal, idempotency, crash reconciliation, target rollback chain |
| Control service | `src/server/evolution-service.ts`, `src/server/http.ts` | Session-bound proposal ingress, fixed server preflight, exact preview material, project mutation latch, shutdown drain, sanitized HTTP projection |
| Workbench | `web/src/components/EvolutionWorkbench.tsx`, `web/src/api.ts` | React/Tauri state-driven proposal UI, exact preview confirmation, stable per-intent idempotency keys, stale-preview cleanup, responsive navigation |
| Automatic strategy loop | `src/evolution/automation.ts`, `src/server/evolution-automation.ts` | Read-only candidate proposer, isolated fixed-goal evaluation runs, deterministic scoring, bounded stopping, automatic strategy apply, runtime-default recovery |

Current capabilities include trust-aware `strategy-blueprint` / `role-prompt`
candidates, SHA-256 digests, immutable lifecycle, explicit human
promotion/rejection/rollback, atomic active-pointer updates, and Phase-2
durability under `<stateDirectory>/evolution/catalog.json`. Reopen derives
trust only from current role config and validates proposal state, ordered audit
history, promotion provenance, active pointers, exact mutation revision, and
payload integrity before restoring memory. Writes use a unique `0600` temporary
file, file fsync, rename, and directory fsync; a post-rename fsync failure seals
the instance until reopen because durability is indeterminate.

Phase 3 adds controlled target application after an immutable preview and
explicit human command. Prompt bytes are accepted only at proposal ingress,
stored in a local content-addressed object store, and later applied only to an
existing configured Git-tracked prompt file through an exact one-file forward
commit. Custom strategy mutations use exact expected-before snapshots. A
separate strict `application-state.json` journal binds the target transition to
the exact catalog audit and makes command retries durable. The coordinator
claims exclusive mutation ownership of its catalog instance so integration code
cannot perform a catalog-only promotion through the same object.

Phase 4 mounts the coordinator under the runtime's cross-process control lease.
The browser can submit only candidate intent; proposal identity, policy, path,
digest, evidence, operator identity, and timestamps are server-owned. Evaluation
is a fixed structural and safety preflight bound to the immutable candidate. It
persists the source `server-structural-preflight-v1`; legacy external evaluations
cannot be relabeled or promoted through the HTTP boundary. It does not claim
candidate execution or behavioral quality. Ordinary Phase-4 promotion and rollback
remain separate preview/confirm operations and never run automatically. The separately
authorized, bounded Phase-6 path is described below. Shutdown seals both
evolution operations and run action queues before closing stores or releasing the
lease. Legacy exact-match adoption is available over HTTP; legacy target writes
require the exclusive offline reconciliation command.

Phase 5 exposes the narrow control service in the existing React/Tauri shell.
The workbench never accepts operator identity, target paths, digests, evidence,
or confirm-time material from the user. It keeps preview tokens and command IDs
only in component memory, clears them on scope or revision changes, and refetches
the authoritative snapshot after each mutation. Mobile uses a list/detail flow;
desktop keeps proposal index, detail, and next-action panes visible together.

Phase 6 adds a separate project-authorized automation path for strategy
blueprints. It acquires exclusive supervisor ownership, evaluates the incumbent
and each candidate against the same configured goal in isolated worktrees, and
persists evidence as `server-automatic-run-evaluation-v1`. A candidate must pass
all local gates and exceed the incumbent's deterministic score by the configured
delta. The loop stops at the requested/configured cycle limit or after the
configured number of consecutive non-improvements. It never publishes or merges,
does not evolve role prompts, and cannot start automatically on process launch.
Applied winners are restored as the runtime default after restart.

The Start command is durably idempotent and bound to the authenticated session
operator. Only completed, server-owned evaluation runs with exact goal/strategy
provenance and successful deterministic commands can pass. Proposer fallbacks remain
read-only, and candidates cannot increase resource or time budgets above the incumbent.

The lease publishes a fully written and fsynced owner record atomically with a
same-directory hard link. A malformed, incomplete, or stale `control.lock` is
never replaced automatically: the operator must first verify that no control
service owns the project and then remove the file explicitly.

New coordinator-owned promotion and rollback records carry their durable
application command identity. Startup validates catalog audits and application
completions in both directions and treats stored command result proposals only as
immutable historical prefixes, so retries cannot return a rewritten lifecycle.

Deferred work includes automatic role-prompt evaluation, multi-benchmark suites,
agent-driven suggestion queues, network publication, secrets, scheduled/background
loops, and automatic code/PR merge.

Operator flow: `propose → evaluate → external independent review of the
immutable evaluated snapshot → explicit human promote/reject → human
rollback`. `evaluate` is the only operation that attaches evidence and
transitions to `evaluated`; advisory review must be collected before that call
if its verdict needs to be stored in the evidence snapshot. There is no
post-evaluation evidence append API, and `promote` rejects any evidence that
differs from the recorded evaluation snapshot, so the recommended
post-evaluation independent review stays external and unrecorded in Phase 1.
At least one deterministic
evidence item is required. Advisory/independent review is the intended
operator workflow but is **not** enforced or automated in Phase 1: empty
advisory evidence may still pass when deterministic checks pass, while any
present non-approving advisory verdict fails evaluation. Any deterministic
failure vetoes LLM or other advisory approval. Rollback applies only to the
currently active promotion and restores only catalog-internal provenance.

See [evolution-phase-1.zh-CN.md](./evolution-phase-1.zh-CN.md),
[ADR 0013](./adr/0013-bounded-evolution-domain-catalog-boundary.md), and
[ADR 0014](./adr/0014-durable-evolution-catalog.md), and
[ADR 0015](./adr/0015-controlled-evolution-application.md), and
[ADR 0016](./adr/0016-evolution-control-plane.md), and
[ADR 0017](./adr/0017-bounded-automatic-strategy-evolution.md).
