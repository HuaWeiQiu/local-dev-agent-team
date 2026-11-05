# Repository Guidance

## Scope

This repository implements a local-first multi-agent software-development
orchestrator. Keep roles, agent CLI adapters, models, permissions, and workflow
state separate.

## Commands

- Install dependencies with `pnpm install`.
- Type-check with `pnpm check`.
- Run tests with `pnpm test`.
- Build with `pnpm build`.

## Engineering Rules

- Do not invoke agent commands through a shell. Pass arguments directly to
  `spawn` so profile values cannot become shell syntax.
- Never persist authentication tokens in project configuration or run state.
- A model name is opaque to the orchestrator and is validated by its adapter.
- Deterministic checks can veto an LLM verdict. An LLM cannot override a
  failing command.
- Keep Git operations recoverable. Never force-push or delete a worktree
  without validating its recorded path and branch.
- Add or update tests for behavior changes.
- Compare two paths by `realpath`, never as strings. "Is this module the entry
  point", "is this file under that root" and "did the guard fire" all reduce to
  it, and one symlink is enough (`/tmp` -> `/private/tmp`) to make the string
  comparison false and the guard silently inert: exit 0, nothing checked.
