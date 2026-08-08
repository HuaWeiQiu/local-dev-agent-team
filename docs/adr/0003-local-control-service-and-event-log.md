# ADR 0003: Local Control Service And Event Log

## Status

Accepted.

## Context

The synchronous CLI can execute a workflow, but a visual client needs to start
work without owning the child process, reconnect after navigation, receive
ordered updates, and cancel active work. Reading mutable JSON snapshots from a
browser would bypass the control plane and cannot provide a reliable event
cursor.

## Decision

`agent-team serve` is the single local control process. It binds to a loopback
address, exposes REST commands and an SSE event stream, and owns active workflow
abort controllers. The existing CLI remains available and uses the same core.

SQLite stores an ordered durable event ledger and idempotency records. Events
are append-only inside the configured per-run retention window; the oldest rows
may be pruned after append. Current run snapshots and large artifacts remain
under `.agent-team/`; the database is an ordered control/read model, not a
replacement for recoverable Git branches or artifact files.

Every event has a monotonic sequence, stable ID, schema version, timestamp,
type, run ID, and JSON payload. SSE clients reconnect with a sequence cursor.
Mutating HTTP requests may use an idempotency key, and reusing a key with a
different request is rejected.

Agent and quality processes receive an abort signal. On Unix, managed child
processes run in their own process group so cancellation also reaches their
descendants. A cancelled run is recorded separately from a failed run.

## Consequences

- The frontend never starts an agent or edits workflow state directly.
- Multiple browser clients observe the same ordered state.
- Direct CLI runs remain supported without starting the server.
- Node.js 24 is required for the built-in SQLite module.
- Remote access, authentication, and distributed workers remain outside the
  local control service boundary.
