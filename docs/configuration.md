# Configuration

`agent-team.yaml` is the only project configuration file. The CLI searches the
current directory and its parents, or accepts an explicit path with `--config`.
Validate it before every first run:

```bash
agent-team validate
agent-team profiles
agent-team doctor
```

## Multi-Project Workspace

`agent-team.workspace.yaml` is an optional manifest for one workbench that
controls several configured repositories:

```yaml
version: 1
projects:
  - id: web
    config: ./web/agent-team.yaml
  - id: api
    config: ../api/agent-team.yaml
```

Project IDs are lowercase URL-safe identifiers and must be unique. Config paths
resolve from the manifest directory. Duplicate canonical repository roots are
rejected. The manifest accepts 1 to 64 projects and is loaded at service start;
the browser cannot add arbitrary filesystem paths. Use `validate --workspace`
and `serve --workspace` to select this mode.

## Profiles

A profile is a reusable execution configuration, independent of role:

```yaml
profiles:
  codex-worker-fast:
    adapter: codex
    model: inherit
    reasoning: medium
    permission: workspace-write
    externalTools: deny
    codexProvider:
      id: compatible-gateway
      baseUrl: https://gateway.example.com
      wireApi: responses
      requiresOpenAIAuth: true
      supportsWebSockets: false
    timeoutSeconds: 1800
    args: []

  claude-reviewer:
    adapter: claude
    model: sonnet
    reasoning: high
    permission: read-only
    externalTools: deny
    timeoutSeconds: 900

  grok-worker:
    adapter: grok
    model: grok
    reasoning: high
    permission: workspace-write
    externalTools: deny
    maxTurns: 16
    timeoutSeconds: 3600
```

| Field | Meaning |
| --- | --- |
| `adapter` | Registered adapter: `codex`, `claude`, or `grok`. |
| `executable` | Optional executable path/name instead of the adapter default. |
| `model` | `inherit` or a model name understood by that CLI. |
| `reasoning` | Generic level validated by the selected adapter. Codex and Claude accept through `max`; Grok accepts `low`, `medium`, or `high`. |
| `permission` | `read-only` or `workspace-write`. |
| `externalTools` | `deny` (default) or `inherit` the Agent CLI's MCP configuration. |
| `nativeProfile` | Optional Codex CLI native profile. |
| `codexProvider` | Optional explicit Codex-compatible Responses provider used even when user configuration is isolated. It contains no API key. |
| `maxTurns` | Optional Grok headless turn limit, from 1 through 100. |
| `timeoutSeconds` | Maximum process duration for one invocation. |
| `args` | Extra non-reserved CLI arguments, passed without a shell. |

The orchestrator treats model names as opaque. `doctor --probe-models` makes a
small real request and is the authoritative availability check; it is opt-in
because it may consume quota. Reserved model, permission, directory, and
structured-output flags cannot be overridden through `args`.

`externalTools: deny` makes Codex ignore user configuration and marks the
invocation root untrusted so project configuration is disabled (authentication
is retained). An optional `codexProvider` is passed back as narrowly scoped CLI
configuration, so a compatible gateway remains available without loading user
MCP servers or plugins. It supplies Claude with a strict empty MCP configuration. Grok
keeps its authenticated `GROK_HOME` but uses a disposable process home so
compatible user-home MCP sources are not discovered, and it removes MCP
invocation tools; Grok memory, subagents, and Web tools are also disabled for
managed runs.
`inherit` is an explicit opt-in to provider-managed MCP configuration; the
orchestrator does not load MCP credentials, authorize tools, or own MCP server
processes. Adapter-managed MCP, directory, permission, session, model, and
output arguments cannot be reintroduced through `args`.

External MCP tools are not guaranteed to obey the CLI's filesystem sandbox.
Therefore `inherit` is valid only on `workspace-write` profiles, which in turn
may be assigned only to the worker role. Every read-only profile must use
`deny`.

In Codex deny mode, `model: inherit` means the CLI built-in default because the
user configuration is intentionally not loaded. Use an explicit model when it
must be stable. User and project MCP configuration is disabled; enterprise
managed configuration remains host-admin policy. `nativeProfile` also depends
on user configuration and therefore requires `externalTools: inherit` on a
workspace-write worker profile.

`codexProvider.id` must be a simple provider identifier. `baseUrl` is the
compatible endpoint, `wireApi` is currently restricted to `responses`, and the
authentication secret remains in Codex's own `auth.json`; never put an API key
in `agent-team.yaml`. Disable WebSockets when the gateway only implements the
Responses HTTPS transport.

Grok headless mode receives prompts through a private owner-only temporary file,
because its headless CLI does not consume piped stdin. The control plane creates
and removes that file for each invocation; profiles cannot override its path.
Use `model: grok` for a Grok profile. A Codex model name such as
`gpt-5.6-sol` is never passed to Grok.

The Grok adapter uses `maxTurns` when configured and otherwise defaults one
invocation to 24 turns. Scope and workflow behavior belong in the worker role's
editable `promptFile`, not in the adapter. Workflow-level `maxReworkAttempts` is
a separate bound; keep it low because deterministic checks and independent
review, not repeated worker self-revision, decide whether another attempt is
justified.

