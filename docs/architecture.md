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

## Bounded Evolution (Phase 1)

Phase 1 adds a **library-grade** bounded-evolution surface inspired by
OpenRSI-style candidate records, without copying external sources and without
self-running loops.

| Layer | Module | Owns |
| --- | --- | --- |
| Domain | `src/evolution/domain.ts` | Schemas, trust context from role config, digests, evidence binding, lifecycle, pure guarded promote/reject/rollback |
| Catalog | `src/evolution/catalog.ts` | Runtime-private in-memory indexes, audit trail, per-target active pointers, internal promotion provenance, deterministic snapshots, atomic commit |

Current capabilities stop at trust-aware `strategy-blueprint` / `role-prompt`
candidates, SHA-256 digests, immutable lifecycle, explicit human
promotion/rejection/rollback, and atomic active-pointer updates. Deferred work
includes durable persistence, applying prompt or strategy files, agent
execution, evaluation automation, API/UI integration, network publication,
secrets, background loops, and automatic promotion.

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

See [evolution-phase-1.zh-CN.md](./evolution-phase-1.zh-CN.md) and
[ADR 0013](./adr/0013-bounded-evolution-domain-catalog-boundary.md).
