// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Overview,
  gatesLabel,
  isAutomatic,
  secondsLabel,
  targetSummary,
  topologyLabel,
} from "../../web/src/components/evolution/detail/overview.js";
import type { EvolutionProposal } from "../../web/src/types.js";

function proposal(patch: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    id: "p-1",
    status: "candidate",
    createdAt: "2026-10-30T00:00:00.000Z",
    candidate: {
      kind: "role-prompt",
      path: "prompts/worker.md",
      contentDigest: "a".repeat(64),
    },
    evaluation: undefined,
    ...patch,
  } as unknown as EvolutionProposal;
}

function blueprint(patch: Record<string, unknown> = {}): EvolutionProposal {
  return proposal({
    candidate: {
      kind: "strategy-blueprint",
      definition: {
        topology: { mode: "sequential" },
        maxParallel: 2,
        maxReworkAttempts: 1,
        maxAgentInvocations: 8,
        executionTimeoutSeconds: 600,
        approvalGates: ["plan", "final"],
        ...patch,
      },
    },
  } as never);
}

describe("overview helpers", () => {
  it("labels targets, topology, timeouts and gates", () => {
    expect(targetSummary("strategy-blueprint")).toMatch(/本地自定义执行策略/);
    expect(targetSummary("role-prompt")).toMatch(/角色提示词/);
    expect(topologyLabel("sequential")).toBe("顺序执行");
    expect(topologyLabel("parallel-dag")).toBe("依赖并行");
    expect(secondsLabel(600)).toBe("600 秒");
    expect(secondsLabel(undefined)).toBe("默认");
    expect(gatesLabel(["plan", "final"])).toBe("plan、final");
    expect(gatesLabel([])).toBe("沿用默认");
    expect(gatesLabel(undefined)).toBe("沿用默认");
  });

  it("detects an automatic evaluation", () => {
    expect(isAutomatic(proposal())).toBe(false);
    expect(
      isAutomatic(
        proposal({ evaluation: { source: "server-automatic-run-evaluation-v1" } as never }),
      ),
    ).toBe(true);
  });
});

describe("Overview", () => {
  it("shows the role-prompt material digest", () => {
    render(<Overview proposal={proposal()} />);
    expect(screen.getByText("变更目标")).toBeVisible();
    expect(screen.getByText("材料摘要")).toBeVisible();
    expect(screen.getByText("prompts/worker.md")).toBeVisible();
    expect(screen.getByText("候选权限")).toBeVisible();
    expect(screen.queryByText(/受限控制器/)).toBeNull();
  });

  it("shows strategy parameters for a blueprint candidate", () => {
    render(<Overview proposal={blueprint()} />);
    expect(screen.getByText("执行参数")).toBeVisible();
    expect(screen.getByText("顺序执行")).toBeVisible();
    expect(screen.getByText("600 秒")).toBeVisible();
    expect(screen.getByText("plan、final")).toBeVisible();
  });

  it("falls back to defaults and explains automatic runs", () => {
    render(
      <Overview
        proposal={blueprint({ maxParallel: undefined, approvalGates: undefined })}
      />,
    );
    expect(screen.getAllByText("默认").length).toBeGreaterThan(0);
    expect(screen.getByText("沿用默认")).toBeVisible();
  });
});
