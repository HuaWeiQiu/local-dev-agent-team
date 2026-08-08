# ADR 0002: Named Execution Strategies

## Status

Accepted.

## Context

Roles and agent profiles are intentionally separate, but a complete run also
needs a repeatable operating policy. Users need to choose a conservative,
balanced, or fast policy without editing every role mapping and limit for each
run.

## Decision

Configuration may define named execution strategies. A strategy can select a
profile for each role, set the run concurrency limit, and set the task rework
limit. The selected strategy is resolved once when the run is created and is
persisted with the run state.

Resolution precedence is:

```text
explicit human role/profile override
  -> selected strategy role/profile mapping
  -> role default profile
```

The strategy name supplied by a human overrides the configured default. Every
strategy profile must be allowed by the corresponding role policy. Legacy
configuration without `strategies` remains valid and resolves to the existing
project and quality limits.

## Consequences

- Strategy selection is auditable and deterministic.
- Frontends and automation can expose a single named choice instead of editing
  several unrelated fields.
- Strategies cannot weaken role profile allowlists.
- Human run overrides remain authoritative, including over task-suggested
  worker profiles.
