# ADR 0010: Local Delivery Evidence and Run Retention

## Status

Accepted

## Context

The control service already persists run state, review results, quality-command
logs, agent output, checkpoints, and approvals. The workbench exposes parts of
that information in several views, but an operator cannot inspect one coherent
delivery record or safely reclaim old local run data.

Run artifacts may contain prompts, source diffs, command output, and other
project-sensitive material. A generic file-serving endpoint would turn the
loopback control service into an arbitrary local-file reader. Cleanup also has
to preserve runs that can still be resumed, approved, published, or repaired.

## Decision

The control plane owns a read-only evidence projection for each run. It combines
the persisted state with:

- deterministic delivery checks for task integration, final quality, final
  decision, and final approval;
- an integration diff between the recorded base commit and the latest durable
  checkpoint commit;
- a bounded manifest of regular files below that run's `artifacts/` directory;
- bounded text previews for an allowlist of evidence file extensions.

Run IDs and artifact-relative paths are validated before filesystem access.
Symlinks and paths outside the selected run are never followed. Responses do
not expose absolute project, worktree, configuration, or state-directory paths.
Diffs and file previews are truncated at documented server limits.

History cleanup is an explicit two-step operation. The server first returns a
short-lived preview token and exact candidate list. A second request consumes
that token. Before deletion, every candidate is revalidated against its status
and update timestamp. Only `completed`, `cancelled`, and `blocked` runs older
than the requested cutoff are eligible. Active, interrupted, approval-boundary,
publication, CI, and repairable runs are always retained. A run referenced as
the parent of an existing or currently starting retry is retained as lineage
evidence even when its own status and age would otherwise be eligible.

Each run directory is renamed into a quarantine name before its SQLite events
are deleted. If event deletion fails, the directory is restored. The quarantined
directory is removed only after the event deletion succeeds. Cleanup never
touches repositories, branches, worktrees, configuration files, or custom
strategy blueprints.

## Consequences

- The workbench can present a single approval-oriented evidence view without
  making browser code responsible for filesystem policy.
- Operators can filter noisy run histories and reclaim local evidence with a
  reviewable candidate list and an expiring confirmation boundary.
- Recoverable and actionable states remain available even when they are old.
- Cleanup is intentionally local and irreversible after confirmation; remote
  retention, authentication, A2A transport, and cloud artifact storage remain
  outside this phase.
