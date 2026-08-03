# Local Dev Agent Team

Local Dev Agent Team is a local-first orchestrator for software-development
agents. It reuses installed agent CLIs, isolates implementation work in Git
worktrees, and uses GitHub pull requests and checks as an optional audit and
quality layer.

The project is built around one rule:

```text
role != agent CLI != model
```

An architect can run through Codex today and Claude Code tomorrow. A worker can
use a different model for one task without changing its role contract. Models
remain owned by the selected CLI; this project passes through configured model
names and verifies that the CLI can launch them.

## Target Workflow

```text
goal
  -> orchestrator
  -> architect
  -> task DAG
  -> isolated workers
  -> deterministic checks + tester + reviewer
  -> rework or integration
  -> GitHub pull request
  -> human merge
```

The first release targets Codex CLI and Claude Code. The adapter boundary is
open so other non-interactive coding CLIs can be added without changing role or
workflow code.

## Status

Active implementation. See [Architecture](docs/architecture.md) and
[ADR-0001](docs/adr/0001-profile-driven-runtime.md) for the frozen design
contract.

## Safety Defaults

- Orchestrator, architect, and reviewer profiles are read-only by default.
- Workers receive write access only to their isolated worktree.
- Tests are executed as real processes; agents do not self-report success.
- Automatic merge is disabled.
- Secrets are inherited from the installed CLI and are never copied into this
  repository.

## License

MIT
