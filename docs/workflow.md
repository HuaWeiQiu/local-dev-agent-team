# Workflow

## Lifecycle

1. If the goal already names `T1`–`Tn` (or `P0.x`) and a concrete path for
   each, the controller builds that DAG itself and skips the architect.
   Otherwise the controller turns the goal into a structured intake.
2. Optional explore stage: the **researcher** (技术研究员) performs read-only
   technical research and injects a structured summary into planning.
3. The architect produces a validated dependency DAG with owned paths and
   optional worker profile choices. A rejected plan is retried once, then
   replaced by a deterministic fallback when the goal is explicit enough.
   A vague “根据交接文档完成任务” expands into a Photoshop / HANDOFF packet
   only when this repository actually contains that handover.
4. Human plan approval runs only when the strategy gates `plan`. Agent-authored
   `acceptanceCommands` do not force an extra stop.
5. The scheduler selects a dependency-ready wave whose paths do not overlap.
   A sibling failure does not abort work that already passed quality gates.
6. Each worker receives its own branch and Git worktree from the current
   integration commit. Isolated worktrees install dependencies only when a
   lockfile is present.
7. Project checks run as deterministic processes. Reviewer and tester agents
   independently inspect the staged diff and recorded results. Placeholder
   verdicts are retried once; a second placeholder, or an escalate on a
   docs-only task, yields to a passing quality gate.
8. Failed gates produce bounded feedback for the same worker. Escalation with a
   failed quality gate, or an exhausted retry budget, blocks that task only.
9. Passing task commits merge into the integration branch in stable task-ID
   order. Remaining blocked tasks do not discard already merged work. Final
   project checks and the supervising controller run once more; a final
   escalate cannot veto merged work when the integration quality gate passed.
10. A passing or partially successful run creates a durable final approval
    request and stops at `awaiting-human`. Approval moves it to
    `ready-to-merge`; publication, CI observation, repair, and completion
    remain separate explicit commands.

## Git Layout

For run `<run-id>` the tool creates:

```text
agent-team/<run-id>/integration
agent-team/<run-id>/<task-id>
.agent-team/worktrees/<run-id>/integration
.agent-team/worktrees/<run-id>/<task-id>
```

The user's primary working tree is never handed to a write-enabled agent. Git
must be clean before the workflow starts. Worker branches are kept recoverable
until their passing commits have merged; worktrees are then removed with Git's
normal worktree command.

## Durable Evidence

Run state and artifacts live under `.agent-team/` and are ignored by Git:

```text
.agent-team/runs/<run-id>.json
.agent-team/runs/<run-id>/.../context.json
.agent-team/runs/<run-id>/.../stdout.log
.agent-team/runs/<run-id>/.../stderr.log
```

State is written after transitions and attempts. The workflow also records the
integration commit and completed task IDs after planning, each fully integrated
worker wave, all tasks, and final local gates. `agent-team status [run-id]`
shows the latest checkpoint and pending approval IDs.

Runs started through `agent-team serve` also append ordered events to
`.agent-team/control.sqlite`. SSE clients reconnect with the last observed
sequence. Agent stdout and stderr remain available as artifact logs; event
chunks provide live progress without making the browser the process owner.
The workbench derives its Agent activity view from controller-owned invocation
events. Codex-native child lifecycle snapshots, when emitted by the managed CLI,
are nested under their owning invocation and retain only thread/path/status/model
metadata. The service does not scan independent Codex session stores or attach
unrelated terminal sessions to a run.
Captured process output and cumulative artifacts are bounded by the selected
strategy. The run snapshot records invocation counts, durations, output bytes,
truncation, artifact bytes, and any provider-reported token or USD usage.

Every retained event includes trace and span IDs. The run telemetry endpoint
projects those rows into OTLP/HTTP JSON `resourceSpans`; it does not send data
outside the workstation.
An interrupted run can resume only from a matching checkpoint. A partial wave
is abandoned as evidence and its incomplete tasks restart on new branches.
Cancelled or blocked runs can still be retried as new linked runs. Neither path
claims that a killed CLI process continued in place. Each resume restarts the
full execution timeout budget; the deadline is not prorated across attempts.

Approval requests and responses are persisted in the run snapshot and emitted
to the ordered event ledger. A response records decision, actor, reason, and
time. The actor is a local audit assertion, not authenticated identity.

Plan approval is required exactly when the selected strategy gates `plan`.
`acceptanceCommands` do not add a forced plan stop: they are deterministic
commands from the operator's project configuration, and the quality gates
already refuse to trust any LLM verdict that contradicts their exit codes.
The approval summary states which tasks the gate covers.

## Publication Lifecycle

`publish` pushes only a locally passing integration branch and creates or finds
its draft pull request. `checks` reads GitHub check state. `repair` is allowed
only from `ci-failed`, makes at most the configured number of attempts, applies
the same local review/test gates, and pushes a normal commit. `complete` merely
records that GitHub reports the pull request merged.

The tool never force-pushes, approves its own pull request, enables auto-merge,
or merges for the user.
