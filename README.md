# Local Dev Agent Team

Local-first orchestration for a software-development agent team. It reuses the
agent CLIs already authenticated on your machine and gives each role an
independent CLI, model, reasoning level, and permission profile.

```text
goal -> controller -> architect -> worker DAG
     -> deterministic checks + reviewer + tester
     -> bounded rework -> integration branch -> draft PR -> human merge
```

The core rule is `role != agent CLI != model`. A reviewer can use Claude Code,
a worker can use Codex, and either role can switch models without changing the
workflow. `model: inherit` uses that CLI's configured default; any other value
is passed to the selected CLI as an explicit model selector.

## What It Provides

- One supervising orchestrator, one architect, one reviewer, one tester, and
  one or more dependency-aware workers.
- Codex CLI and Claude Code adapters with a stable extension boundary for more
  CLIs.
- Isolated Git branches and worktrees for every worker task.
- Structured contracts for plans, reviews, test verdicts, and final decisions.
- Real project commands as hard gates; an agent cannot declare a failed test
  successful.
- Bounded rework and explicit escalation instead of unbounded agent loops.
- Optional draft pull request publication, GitHub Actions monitoring, and one
  bounded CI-repair attempt. Automatic merge is intentionally unsupported.

## Requirements

- Node.js 20 or newer, pnpm, and Git.
- At least one supported agent CLI installed and authenticated:
  [Codex CLI](https://developers.openai.com/codex/cli) or Claude Code.
- GitHub CLI authenticated with repository access when using `publish`,
  `checks`, `repair`, or `complete`.

No API keys are copied into this project. Child processes reuse each CLI's own
authentication and configuration.

## Install

```bash
git clone https://github.com/HuaWeiQiu/local-dev-agent-team.git
cd local-dev-agent-team
pnpm install
pnpm build
pnpm link --global
```

You can skip the global link and run `pnpm dev -- <command>` from this checkout.

## Quick Start

From the Git repository you want the team to modify:

```bash
agent-team init
# Edit agent-team.yaml: profiles, role policy, and real project checks.
agent-team validate
agent-team profiles
agent-team doctor
agent-team doctor --profile codex-worker --probe-models
agent-team run --goal "Add cursor pagination to the users API"
agent-team status
```

Override a role for one run without editing the configuration:

```bash
agent-team run \
  --goal "Add cursor pagination to the users API" \
  --profile architect=claude-architect \
  --profile worker=codex-worker
```

After a local run reaches `awaiting-human`, publication remains explicit:

```bash
agent-team publish <run-id> --wait
agent-team checks <run-id> --watch
agent-team repair <run-id>       # only after a failed GitHub check
agent-team complete <run-id>     # only after a human merged the PR
```

See [configuration](docs/configuration.md), [workflow](docs/workflow.md),
[security](docs/security.md), and [architecture](docs/architecture.md) for the
full operating contract. Start from [agent-team.example.yaml](agent-team.example.yaml).

## Current Scope

Version 0.1 is deliberately narrow: local software-development repositories,
Codex CLI and Claude Code, Git worktree isolation, and GitHub PR quality gates.
Run state is durable and inspectable, but interrupted runs are not automatically
resumed yet. Other agent CLIs can be added through the adapter interface.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Contributions are described in [CONTRIBUTING.md](CONTRIBUTING.md). Licensed
under the MIT License.
