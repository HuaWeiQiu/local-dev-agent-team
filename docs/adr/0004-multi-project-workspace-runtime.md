# ADR 0004: Multi-Project Workspace Runtime

## Status

Accepted

## Context

The original control service binds one process, lease, event ledger, and UI to
one repository. Running several services works, but it gives users separate
ports and no safe project switcher. Sharing one supervisor or database across
repositories would make cancellation, retries, artifacts, and process ownership
ambiguous.

## Decision

Add an explicit `agent-team.workspace.yaml` manifest. Each entry has a stable
URL-safe project ID and a path to that project's `agent-team.yaml`. Relative
paths resolve from the workspace manifest directory.

A workspace service owns one independent project runtime per entry:

```text
workspace HTTP + React UI
  -> project route by stable ID
  -> project runtime
       -> project lease
       -> project RunSupervisor
       -> project SQLite ledger
       -> project runs/worktrees/artifacts
```

Project APIs live under `/api/projects/:projectId`. The existing unscoped
single-project API remains supported. A workspace rejects duplicate project IDs
and duplicate canonical repository roots before listening.

The workspace manifest is declarative in this phase. Adding or removing a
project requires editing the manifest and restarting the workspace service. The
browser cannot register arbitrary filesystem paths.

## Consequences

- One UI can switch between configured repositories on one loopback port.
- Run IDs need only be unique inside a project; every command remains scoped by
  project ID.
- A project that is already leased prevents the workspace from starting, rather
  than silently providing partial control.
- Closing the workspace closes every project supervisor and releases every
  project lease, even when one close operation fails.
- Dynamic registration and partial-degraded startup remain future decisions.
