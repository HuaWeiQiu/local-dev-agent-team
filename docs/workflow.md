# Workflow

## Lifecycle

1. The controller turns the goal into a structured intake: scope, constraints,
   risks, and acceptance criteria.
2. The architect produces a validated dependency DAG with owned paths,
   acceptance commands, and optional worker profile choices.
3. The scheduler selects a dependency-ready wave whose paths do not overlap.
4. Each worker receives its own branch and Git worktree from the current
   integration commit.
5. Project checks run as deterministic processes. Reviewer and tester agents
   independently inspect the staged diff and recorded results.
6. Failed gates produce bounded feedback for the same worker. Escalation or an
   exhausted retry budget blocks the run.
7. Passing task commits merge into the integration branch in stable task-ID
   order. Final project checks and the supervising controller run once more.
8. A passing run stops at `awaiting-human`. Publication, CI observation,
   repair, and completion are separate explicit commands.

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

State is written after transitions and attempts. `agent-team status [run-id]`
provides inspection after interruption. Version 0.1 retains branches,
worktrees, logs, and state for diagnosis but does not yet offer automatic
resume; begin a new run after resolving the cause.

## Publication Lifecycle

`publish` pushes only a locally passing integration branch and creates or finds
its draft pull request. `checks` reads GitHub check state. `repair` is allowed
only from `ci-failed`, makes at most the configured number of attempts, applies
the same local review/test gates, and pushes a normal commit. `complete` merely
records that GitHub reports the pull request merged.

The tool never force-pushes, approves its own pull request, enables auto-merge,
or merges for the user.
