# Contributing

Local Dev Agent Team is intentionally conservative around process execution,
Git mutation, and trust boundaries. Keep changes small and include regression
tests for behavior changes.

## Setup

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Use Node.js 20 or newer. Tests must not require a paid model call or live GitHub
repository; adapter and GitHub boundaries should be faked. Active local checks
are available separately through `agent-team doctor --probe-models`.

## Pull Requests

- Explain the behavior and risk being changed.
- Add focused tests, especially for argument construction, configuration
  policy, task scheduling, path ownership, and Git lifecycle behavior.
- Do not introduce shell command construction for agent or quality processes.
- Do not weaken read-only defaults, bounded retries, protected repair paths, or
  the human merge requirement.
- Update configuration schema, examples, and docs together when adding fields.

New adapters implement `AgentAdapter`, translate the generic profile into one
CLI's non-interactive invocation, parse its output, and expose executable,
authentication, capability, and optional model probes through `doctor`.
