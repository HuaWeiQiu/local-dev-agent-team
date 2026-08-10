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

## Reporting

Do not open a public issue containing an exploitable secret or private
repository content. Use GitHub's private vulnerability reporting when enabled,
or contact the repository owner privately before disclosure.
