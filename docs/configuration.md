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
    timeoutSeconds: 1800
    args: []

  claude-reviewer:
    adapter: claude
    model: sonnet
    reasoning: high
    permission: read-only
    externalTools: deny
    timeoutSeconds: 900
```

| Field | Meaning |
| --- | --- |
| `adapter` | Registered adapter, currently `codex` or `claude`. |
| `executable` | Optional executable path/name instead of the adapter default. |
| `model` | `inherit` or a model name understood by that CLI. |
| `reasoning` | `low`, `medium`, `high`, `xhigh`; Claude also accepts `max`. |
| `permission` | `read-only` or `workspace-write`. |
| `externalTools` | `deny` (default) or `inherit` the Agent CLI's MCP configuration. |
| `nativeProfile` | Optional Codex CLI native profile. |
| `timeoutSeconds` | Maximum process duration for one invocation. |
| `args` | Extra non-reserved CLI arguments, passed without a shell. |

The orchestrator treats model names as opaque. `doctor --probe-models` makes a
small real request and is the authoritative availability check; it is opt-in
because it may consume quota. Reserved model, permission, directory, and
structured-output flags cannot be overridden through `args`.

`externalTools: deny` makes Codex ignore user configuration and marks the
invocation root untrusted so project configuration is disabled (authentication
is retained). It supplies Claude with a strict empty MCP configuration.
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
`tester`. A task plan may choose only a profile allowed by the worker role. A
run-level `--profile role=name` override is also checked against the allowlist.
Fallbacks are attempted in declared order and recorded in invocation artifacts;
there is no silent model fallback.

All non-worker role profiles must be read-only, including defaults, allowlists,
and fallbacks. Workers normally need `workspace-write`. The tester analyzes
deterministic test results and therefore remains read-only.

`promptFile` optionally replaces a role's bundled prompt with a path relative
to the repository root.

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

`maxParallel` limits one dependency-ready scheduling wave. Parallel tasks must
declare disjoint `ownedPaths`, and the plan is rejected when ownership overlaps.

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
