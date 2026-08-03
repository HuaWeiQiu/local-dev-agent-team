# Security Model

Agent output and repository content are untrusted. Local Dev Agent Team limits
what that output can decide, but it does not turn an autonomous coding CLI into
a security boundary.

## Enforced Controls

- Child processes receive argument arrays directly; no command is assembled
  through a shell.
- Adapter-managed model, permission, working-directory, and output flags cannot
  be overridden by profile arguments.
- Codex read-only roles use its read-only sandbox. Claude read-only roles use
  plan mode and expose only read, glob, and grep tools.
- Write-enabled workers operate only in isolated Git worktrees.
- Task paths are checked against the architect's declared ownership before a
  commit is accepted.
- Project commands and exit codes are recorded and can veto agent verdicts.
- Reviewer and tester are separate invocations from the worker.
- Retries, parallelism, process timeouts, and GitHub repairs are bounded.
- Automatic merge is rejected by configuration validation.
- Run artifacts and context are ignored by Git to reduce accidental disclosure.

## Credentials

The project neither requests nor persists model-provider tokens. Codex and
Claude Code inherit their own local authentication. GitHub commands inherit the
current `gh` login. Do not put tokens, environment dumps, or secrets in
`agent-team.yaml`, prompts, goals, or tracked files.

Agent child processes still inherit the parent process environment. Launch the
tool from a deliberately scoped environment when the repository handles
sensitive credentials. Prefer short-lived credentials and provider-side least
privilege.

## Human Boundary

Inspect the integration diff, generated pull request, CI logs, and unexpected
dependency changes before merging. Branch protection and required status checks
should be enabled on the remote repository. The project creates draft pull
requests by default and never auto-merges.

## Reporting

Do not open a public issue containing an exploitable secret or private
repository content. Use GitHub's private vulnerability reporting when enabled,
or contact the repository owner privately before disclosure.
