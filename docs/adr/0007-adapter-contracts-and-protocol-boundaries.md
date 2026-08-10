# ADR 0007: Adapter Contracts And Protocol Boundaries

## Status

Accepted

## Context

The built-in Codex and Claude adapters shared TypeScript method signatures but
did not publish machine-readable capabilities. A future adapter could change
the managed working directory, move the prompt into command arguments, ignore
the configured timeout, or claim unsupported permission and structured-output
modes. Role configuration also checked only selected default profiles, leaving
write-enabled allowlist and diagnostic paths insufficiently constrained.

MCP and A2A solve different problems. MCP connects an LLM host to external
context and tools; A2A connects independent agents through discovery and a
remote task lifecycle. Treating either protocol as a generic adapter flag would
blur process ownership, consent, authentication, and authorization.

## Decision

Every adapter implements contract version 1 and declares its local-process
transport, reasoning levels, permissions, external-tools policies,
structured-output support, and usage fields. The registry rejects invalid names,
duplicate adapters, empty or duplicate capability declarations, and unsupported
contract versions.

Before spawn, the control plane verifies that the profile names the selected
adapter, requested reasoning and permission modes are supported, the managed
working directory and output path are unchanged, the prompt is delivered by
the adapter's managed stdin-or-file transport, and the process timeout does not
exceed the profile limit. Adapter-owned
arguments cannot be overridden through profile extras.

Only `worker` may allow `workspace-write` profiles. Every other role's default,
allowlist, and fallback profiles must be read-only. `agent-team invoke` is a
diagnostic path and always rejects workspace-write profiles.

Profiles add `externalTools` with a default of `deny`. In deny mode, the Codex
adapter uses `--ignore-user-config`, fixes the invocation root, and marks that
root untrusted while retaining authentication; the Claude adapter uses a strict
empty MCP configuration. An empty Codex `mcp_servers` override is insufficient
because Codex merges it with configured servers. `inherit` is the explicit
opt-in that lets the Agent CLI load its provider-managed MCP configuration. The
orchestrator is not an MCP Host, does not store MCP credentials, and does not
authorize MCP tools. Because external tools do not necessarily obey the CLI
filesystem sandbox, read-only profiles cannot use `inherit`; only
workspace-write worker profiles may opt in. Codex native profiles require
`inherit` because they are user configuration. Enterprise-managed configuration
remains host-admin policy and is not weakened by the control plane.

The current control service does not expose A2A. A2A 1.0 requires a remote
identity, authenticated and authorized task operations, production TLS, and
input/rate controls that the loopback same-origin service intentionally lacks.
Future A2A support must use the official SDK behind a separate authenticated
gateway rather than relabeling the existing REST API.

`agent-team interop --json`, `GET /api/interop`, and the project-scoped
workspace equivalent expose adapter contracts plus the MCP and A2A boundary.

## Consequences

- New adapters fail closed when their declared or generated process contract is
  inconsistent.
- Read-only control roles cannot acquire write permission through an allowlist,
  fallback, strategy, or diagnostic invocation.
- Existing profiles that omit `externalTools` become deny-by-default without a
  configuration migration.
- Projects that intentionally depend on provider-configured MCP servers must
  opt in on a workspace-write worker profile with `externalTools: inherit`.
- No MCP or A2A SDK dependency is added until this process actually implements
  one of those protocol endpoints.

## References

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
