# ADR 0011: Desktop Shell And Runtime Lifecycle

## Status

Accepted

## Context

The browser workbench and local control service are usable, but starting them
still requires a terminal, a known configuration path, and a fixed port. Those
details are implementation concerns and should not be part of the normal
customer workflow.

The desktop application must keep the existing control-plane boundary. React
must not launch agent commands, construct shell strings, or become responsible
for Git, permissions, quality gates, or run recovery.

## Decision

Add a Tauri 2 shell around the existing React workbench. The shell owns one
local control-service process and exposes a deliberately small launcher API:

- restore the last successfully opened project;
- select and validate a project directory;
- initialize a missing `agent-team.yaml` only after an explicit user action;
- start the control service on an operating-system-assigned loopback port;
- wait for readiness, establish an HttpOnly local session, and navigate the
  same WebView to the service-hosted workbench;
- terminate the child process when the application exits.

The normal first-run interface contains one primary choice: select a project
directory. Runtime names, executable paths, ports, configuration paths, and
process output remain hidden unless the user expands technical details. Errors
use an action-oriented recovery state instead of exposing raw stack traces.

The Rust shell invokes executables directly with argument arrays. It never
constructs a shell command. For development, it can use the repository build
and the current Node runtime. Packaged builds copy the target Node executable
as a Tauri external binary and preserve the compiled control-plane resources
under one runtime directory. Cross-target packaging must provide a Node binary
for that exact target rather than copying the build host runtime.

The control service receives a random session token through its environment.
The shell opens a session bootstrap URL, and the service exchanges the token
for an HttpOnly, SameSite cookie before redirecting to the workbench. API and
event-stream requests require that cookie when desktop session protection is
enabled. The token is never written to project or application settings.

## Consequences

- Desktop and browser clients continue to use the same HTTP/SSE contracts.
- Agent policy, execution, persistence, and evidence remain in the existing
  TypeScript control plane.
- A customer does not need to know that a loopback service or Node runtime is
  involved.
- The packaged runtime is larger because it includes Node, but it does not
  depend on a customer-managed Node installation.
- Mobile work can later replace only the execution backend while retaining the
  same strategy and control-plane boundaries.
