# Configuration

`agent-team.yaml` is the only project configuration file. The CLI searches the
current directory and its parents, or accepts an explicit path with `--config`.
Validate it before every first run:

```bash
agent-team validate
agent-team profiles
agent-team doctor
```

## Profiles

A profile is a reusable execution configuration, independent of role:

```yaml
profiles:
  codex-worker-fast:
    adapter: codex
    model: inherit
    reasoning: medium
    permission: workspace-write
    timeoutSeconds: 1800
    args: []

  claude-reviewer:
    adapter: claude
    model: sonnet
    reasoning: high
    permission: read-only
    timeoutSeconds: 900
```

| Field | Meaning |
| --- | --- |
| `adapter` | Registered adapter, currently `codex` or `claude`. |
| `executable` | Optional executable path/name instead of the adapter default. |
| `model` | `inherit` or a model name understood by that CLI. |
| `reasoning` | `low`, `medium`, `high`, `xhigh`; Claude also accepts `max`. |
| `permission` | `read-only` or `workspace-write`. |
| `nativeProfile` | Optional Codex CLI native profile. |
| `timeoutSeconds` | Maximum process duration for one invocation. |
| `args` | Extra non-reserved CLI arguments, passed without a shell. |

The orchestrator treats model names as opaque. `doctor --probe-models` makes a
small real request and is the authoritative availability check; it is opt-in
because it may consume quota. Reserved model, permission, directory, and
structured-output flags cannot be overridden through `args`.

## Role Policy

Every required role maps to one default profile and an allowlist:

```yaml
roles:
  reviewer:
    defaultProfile: claude-reviewer
    allowedProfiles: [claude-reviewer, codex-planner]
    fallbackProfiles: [codex-planner]
```

Required roles are `orchestrator`, `architect`, `worker`, `reviewer`, and
`tester`. A task plan may choose only a profile allowed by the worker role. A
run-level `--profile role=name` override is also checked against the allowlist.
Fallbacks are attempted in declared order and recorded in invocation artifacts;
there is no silent model fallback.

Orchestrator, architect, and reviewer default profiles must be read-only.
Workers normally need `workspace-write`. The tester analyzes deterministic test
results and therefore can stay read-only.

`promptFile` optionally replaces a role's bundled prompt with a path relative
to the repository root.

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
