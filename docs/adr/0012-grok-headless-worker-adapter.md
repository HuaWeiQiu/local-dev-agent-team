# ADR 0012: Grok Headless Worker Adapter

## Status

Accepted

## Context

The local team needs to use the installed Grok CLI as its code-writing worker
while Codex remains responsible for orchestration, architecture, review, and
test analysis. Grok headless mode supports explicit models, reasoning effort,
filesystem sandboxes, tool filters, JSON Schema output, and usage reporting.

Grok headless mode does not read a prompt from piped stdin. It accepts the
prompt as a command argument or from a file. Command arguments would expose
task context through the process list and conflict with the adapter boundary
that keeps prompts out of command arguments. Grok can also discover compatible
Claude/Cursor MCP servers from user configuration unless that discovery is
disabled.

## Decision

Register a first-party `grok` local-process adapter. The adapter:

- uses an explicit managed prompt file rather than a prompt argument;
- creates that file with owner-only permissions in an isolated temporary
  directory and deletes the directory after the process exits;
- maps `read-only` to Grok's `read-only` sandbox and plan mode;
- maps `workspace-write` to Grok's `workspace` sandbox and non-interactive
  always-approve mode, while the workflow still supplies an isolated Git
  worktree;
- disables memory, child agents, and built-in web access because the control
  plane owns context, decomposition, and external access;
- uses the profile's optional `maxTurns` limit, defaulting to 24 when omitted;
- in `externalTools: deny` mode, disables Claude/Cursor MCP discovery and
  removes MCP discovery/invocation tools. It preserves the authenticated
  `GROK_HOME` while pointing the process home at the invocation's disposable
  private directory, so compatible user-home MCP sources are not discovered;
- uses Grok JSON output and JSON Schema structured output and records reported
  input, cached-input, and output tokens;
- accepts only `low`, `medium`, and `high` reasoning levels until the installed
  CLI advertises and is tested with additional values.

Codex separately supports `max` reasoning so an explicit
`gpt-5.6-sol` orchestrator profile can use it. Model names remain owned by their
CLI: Codex profiles use `gpt-5.6-sol`; the Grok worker uses `grok`. No model name
is translated across providers.

## Consequences

- Grok can implement workflow tasks without Claude Code credentials.
- User-level compatible MCP integrations are unavailable in the default deny
  mode, even if Grok can discover them interactively.
- Prompt-file lifecycle is now an explicit adapter transport invariant in
  addition to stdin delivery.
- Grok worker automation remains bounded by the worktree, OS sandbox, process
  timeout, task ownership, deterministic quality commands, and independent
  Codex review.
- `externalTools: inherit` remains an explicit worker-only opt-in and is not
  used by the repository's default role configuration.
- Workflow behavior is deliberately not hard-coded in the adapter. The worker
  role selects a repository-owned prompt file, which can be changed without
  modifying provider integration code.