## Role Policy

Every required role maps to one default profile and an allowlist:

```yaml
roles:
  reviewer:
    defaultProfile: claude-reviewer
    allowedProfiles: [claude-reviewer, codex-planner]
    fallbackProfiles: [codex-planner]
```

Only `worker` may allow `workspace-write` profiles. Every other role's default,
allowlist, and fallbacks must be read-only. `agent-team invoke` is diagnostic
and rejects workspace-write profiles even for the worker role.

Required roles are `orchestrator`, `architect`, `worker`, `reviewer`, and
`tester`.

Optional first-class role:

- **`researcher`（技术研究员）**: read-only technical research used by the optional
  explore stage before architect planning (`taskMorphology.explore.enabled`).
  When the role is absent from the yaml, `loadConfig` backfills it by mirroring
  `architect`'s profile chain (built-in `prompts/researcher.md`), so every project
  shows it in the run launcher and CLI picker without editing the file. New
  defaults and `agent-team.example.yaml` include it explicitly.

Other notes:

- A task plan may choose only a profile allowed by the worker role.
- A run-level `--profile role=name` override is also checked against the allowlist.
Fallbacks are attempted in declared order and recorded in invocation artifacts;
there is no silent model fallback.

All non-worker role profiles must be read-only, including defaults, allowlists,
and fallbacks. Workers normally need `workspace-write`. The tester analyzes
deterministic test results and therefore remains read-only.

`promptFile` optionally replaces a role's bundled prompt with a path relative
to the repository root. This is the supported place for project-owned agent
behavior such as task scope, verification discipline, and stopping rules.

## Named Execution Strategies

A named strategy selects role profiles and run limits as one auditable policy:

```yaml
strategies:
  default: balanced
  definitions:
    balanced:
      topology:
        mode: parallel-dag
      maxParallel: 2
      maxReworkAttempts: 2
      executionTimeoutSeconds: 14400
      maxAgentInvocations: 64
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 1073741824
      approvalGates: [final]
      approvalTimeoutSeconds: 86400
      roleProfiles: {}
    strict:
      topology:
        mode: sequential
      maxParallel: 1
      maxReworkAttempts: 3
      executionTimeoutSeconds: 21600
      maxAgentInvocations: 96
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 2147483648
      approvalGates: [plan, final]
      approvalTimeoutSeconds: 172800
      roleProfiles:
        reviewer: claude-reviewer
```

Select a non-default policy with `agent-team run --strategy strict`. Explicit
`--profile role=name` assignments take precedence over strategy mappings, and
strategy mappings take precedence over role defaults. Every mapped profile is
validated against the role allowlist. Omitting `strategies` preserves the
legacy project concurrency and quality rework limits while still requiring
final approval.

`topology.mode` selects the executable collaboration shape. `parallel-dag`
schedules dependency-ready tasks in bounded, path-disjoint waves. `sequential`
uses the same dependency and ownership checks, resolves omitted concurrency to
one, and rejects an explicit `maxParallel` value other than `1`.
Omitting `topology` preserves the existing `parallel-dag` behavior. Unsupported
future modes are rejected until the control plane implements their runtime
semantics; the visual editor does not bypass this validation.

`approvalGates` may be `[final]` or `[plan, final]`; the final gate is mandatory.
`approvalTimeoutSeconds` is bounded from 60 seconds to 7 days and defaults to
24 hours. Plan approval pauses before worker execution. Final approval pauses
after deterministic checks and the supervising decision pass.

`executionTimeoutSeconds` bounds one active workflow segment and excludes time
waiting for human approval. `maxAgentInvocations` is cumulative across the run,
including fallback profiles and checkpoint recovery. `maxProcessOutputBytes`
caps captured stdout and stderr separately for every agent or quality process.
`maxArtifactBytes` stops further execution after the run artifact directory is
observed over budget; existing evidence is retained.

Token and USD usage are recorded only when an adapter explicitly reports them.
They are observational because provider CLIs do not expose one stable shared
cost contract. Use `maxAgentInvocations` as the enforceable provider-neutral
spend bound.

## Bounded Automatic Evolution

Automatic evolution is opt-in and currently changes only strategy blueprints:

```yaml
evolution:
  automatic:
    enabled: true
    autoStart: false
    maxCycles: 3
    maxConsecutiveNoImprovement: 2
    evaluationRepeats: 1
    minimumScoreDelta: 1
    proposerRole: orchestrator
    proposerProfile: codex-orchestrator
    baselineStrategy: balanced
    targetStrategy: auto-evolved
    useGlobalCliDefaults: false
    evaluationGoal: >-
      Improve one small, well-tested reliability issue without changing public
      behavior or release configuration. Run every configured quality command.
```

`autoStart` is deliberately restricted to `false`: the operator starts a bounded
session from the evolution workbench, after which all requested cycles run
automatically. `maxCycles` is 1-10 and is also the hard ceiling exposed by the UI.
`maxConsecutiveNoImprovement` cannot exceed it. `evaluationRepeats` is 1-2 and the
worst repeated score wins the aggregate. `minimumScoreDelta` is 0-1000.

