# ADR 0008: Open Agent Workbench References

## Status

Accepted

## Context

The first workbench exposed the complete run graph, inspector, event stream,
approvals, and strategy launcher, but its visual treatment gave every region
similar weight. Small type, weak contrast, and card-like run rows made repeated
operational use harder to scan.

No single project covers this product's combination of local run supervision,
strategy policy, approvals, evidence, and task-DAG inspection. The UI therefore
uses several source-level references instead of treating one screenshot as a
design system:

- [Langflow](https://github.com/langflow-ai/langflow) for a canvas-first builder,
  collapsible component library, contextual inspection panel, and restrained
  Radix/Tailwind component hierarchy.
- [Flowise](https://github.com/FlowiseAI/Flowise) for agent execution details,
  node state treatments, and separation of execution output from canvas editing.
- [XYFlow](https://github.com/xyflow/xyflow) for supported React Flow canvas,
  toolbar, controls, minimap, responsive layout, and accessibility patterns.
- [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) for the local
  coding-agent control-center model and persistent access to concurrent work.

## Decision

Use a narrow primary navigation rail and a quiet neutral execution workspace.
Keep runs in a searchable contextual sidebar, render the dependency graph and
activity log as explicit workspace views, and reserve the right inspector for
run or task evidence. The strategy builder is a full canvas; its strategy
library and policy inspector are dismissible overlays rather than permanent
columns. Primary commands remain available in the canvas toolbar.

The UI remains React and uses the existing Lucide and React Flow dependencies.
No reference project's logo, illustration, CSS, component source, or brand copy
is reused. Langflow and XYFlow are MIT-licensed; applicable Flowise community UI
source is Apache-2.0. n8n may inform generic interaction conventions only: its
fair-code license is not treated as a source-code reuse grant.

## Consequences

- Operators can distinguish navigation, execution state, inspection, and logs
  without relying on decorative containers.
- Desktop keeps execution context visible without showing every surface at
  once. Mobile uses explicit views and a vertical graph layout instead of
  shrinking the desktop DAG until labels are unreadable.
- Future screens should extend the same tokens and density rather than adding a
  second visual theme.
- Visual acceptance requires desktop and mobile screenshots plus overflow and
  browser-console checks.

## Reference

- [Langflow repository](https://github.com/langflow-ai/langflow)
- [Flowise repository](https://github.com/FlowiseAI/Flowise)
- [XYFlow repository](https://github.com/xyflow/xyflow)
- [OpenHands repository](https://github.com/OpenHands/OpenHands)
