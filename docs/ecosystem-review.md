# Multi-Agent Ecosystem Review

This review records the design ideas compared while adding the local control
service and React workbench. It is a boundary document, not a plan to replace
the repository's TypeScript workflow with another framework. Sources were
reviewed on 2026-08-09.

For the Chinese product-level comparison, prioritized capability gaps, bounded
self-evolution target architecture, and proposed release sequence, see
[Multi-Agent Team Capability Roadmap](multi-agent-completeness-roadmap.zh-CN.md).

## Relevant Projects

| Project | Useful design | Decision here |
| --- | --- | --- |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | Graph workflows, sequential/concurrent/handoff patterns, checkpointing, streaming, human-in-the-loop, OpenTelemetry | Keep our deterministic DAG and adopt its separation of workflow patterns from agent providers. Checkpoint resume, approvals, and OTLP-compatible trace export now live in our TypeScript control plane. |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Durable state, resumable interrupts, human review, explicit graph execution | Our bounded durable event ledger and linked retry follow the same durability concern. In-place continuation is allowed only at Git-verified task checkpoints. |
| [AutoGen / AutoGen Studio](https://github.com/microsoft/autogen) | Layered runtime, event-driven agents, visual composition and debugging | Adopt the control-plane/UI separation. Do not embed its Python runtime: Studio is positioned as a prototyping UI and AutoGen is now maintenance-oriented. |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Distinction between autonomous crews and deterministic flows, role configuration, observability | Named strategies configure bounded autonomy while the TypeScript workflow retains deterministic gates. Avoid a second orchestration runtime. |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands) | Local control center for parallel coding agents, persistent run navigation, execution inspection, explicit user controls | Use Agent Canvas as the workbench's visual reference while keeping stdout/stderr and state events as first-class projections and the supervisor as the only process owner. |
| [Langflow](https://github.com/langflow-ai/langflow) | Canvas-first composition, collapsible component library, contextual inspector, trace views | Adopt its full-canvas information hierarchy and dismissible tools without importing its application runtime or copying components. |
| [Flowise](https://github.com/FlowiseAI/Flowise) | Agent-flow nodes, execution detail views, state-aware canvas rendering | Adopt the separation between execution evidence and editing controls. Keep our compiled topology and TypeScript supervisor as the source of truth. |
| [XYFlow](https://github.com/xyflow/xyflow) | Maintained React graph rendering, node toolbars, controls, minimap, responsive examples | Continue using `@xyflow/react`; use supported primitives and responsive node layouts instead of a custom renderer. |
| [n8n](https://github.com/n8n-io/n8n) | Mature workflow-editor interaction conventions | Interaction reference only. Do not copy source or CSS because its Sustainable Use License is not an open-source reuse basis for this project. |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Official MCP 2026-07-28 client/server implementation, capability negotiation, conformance tooling | Do not reimplement the wire protocol. Keep MCP provider-managed and profile-gated until the control plane has an explicit consent UI and tool authorization model. |
| [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) | Official A2A 1.0 Agent Card, task lifecycle, streaming, cancellation, and authenticated transport bindings | Reuse the official SDK when remote delegation is authorized. Do not advertise an Agent Card from the current unauthenticated loopback service. |

## Adopted In This Version

- A durable ordered SQLite event ledger plus cursor-based SSE projection.
- One local supervisor that owns process lifecycle, cancellation, and startup
  reconciliation.
- Named strategies for parallelism, rework limits, and role-to-profile routing.
- A graph-first workbench with run history, task inspection, deterministic test
  outcomes, review findings, and live process output.
- Human control that cannot overwrite evidence: cancellation is explicit and a
  retry creates a linked run instead of rewriting history.
- Durable task-boundary checkpoints with Git commit verification and conservative
  recovery that reruns, rather than impersonates, interrupted agent work.
- Explicit expiring approval requests and attributed responses for plan and
  final human gates.
- Strategy execution, invocation, and artifact budgets plus output capture
  limits with durable provider-reported usage.
- Stable event trace/span correlation and read-only OTLP/HTTP JSON export.
- Per-run event retention without deleting approval or checkpoint snapshots.
- Versioned adapter contracts with runtime conformance checks and a
  machine-readable interoperability manifest.
- MCP denied by default with explicit provider-managed opt-in; A2A remote ingress
  remains disabled behind a documented authentication boundary.
- Source-reviewed workbench hierarchy: narrow primary navigation, searchable
  run context, graph/log workspace views, evidence inspector, full-canvas
  strategy composition, and dismissible library/policy tools.

## Gaps Worth Closing

1. Add an authenticated HTTPS gateway and delegated authorization model before
   exposing A2A or accepting remote workers.
2. Add an MCP Host only with per-tool consent, server trust, credential, and
   data-disclosure policies; provider-managed MCP remains available by opt-in.
3. Add an optional OTLP push exporter only when collector configuration,
   retries, redaction, and offline behavior have explicit policies.
4. Add run-directory age retention and an operator-confirmed cleanup command;
   current artifact quotas stop growth but deliberately retain evidence.

## Explicit Non-Goals

- The browser does not become an orchestration engine or process owner.
- A visual drag-and-drop graph does not bypass repository-owned task planning
  and path ownership checks.
- Another Python/.NET workflow runtime is not embedded merely to gain a UI.
- LLM verdicts never override failing deterministic quality commands.
- MCP is not used as an alternate workflow controller, and the loopback REST
  API is not relabeled as A2A without protocol and security conformance.