`useGlobalCliDefaults` (default `false`) threads the desktop global CLI defaults
(`~/.agent-team/desktop-settings.json`) into evaluation runs as ephemeral
profiles for roles the evaluated strategy does not map itself. Strategy
`roleProfiles` always win over global defaults, and roles missing from the
project config are ignored; when no usable global default exists, evaluation
falls back to the project yaml profile chains.

The proposer role/profile must resolve to a read-only profile. `baselineStrategy`
must name a configured strategy. `targetStrategy` must be a valid custom strategy
name and cannot replace a strategy declared under `strategies.definitions`.
`evaluationGoal` is required when enabled and remains identical for incumbent and
candidate runs. Every fallback on the proposer role must also resolve to a read-only
profile. At least one deterministic `quality.commands` entry is required.

Candidates may reduce, but cannot increase, the incumbent's parallelism, retries,
agent invocations, execution timeout, process output, artifact, or approval timeout
budgets. A passing outcome must be a persisted `completed` run with purpose
`evolution-evaluation`, the exact server-issued goal and strategy, at least one
successful deterministic command, a ready final decision, and all tasks merged.

If a custom strategy already occupies `targetStrategy`, automation continues
only when the active automatic proposal, durable application proof, and live
definition match exactly. A manually managed or drifted target fails closed and
is never overwritten.

During the loop, ordinary runs and target mutations are temporarily unavailable.
Evaluation runs use isolated worktrees, execute the normal deterministic quality
commands, and never publish or merge. The applied winner becomes the runtime
default strategy. Closing the service stops the current loop; restart restores an
already applied winner but never starts another loop automatically. See
[ADR 0017](adr/0017-bounded-automatic-strategy-evolution.md).

The Start request is durably idempotent and bound to the authenticated local session
operator and requested cycle count. A retry in the same live session replays its
snapshot; after process restart an already accepted key fails closed instead of
starting a duplicate loop. Promotion and rejection audits use that trusted operator.

## Observability

```yaml
observability:
  maxEventsPerRun: 50000
```

The event limit is per run and ranges from 100 to 1,000,000. Oldest event rows
are trimmed after append; the run snapshot, approvals, checkpoints, and
artifacts are not removed. The default is 50,000.

## Project And Quality

```yaml
project:
  name: my-service
  defaultBranch: main
  stateDirectory: .agent-team
  maxParallel: 2

quality:
  commands:
    - command: pnpm
      args: [check]
    - command: pnpm
      args: [test]
  maxReworkAttempts: 2
  commandTimeoutSeconds: 900
```

Quality commands execute directly, without a shell. Put each argument in
`args`; shell syntax such as pipes, redirection, and `&&` is not interpreted.
Task-specific acceptance commands are combined with these project commands.
Any nonzero exit code vetoes the task regardless of an agent verdict.

Optional external CLIs (for example Alibaba `ocr review`) may be listed the
same way. Prefer install-and-call over embedding another review engine. See
[可选外部集成](integrations-optional.zh-CN.md). `agent-team doctor` reports
whether each configured quality command is available on `PATH`.

`maxParallel` limits one dependency-ready scheduling wave. Parallel tasks must
declare disjoint `ownedPaths`, and the plan is rejected when ownership overlaps.

## Run Actions And Cancellation

The control service cancels runs in two ways. A run owned by a live process is
aborted through its execution controller. A run parked at `awaiting-human`
(pending approval) or recovered as `interrupted` (previous service instance)
has no live owner; it is still cancellable and moves directly to the terminal
`cancelled` state. Cancellation while the automatic evolution loop owns the
project is rejected as a conflict. See
[architecture.md](./architecture.md#workflow-state) for the full state machine.

Run action endpoints (`cancel`, `retry`, `respond-approval`, `resume`,
`delete`, cleanup) classify failures by HTTP status and machine-readable code:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Malformed body or unknown strategy/profile/role parameter |
| 404 | `RUN_NOT_FOUND` | Unknown run id |
| 409 | `RUN_STATE_CONFLICT` (or the mutation-conflict code) | Status/lifecycle conflict: wrong source status, stale approval, expired preview, concurrent project mutation, evolution automation ownership |
| 500 | `INTERNAL_ERROR` | Unexpected failure; the detail is logged server-side and the body stays generic |

Plan approval is forced whenever any planned task defines
`acceptanceCommands`, regardless of strategy gates, so agent-produced commands
never execute without human review of the introducing plan. See
[workflow.md](./workflow.md) for the approval lifecycle.

## GitHub

```yaml
github:
  enabled: true
  remote: origin
  draftPullRequest: true
  autoMerge: false
  checkTimeoutSeconds: 1800
  maxRepairAttempts: 1
  repairForbiddenPaths:
    - .github/workflows/**
    - agent-team.yaml
```

`autoMerge` must remain `false`. Repair is available only after failed checks,
is bounded, reruns local gates plus reviewer/tester verdicts, and refuses to
commit protected paths. GitHub operations use the locally authenticated `gh`
CLI.
