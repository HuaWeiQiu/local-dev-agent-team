# Visual Strategy Blueprints

The React workbench can compose, preflight, save, and run project-local strategy
blueprints. A blueprint controls the supported topology mode, concurrency,
rework and invocation budgets, approval gates, and role profile overrides.

## Authority Boundaries

`agent-team.yaml` remains the configuration baseline and is never rewritten by
the browser. Strategies declared there are read-only in the control plane.
Custom blueprints are stored separately at:

```text
<project>/<stateDirectory>/strategy-blueprints.json
```

The default path is `.agent-team/strategy-blueprints.json`, which is already
inside the ignored runtime state directory. Writes are serialized and replace
the catalog atomically. A malformed or conflicting catalog prevents the control
service from starting instead of silently discarding policy.

## Validation And Execution

Preflight and save both apply the same server-side checks:

1. The name is 1-64 ASCII letters, numbers, dots, underscores, or hyphens.
2. The declaration passes the named strategy schema and resource limits.
3. Sequential topology declares `maxParallel: 1`.
4. Final human approval remains mandatory.
5. Every role and profile exists, and each profile is allowed for that role.
6. The server compiles the declaration into the versioned stage topology.

Saving adds the validated definition to the effective project configuration.
The existing Supervisor resolves that name before a run is queued, and the
resolved policy and compiled topology are snapshotted into the run state.
Custom strategies therefore use the same budget, approval, profile, and task
scheduling enforcement as YAML strategies.

Configured strategies cannot be overwritten or deleted through the API. A
custom blueprint can be updated under its own name or deleted. Deleting it does
not alter historical run snapshots, but new runs can no longer select it.

The CLI loads the same catalog for:

```bash
agent-team run --strategy my-blueprint --goal "Implement the requested change"
```

## Control API

For a single-project server, endpoints are rooted at `/api`. In workspace mode,
they are rooted at `/api/projects/:projectId`.

```text
POST   /strategies/preflight  Validate and compile without writing
PUT    /strategies/:name      Validate and atomically save a custom blueprint
DELETE /strategies/:name      Delete a custom blueprint
GET    /config                List effective strategies and their source
POST   /runs                  Start with the saved strategy name
```

`GET /config` marks each strategy definition with `source: "config"` or
`source: "custom"`. All state-changing routes remain loopback-only and subject
to the control server's origin checks.
