# ADR 0008: Agent Canvas Inspired Workbench

## Status

Accepted

## Context

The first workbench exposed the complete run graph, inspector, event stream,
approvals, and strategy launcher, but its visual treatment gave every region
similar weight. Small type, weak contrast, and card-like run rows made repeated
operational use harder to scan.

[OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) is a relevant
open-source reference: it is a local visual control center for parallel coding
agents, can connect to Codex and Claude Code, and keeps concurrent conversations
visible in a persistent sidebar. Its product model is close enough to inform
the workbench without importing another runtime or copying branded assets.

## Decision

Use Agent Canvas as the primary visual reference, not as a component dependency.
Adopt a continuous dark navigation rail, a quiet neutral workspace, one strong
accent for primary commands, compact status treatments, and persistent access
to concurrent runs. Keep the Local Dev Agent Team information architecture:
run list, dependency graph, task/run inspector, event output, approval controls,
strategy selection, and multi-project switching.

The UI remains React and uses the existing Lucide and React Flow dependencies.
No OpenHands logo, illustration, CSS, component source, or brand copy is reused.

## Consequences

- Operators can distinguish navigation, execution state, inspection, and logs
  without relying on decorative containers.
- Desktop keeps the dense four-region control surface; mobile keeps explicit
  tabs and scroll-safe dialogs instead of shrinking the desktop grid.
- Future screens should extend the same tokens and density rather than adding a
  second visual theme.
- Visual acceptance requires desktop and mobile screenshots plus overflow and
  browser-console checks.

## Reference

- [OpenHands repository](https://github.com/OpenHands/OpenHands)
- [OpenHands Agent Canvas](https://www.openhands.dev/product/canvas)
