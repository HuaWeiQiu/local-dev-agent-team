# ADR 0006: Bounded Execution And OTLP Export

## Status

Accepted

## Context

Parallel agents multiply process time, output, artifacts, and provider usage.
Per-profile process timeouts and rework limits do not bound an entire workflow.
Provider CLIs also expose different usage envelopes, so inferred token prices
would create a misleading cross-provider cost policy.

The local SQLite event ledger is useful for live inspection but previously had
no retention bound or standard trace correlation. External observability tools
should be able to consume the evidence without becoming the workflow source of
truth or requiring a remote collector.

## Decision

Each resolved strategy has four enforceable budgets:

- one timeout for each active execution segment;
- a cumulative agent invocation count for the run, including fallbacks;
- a captured stdout/stderr byte limit for each process stream;
- a cumulative artifact byte limit checked at process boundaries.

Human approval wait time is outside an active execution segment. Recovery and
plan continuation start a new segment but retain cumulative invocation and
artifact usage. Execution, invocation, and artifact budget exhaustion blocks
the run. Output beyond a stream's capture limit is discarded while the child
continues to drain, and the truncation is recorded. Existing artifacts are not
deleted when the artifact limit is crossed, so one completed process can put
the directory slightly over its configured limit before further work stops.

Adapters record input, cached-input, and output tokens or USD cost only when the
CLI response explicitly reports them. Reported cost is an observation, not a
hard cross-provider budget. Invocation count is the provider-independent spend
control.

Every durable event exposes a deterministic 16-byte trace ID for its run and an
8-byte span ID for the event. `GET /api/runs/:runId/telemetry` (or the
project-scoped workspace equivalent) exports retained events in OTLP/HTTP JSON
`ExportTraceServiceRequest` shape. IDs use hexadecimal encoding and 64-bit
nanosecond timestamps use decimal strings, following the OTLP JSON rules.
SQLite remains the local source; this phase does not push telemetry over the
network.

The project-level `maxEventsPerRun` policy trims only the oldest event-ledger
rows for that run. Current state, approvals, checkpoints, and artifacts remain
in the run directory.

## Consequences

- Strategies now bound multiplicative agent work and disk/log growth.
- Fallback attempts consume the same invocation budget as primary attempts.
- Output truncation can make an adapter response invalid; the run then follows
  its normal fallback or blocking policy with truncation visible in usage.
- OTLP-compatible export can feed a collector manually without introducing a
  collector availability dependency into local execution.
- Exact provider cost parity remains intentionally unresolved until every
  supported adapter exposes a stable, authoritative usage contract.

## References

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
