# Security Model

Agent output and repository content are untrusted. Local Dev Agent Team limits
what that output can decide, but it does not turn an autonomous coding CLI into
a security boundary.

## Enforced Controls

- Child processes receive argument arrays directly; no command is assembled
  through a shell.
- Adapter-managed model, permission, working-directory, and output flags cannot
  be overridden by profile arguments.
- External MCP tools are denied by default. `externalTools: inherit` is an
  explicit project-owner opt-in available only to workspace-write workers;
  external tools are not assumed to obey the CLI filesystem sandbox. Codex deny
  mode disables user and project configuration without weakening
  enterprise-managed host policy.
- Codex read-only roles use its read-only sandbox. Claude read-only roles use
  plan mode and expose only read, glob, and grep tools. Managed Grok workers use
  the workspace sandbox, an isolated Git worktree, no memory/subagents/Web, and
  an explicit built-in tool set.
- Only the worker role may allow workspace-write profiles, and diagnostic
  `invoke` calls are always read-only.
- Write-enabled workers operate only in isolated Git worktrees.
- Task paths are checked against the architect's declared ownership before a
  commit is accepted.
- Project commands and exit codes are recorded and can veto agent verdicts.
- Reviewer and tester are separate invocations from the worker.
- Retries, parallelism, process timeouts, and GitHub repairs are bounded.
- Strategy budgets bound active execution time, agent invocation count, and
  cumulative run artifacts. Budget exhaustion is a blocking policy failure,
  not a reason to silently switch providers. Per-stream output limits truncate
  captured data while continuing to drain the managed child process.
- Automatic merge is rejected by configuration validation.
- Run artifacts and context are ignored by Git to reduce accidental disclosure.
- The control service binds only to an explicit loopback host, rejects
  cross-origin browser requests, and holds a per-project process lease.
- Workspace discovery exposes only declaratively configured projects. Commands,
  cancellation, retries, and event streams remain scoped to one project runtime.
- Every strategy retains a mandatory final human approval gate. Approval and
  checkpoint recovery commands are serialized per run and cannot publish or merge.
- The workbench is served from the same origin with a restrictive content
  security policy; it cannot load remote scripts or frame other content.
- Managed Unix child processes use a separate process group so cancellation and
  timeout escalation reach their descendants.
- The desktop shell never places the control-service session token in the node
  sidecar's environment. It writes the token to a `0600` file under the app
  data directory (`runtime/session-token`, rewritten on every startup) and
  passes only the path via `AGENT_TEAM_SESSION_TOKEN_FILE`, so the secret does
  not appear in `ps eww` output and cannot ride along through environment
  inheritance. The direct `AGENT_TEAM_SESSION_TOKEN` variable remains
  supported for CLI `serve` and other embedders; the file takes precedence,
  and the service refuses to start when the file is missing, empty, or not
  `0600`.
- Child processes never inherit `AGENT_TEAM_*` orchestrator variables (most
  notably the control-service session token): `src/process/env.ts` strips them
  by denylist before spawn while leaving PATH/HOME/proxy variables intact. Any
  occurrence of those secret values in captured child output is replaced with
  `[redacted]` before it can reach persisted logs or the event stream.
- GitHub repair pushes require explicit human confirmation. `agent-team repair`
  prints the exact remote, branch, commit message, and changed-file summary and
  asks interactively before pushing; a non-interactive session refuses to push
  unless `--yes` is passed explicitly.

## Adapter Enforcement Caveats

- Codex, Claude, and Grok enforce read-only or workspace boundaries at the
  execution layer (sandbox, plan mode, managed tool set). The Kimi CLI has no
  non-interactive flag that enforces read-only at the execution layer, so Kimi
  read-only roles are constrained by prompt text only. Binding a
  read-only-designed role (orchestrator, architect, researcher, reviewer,
  tester) to a Kimi profile remains allowed for compatibility but is surfaced
  as an explicit adapter warning; do not treat it as a sandbox boundary.

## Credentials

The project neither requests nor persists model-provider tokens. Codex, Grok,
and Claude Code inherit their own local authentication. GitHub commands inherit the
current `gh` login. Do not put tokens, environment dumps, or secrets in
`agent-team.yaml`, prompts, goals, or tracked files.

Agent child processes still inherit the parent process environment. Launch the
tool from a deliberately scoped environment when the repository handles
sensitive credentials. Prefer short-lived credentials and provider-side least
privilege.

Approval `actor` values are supplied by the local caller for audit readability;
the loopback service does not authenticate OS or organizational identity. Use a
separately authenticated gateway before exposing the control plane beyond one
trusted workstation.

