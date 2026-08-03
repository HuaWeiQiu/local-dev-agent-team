# Architecture

## Design Goals

Local Dev Agent Team coordinates existing coding agents without becoming a
model provider or authentication broker. The control plane owns workflow
state, Git isolation, quality gates, retry limits, and GitHub publication. Agent
CLIs own model access, authentication, tool execution, and model-specific
configuration.

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

## Configuration Layers

```text
project defaults
  -> role default profile
  -> task profile override
  -> explicit human run override
```

The resolved profile contains an adapter name, optional model, reasoning level,
permission mode, optional native CLI profile, timeout, and safe argument list.
The scheduler may select only profiles listed by the role policy.

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
  -> completed
```

Any state can transition to `blocked` on a non-recoverable infrastructure or
policy failure. State is persisted after every transition so an interrupted run
can resume without asking agents to reconstruct history.

## Git Isolation

Each worker receives a branch and worktree created from the current integration
commit. Workers in the same scheduling wave must have disjoint declared path
ownership. Passing worker commits are merged into the integration branch in a
deterministic order. The primary working tree is never used for agent edits.

## Trust Boundaries

- Agent text is untrusted data.
- Profile arguments are passed to child processes without a shell.
- Model names are opaque strings, not executable fragments.
- Reviewer and tester sessions cannot approve their own implementation.
- The worker cannot convert a failed command into a passing result.
- GitHub publication is opt-in and never implies automatic merge.
