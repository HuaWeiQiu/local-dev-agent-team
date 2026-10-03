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
   When the strategy enables the architect advisor and the same normalized
   failure repeats on consecutive attempts, a read-only architect is consulted
   before the next attempt (see [architect-advisor.zh-CN.md](architect-advisor.zh-CN.md)).
9. Passing task commits merge into the integration branch in stable task-ID
   order. Remaining blocked tasks do not discard already merged work. Final
   project checks and the supervising controller run once more; a final
   escalate cannot veto merged work when the integration quality gate passed.
   With the advisor enabled, the architect first reviews the integrated result
   when the integration gate passed, and its advice is added to the final
   decision context.
10. A passing or partially successful run creates a durable final approval
    request and stops at `awaiting-human`. Approval moves it to
    `ready-to-merge`; publication, CI observation, repair, and completion
    remain separate explicit commands.

## Flow Templates

Every run follows a **flow template** — a small graph of nodes held as data in
`src/flow/templates.ts`, not as control flow in the runner. The template is
chosen when the run starts and persisted on the run (`flow`), so a resumed run
rebuilds the same graph.

| Template | Run nodes | Per-task nodes | Use |
| --- | --- | --- | --- |
| `quick` | plan (single task) → execute → final checks → deterministic decide → final approval | work → quality → commit | small, low-risk edits |
| `standard` | intake → explore → plan → plan approval → execute → final checks → advise → decide → final approval (optional nodes follow the strategy) | work → quality → review → test → commit | most requirements |
| `full` | `standard` with exploration, plan approval and architect advice forced on | same as `standard` | large or risky changes |

`quick` never calls a model reviewer: the deterministic quality commands are
the only gate, and nothing merges without them passing. Template choice order:
evolution evaluations (always `standard`) → the operator's choice in the run
launcher or API (`template`) → `workflow.template` in `agent-team.yaml` → the
deterministic router. The router uses plain rules over the goal text (risk
keywords, number of `T1…Tn` deliverables, goal length, small-change keywords);
no model takes part, and the reasons are stored as `flow.selected` and shown in
the run's **洞察 → 为什么** view.

`GET /api/runs/:id/flow` returns the folded node progress (`flow.node` events).

## Interventions

While an agent runs, the operator can act on it from the run page (or the API):

- **Steer** — send an extra instruction to a live agent
  (`POST /runs/:id/agents/:agentId/steer`).
- **Interrupt** — stop the current turn without killing the run
  (`…/interrupt`).
- **Answer** — respond when the agent asks the user a question (`…/answer`).
- **Edit plan / approve with edits** — change tasks, owned paths and acceptance
  commands at the plan approval gate (`POST /runs/:id/actions/edit-plan`).

Live control needs a session-capable adapter (`workflow.sessions: auto`; Codex
app-server and Claude stream-json today). Other CLIs fall back to one-shot
invocation and report the missing capabilities instead of failing. Every
intervention is written to the event ledger with the acting operator, and the
operator's messages appear in the transcript.

## Reliability

- **Stall watchdog** — an agent with no output for `workflow.stallSeconds`
  (default 600; paused while a tool call or a user question is in flight) is
  interrupted and nudged with a continuation prompt, up to
  `workflow.maxStallRecoveries` times; then it fails as a timeout.
  Each stall is recorded as `agent.stalled`.
- **Flaky quality rerun** — a failing quality command is rerun
  `workflow.flakyReruns` times from the failing command. A pass on rerun is
  recorded as `quality.flaky` and does not trigger rework. Timeouts are never
  rerun, and a command that keeps failing still vetoes the task.
- **Triage** — when the same normalized failure repeats, the flow records a
  `flow.triage` decision. `quick` stops after two identical failures instead of
  using every rework attempt; the architect advisor/Jev consult is unchanged.
- **Per-task budgets** — optional `workflow.taskBudget` caps agent invocations
  and minutes per task; a task over budget is `blocked` without ending the run.

## Visibility

Everything shown in the **洞察** tab is a read-only projection over the run
state, the event ledger and stored artifacts; it never changes run state.

- **为什么** — headline verdict, flow choice and per-task evidence.
- **成本** — tokens, duration and cost by role, task and profile
  (`GET /runs/:id/usage`).
- **对话** — per-agent session transcripts, including operator steering
  (`GET /runs/:id/transcripts`, `…/transcript?id=`).
- **回放** — ordered timeline of the run (`GET /runs/:id/replay`).
- **Diff** — each task's merged diff in the task detail
  (`GET /runs/:id/tasks/:taskId/diff`).

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
claims that a killed CLI process continued in place. Execution time and
per-task rework attempts accumulate across resume segments: the timeout is
prorated against the recorded elapsed time (an exhausted budget blocks the
resume), and a task that already consumed its rework limit stays blocked
instead of being granted a fresh budget.

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