The session-token file narrows token exposure to the filesystem: `0600` keeps
other OS users out, but processes running under the same uid can still read the
file. That residual is a platform boundary of same-uid isolation, not something
the transport choice can close.

The service does not expose an A2A endpoint. A2A requires an authenticated,
authorized HTTPS boundary; adding a well-known Agent Card alone would advertise
an unsafe capability and is therefore intentionally rejected by the design.

OTLP JSON export is read-only and served by the same loopback, same-origin
control plane. It may contain role, model, profile, error, usage, and event
metadata. Treat exported traces as repository-operational data and do not send
them to an external collector without an explicit retention and access policy.

## Human Boundary

Inspect the integration diff, generated pull request, CI logs, and unexpected
dependency changes before merging. Branch protection and required status checks
should be enabled on the remote repository. The project creates draft pull
requests by default and never auto-merges.

## Bounded Evolution (Phases 1-6)

The evolution domain, durable application layer, and bounded automation owner
are an additional trust boundary, not a path to unbounded self-modification:

- A trusted integration must build the trust context from configured role
  `promptFile` paths and `allowedProfiles`, not from self-declared candidate
  policy alone. Durable open derives that context only from the loaded project
  role configuration; the pure catalog validates the context supplied by its
  caller but does not load or authenticate configuration itself.
- Role-prompt candidates store a repository-relative path and content digest.
  Phase 3 accepts matching UTF-8 bytes only at proposal ingress and stores them
  in a local immutable object; normal apply/rollback never accept caller paths
  or bytes. Prompt objects and prompt files must not contain secrets.
- Evaluation requires deterministic evidence; any deterministic failure vetoes
  advisory (including LLM) approval. The Phase-4 HTTP service never accepts
  evidence or run IDs from the browser: the coordinator emits a fixed,
  candidate-bound structural preflight. Passing means current trust, schema,
  prompt object integrity, and target/Git safety checks passed; it does not mean
  the candidate was executed or behaviorally validated. Promotion,
  rejection, and rollback need a non-empty `actor` and `reason`. These fields
  are audit labels, not authenticated proof of a human identity; the calling
  control plane must authenticate the operator and bind that identity.
  Evaluation persists a versioned source: legacy or library-supplied evidence
  defaults to `external` and cannot cross the Phase-4 HTTP promotion boundary as
  `server-structural-preflight-v1`.
- The Phase-5 React/Tauri workbench is an untrusted intent client, not an
  application authority. It never asks for target paths, digests, evidence,
  operator identity, or apply bytes. Preview tokens and idempotency keys remain
  in short-lived component memory and are cleared on project/target/revision
  changes; every mutation is followed by an authoritative snapshot read.
- Proposal capability flags force candidate self-authorization, network
  publication, and secret storage to remain false. Phase 6 automation is
  authorized only by static project config and the server-owned controller.
- Catalog mutations are atomic: failed validation leaves proposals, audit
  records, and active pointers unchanged. Rollback is limited to the currently
  active promotion and uses only internal promotion provenance.
- Durable reopen rejects symlinked state paths, malformed or unknown fields,
  stale trust, inconsistent revisions, forged audit/provenance chains, and
  active pointers that cannot be reproduced by ordered audit replay. The
  payload digest detects corruption but is not authentication against an
  attacker who can rewrite both the document and its digest.
- Durable writes fully revalidate and compare the primary document before using
  a `0600` temporary file followed by file fsync, rename, and directory fsync.
  Same-process catalog instances share a per-file commit queue before the disk
  revision CAS. Cross-process ownership belongs to the project runtime control
  lease; the low-level Phase-2 catalog is not itself a filesystem lock.
  The runtime writes and fsyncs a complete owner record before atomically
  publishing it with a same-directory hard link. Invalid, incomplete, or
  well-formed stale lease files fail closed and require an operator to verify
  that no service owns the project before removing `control.lock`; ownership is
  never stolen automatically.
  A directory-fsync failure after rename seals the instance until reopen because
  durability is indeterminate; it is never treated as a successful memory commit.
- Opening the Phase-3 application coordinator claims the catalog instance's
  mutation lease. Previews are opaque, expiring, operator/revision/target-bound
  capabilities; returned records are cloned and frozen. Commands are durably
  idempotent and cannot supply evaluation evidence, promotion provenance, or
  apply-time material.
- Prompt application requires a quiescent project, a clean primary worktree, an
  existing configured tracked Markdown file, symlink-safe parents, an atomic
  same-directory write that preserves permissions, and an exact one-file
  forward Git commit. Strategy application can mutate only custom blueprints
  with exact expected-before state; config-defined strategies remain read-only.
- Crash recovery validates the exact expected catalog audit and active pointer.
  A prompt is considered applied only when Git HEAD proves a clean direct
  one-file commit from the journaled base. A pre-commit crash restores the old
  object and records an abort; unrelated revisions or commits fail closed.
