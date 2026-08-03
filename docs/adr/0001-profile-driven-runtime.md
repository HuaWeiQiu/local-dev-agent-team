# ADR-0001: Profile-Driven Agent Runtime

- Status: Accepted
- Date: 2026-08-03

## Context

Software-development roles and agent products evolve independently. Binding an
architect to one vendor or a worker to one model would make orchestration
brittle and would prevent users from reusing authenticated local CLIs.

Existing Agent Orchestrator releases allow agent selection at spawn time but do
not provide a generic per-spawn model/profile contract for arbitrary specialist
roles. The project therefore needs its own stable selection layer.

## Decision

Represent execution as named profiles. A profile references an agent adapter
and supplies model, reasoning, permission, timeout, and native CLI-profile
settings. Roles reference allowed profiles and choose one default.

The core recognizes workflow capabilities, not vendors. Adapters translate a
resolved profile into an argument vector for a locally installed CLI.

Model values use one of two forms:

- `inherit`: use the CLI's configured default;
- any other string: pass the value to the CLI as an explicit model selector.

The adapter performs capability and optional active-model probes. Missing or
unavailable models fail the run unless the role explicitly declares a fallback
profile. Fallback is recorded and is never silent.

## Consequences

- A single role can switch between Codex, Claude Code, and future adapters.
- Different tasks can choose different price, latency, and reasoning profiles.
- Configuration remains portable without centralizing credentials.
- Adapter implementations must track CLI argument and output contracts.
- A real model probe may consume quota and is therefore opt-in.
