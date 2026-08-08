# ADR 0009: Compiled Strategy Topologies

## Status

Accepted

## Context

Named strategies currently bind concurrency, retry, approval, profile, and
resource limits. Those policies are enforceable, but the strategy name does not
describe the collaboration topology and the web workbench has no stable graph
contract to visualize or edit.

Allowing an arbitrary client-authored graph to drive the workflow directly
would let presentation state bypass mandatory quality commands, final approval,
Git worktree isolation, and resource budgets. Conversely, treating every visual
node as decoration would make the strategy editor misleading.

## Decision

Each named strategy declares a versioned topology mode. The control plane
compiles the declaration into an immutable stage graph when the strategy is
resolved. The compiled graph is stored in the run snapshot and exposed through
the public configuration projection, so design and runtime views share one
authoritative contract.

The first executable modes are:

- `parallel-dag`: dependency-ready, path-disjoint worker tasks may run in a
  bounded parallel wave.
- `sequential`: the same dependency and ownership checks apply, but each worker
  wave is limited to one task.

Both modes retain orchestrator intake, architecture, deterministic quality
gates, review and test, final decision, final human approval, and publication
boundaries. Plan approval is inserted only when the policy requests it.

Legacy configurations without a topology compile as `parallel-dag`. A
`sequential` strategy resolves its concurrency to one and any contradictory
explicit `maxParallel` value is rejected instead of silently ignored.

Future modes such as supervisor routing, handoff, and reviewer committees must
add their runtime semantics and failure tests before their schema values become
valid. The UI cannot invent unsupported executable node kinds.

## Consequences

- Strategy topology and execution policy become separate, auditable concepts.
- The workbench can render the configured lifecycle before a run starts and the
  exact compiled lifecycle after it starts.
- Existing strategies and run commands remain backward compatible.
- Custom visual blueprints compile into this contract and persist as validated
  policy declarations rather than executing browser-authored edges directly.

## References

- [Mastra workflows](https://github.com/mastra-ai/mastra)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