- Coordinator-owned promotion and rollback audits carry an optional
  `applicationCommandId` for backward-compatible storage and require exact
  two-way ownership for all newly controlled mutations. Successful completions
  must own the catalog audit, aborted commands must not, and command result
  proposal snapshots must be immutable-history prefixes of the catalog proposal.
- The Phase-4 HTTP surface requires an authenticated local session for reads and
  the exact actual loopback Origin for writes. Operator identity is derived from
  the session token. Browser bodies cannot select policy, path, digest, evidence,
  actor, timestamps, or confirm-time apply bytes. The client supplies only a
  format-bounded idempotency key; internal command bindings remain server-owned.
  All service and queued run operations are sealed and drained before the runtime
  releases its control lease.
- Legacy promoted proposals without application proof can be adopted over HTTP
  only when the exact live target already matches. Any legacy apply, including
  optional digest-bound prompt bytes, is restricted to the offline CLI while it
  owns the project control lease.
- The Phase-6 automatic strategy loop requires explicit project configuration
  and an operator click. Its proposer profile is read-only. One automation owner
  blocks ordinary runs, run actions, and target writes until the bounded loop
  finishes or is stopped. Evaluation evidence is derived only from persisted run
  outcomes; agent text and browser-supplied evidence cannot authorize promotion.
  Requested cycles cannot exceed the configured 1-10 limit, repeated evaluation
  is capped at two, and consecutive non-improvement stops the loop early.
- All proposer fallbacks are read-only, automatic mode requires at least one
  deterministic quality command, and a candidate cannot increase incumbent resource,
  retry, parallelism, or timeout budgets. Only a completed server-owned evaluation
  run with exact goal/strategy provenance can pass.
- Proposer invocations use persisted run state and tighter output/artifact/deadline
  budgets, so their artifacts participate in normal cleanup. Crash-orphaned shadow
  strategies are removed only with matching automatic origin, derived proposal ID,
  and exact definition evidence; name prefixes alone never authorize deletion.
- Start authorization is durably idempotent and bound to the authenticated local
  session operator and requested cycle count. Promotion/rejection audits preserve
  that operator; a process restart cannot replay an accepted key into a new loop.
- Automatic evaluation runs never publish or merge. Process start/restart cannot
  start a loop; only an already applied winner is restored as runtime default.
- `application-state.json` and prompt objects use repository-local strict
  documents/paths and POSIX `0600` files. Digests detect corruption, not a
  malicious local writer. Phase 3 remains single-process and provides no
  cross-process lock.

Grok workers used by the default workflow remain bounded by profile and adapter
policy (`maxTurns`, workspace-write only inside an isolated worktree,
`externalTools: deny`, disabled memory/subagents/Web, managed MCP deny mode)
and by strategy budgets such as strict sequential execution and
`maxReworkAttempts: 2`. Those controls are independent of the evolution catalog.

Details: [evolution-phase-1.zh-CN.md](./evolution-phase-1.zh-CN.md),
[ADR 0013](./adr/0013-bounded-evolution-domain-catalog-boundary.md), and
[ADR 0014](./adr/0014-durable-evolution-catalog.md), and
[ADR 0015](./adr/0015-controlled-evolution-application.md), and
[ADR 0016](./adr/0016-evolution-control-plane.md), and
[ADR 0017](./adr/0017-bounded-automatic-strategy-evolution.md).

## Known Limitations And Planned Hardening

These items are deliberate deferrals (new capabilities, not bug fixes).
Each needs its own design review before implementation:

- **Approval second factor.** Human approval currently relies on the
  session cookie plus the `actor` label. The environment scrubbing and
  token-file delivery above shrink the exposure, but a same-uid process
  can still read the token file. The planned fix is a per-approval nonce
  delivered only to the authenticated UI (or a Tauri-native approval
  channel that never crosses HTTP), so an agent process cannot approve
  its own gates even if it obtains the session token.
- **Windows process-group kill.** `runProcess` uses detached POSIX
  process groups for SIGTERM/SIGKILL escalation; on Windows only the
  direct child is terminated and agent CLI grandchildren may outlive a
  cancellation. macOS and Linux are unaffected.
- **Same-uid local boundary.** A process running as the same OS user can
  read the 0600 token file and inspect this service's memory. The token
  file only isolates other OS users; full same-uid isolation would
  require running agents under separate OS accounts or containers (see
  the sandbox track in the completeness roadmap).

## Reporting

Do not open a public issue containing an exploitable secret or private
repository content. Use GitHub's private vulnerability reporting when enabled,
or contact the repository owner privately before disclosure.
