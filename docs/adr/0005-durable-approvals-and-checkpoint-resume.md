# ADR 0005: Durable Approvals And Checkpoint Resume

## Status

Accepted

## Context

`awaiting-human` originally described a boundary but had no request/response
contract. A service restart could preserve the label, yet no human could
approve or reject it through the control plane. Interrupted agent processes
also cannot be resumed safely from arbitrary instruction or tool state.

## Decision

Every strategy requires a final approval gate and may additionally require a
plan approval before workers start. Approval requests and responses are stored
inside the run snapshot and mirrored to the durable event ledger. A
response includes the request ID, actor, decision, reason, and timestamp. Each
request has a bounded expiry.

The workflow writes immutable checkpoints after planning, after each complete
worker wave is integrated, after all tasks are integrated, and after final
local gates pass. A checkpoint records the integration commit and completed
task IDs.

In-place continuation is allowed only when the integration worktree is clean
and its `HEAD` matches a persisted checkpoint. An interrupted partial wave is
not considered complete: its branches and worktrees remain available as
abandoned recovery evidence, while incomplete tasks restart on new generated
branches. The system never claims to continue a killed CLI process.

Final approval moves the run to `ready-to-merge`; it does not publish, merge,
or bypass GitHub checks. Rejection moves the run to `blocked`. A final approval
is required before publication.

## Consequences

- Pending approvals survive service restarts and remain actionable.
- Human decisions are explicit, attributable, expiring, and auditable.
- Active snapshots without a current supervisor owner become interrupted,
  including legacy command-line snapshots that have no owner ID.
- Recovery may repeat an incomplete task wave, but never repeats a checkpointed
  integration merge.
- Uncheckpointed branches and worktrees are retained for diagnosis and may
  consume disk until a later retention policy removes them.
- Approval and recovery actions must be serialized per run by the supervisor.
