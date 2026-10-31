// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EvolutionSnapshot, PublicConfig } from "../../web/src/types.js";
import {
  areStrategyLimitsValid,
  byteLengthOf,
  canSubmitDraft,
  draftFromSource,
  initialDraft,
  isValidTargetName,
  proposalFromDraft,
  strategyNamesOf,
} from "../../web/src/components/evolution/proposal/model.js";
import {
  EvolutionProposalDialog,
  closesDialog,
  submitLabel,
} from "../../web/src/components/EvolutionProposalDialog.js";

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: {},
    strategies: {
      default: "demo",
      definitions: {
        demo: { topology: { mode: "parallel-dag" }, maxParallel: 2, maxReworkAttempts: 1 },
        tighten: { topology: { mode: "sequential" }, maxParallel: 1, maxReworkAttempts: 3 },
      },
    },
  } as unknown as PublicConfig;
}

function snapshot(): EvolutionSnapshot {
  return {
    catalogRevision: 1,
    applicationRevision: 1,
    recoveryRequired: false,
    promptRoles: [{ role: "worker", path: "prompts/worker.md" }],
    proposals: [],
    activeProposals: [],
    auditRecords: [],
    completedApplications: [],
    pendingOperation: null,
    automation: {} as EvolutionSnapshot["automation"],
    evidenceScope: "server-structural-preflight-not-candidate-execution",
  };
}

describe("proposal draft model", () => {
  it("starts from the default strategy and re-seats on source change", () => {
    const draft = initialDraft(config(), snapshot().promptRoles);
    expect(draft).toMatchObject({
      kind: "strategy",
      sourceName: "demo",
      targetName: "demo-evolved",
      topology: "parallel-dag",
      maxParallel: 2,
      maxReworkAttempts: 1,
      role: "worker",
      content: "",
    });
    expect(draft.commandId).toMatch(/[0-9a-f-]{36}/);

    expect(draftFromSource(config(), "tighten")).toEqual({
      sourceName: "tighten",
      targetName: "tighten-evolved",
      topology: "sequential",
      maxParallel: 1,
      maxReworkAttempts: 3,
    });
  });

  it("validates names, limits and prompt size", () => {
    expect(isValidTargetName("ok-name.1")).toBe(true);
    expect(isValidTargetName("-bad")).toBe(false);
    expect(isValidTargetName("")).toBe(false);
    expect(areStrategyLimitsValid(1, 0)).toBe(true);
    expect(areStrategyLimitsValid(0, 0)).toBe(false);
    expect(areStrategyLimitsValid(33, 0)).toBe(false);
    expect(areStrategyLimitsValid(2, 11)).toBe(false);
    expect(areStrategyLimitsValid(2.5, 1)).toBe(false);
    expect(byteLengthOf("abc")).toBe(3);
    expect(byteLengthOf("中文")).toBe(6);
  });

  it("decides whether a draft can be submitted", () => {
    const base = { ...initialDraft(config(), []), role: "worker", content: "hello" };
    expect(canSubmitDraft({ ...base, kind: "prompt" }, config())).toBe(true);
    expect(canSubmitDraft({ ...base, kind: "prompt", content: "  " }, config())).toBe(false);
    expect(canSubmitDraft({ ...base, kind: "prompt", role: "" }, config())).toBe(false);
    expect(
      canSubmitDraft({ ...base, kind: "prompt", content: "x".repeat(262_145) }, config()),
    ).toBe(false);
    expect(canSubmitDraft(base, config())).toBe(true);
    expect(canSubmitDraft({ ...base, targetName: "-nope" }, config())).toBe(false);
    expect(canSubmitDraft({ ...base, maxParallel: 0 }, config())).toBe(false);
  });

  it("builds the strategy payload from the cloned source", () => {
    const draft = { ...initialDraft(config(), []), topology: "sequential" as const, maxParallel: 4 };
    const proposal = proposalFromDraft(draft, config());
    expect(proposal).toMatchObject({
      kind: "strategy",
      name: "demo-evolved",
      definition: { topology: { mode: "sequential" }, maxParallel: 4, maxReworkAttempts: 1 },
    });
    // The source definition must not be mutated by the clone.
    expect(config().strategies.definitions.demo).toMatchObject({ maxParallel: 2 });

    expect(
      proposalFromDraft({ ...draft, kind: "prompt", role: "worker", content: "hi" }, config()),
    ).toMatchObject({ kind: "prompt", role: "worker", content: "hi" });
    expect(proposalFromDraft({ ...draft, targetName: "-bad" }, config())).toBeUndefined();
  });

  it("falls back when the source or project config is missing", () => {
    const sparse = {
      roles: {},
      strategies: { default: "gone", definitions: {} },
    } as unknown as PublicConfig;
    expect(draftFromSource(sparse, "missing")).toEqual({
      sourceName: "missing",
      targetName: "missing-evolved",
      topology: "parallel-dag",
      maxParallel: 2,
      maxReworkAttempts: 2,
    });
    expect(initialDraft(sparse, [])).toMatchObject({ sourceName: "gone", maxParallel: 2 });
  });

  it("describes the footer and the close guard", () => {
    expect(submitLabel(true, false)).toBe("提交中");
    expect(submitLabel(false, true)).toBe("重试原候选");
    expect(submitLabel(false, false)).toBe("创建候选");
    expect(closesDialog(false, false)).toBe(true);
    expect(closesDialog(false, true)).toBe(false);
    expect(closesDialog(true, false)).toBe(false);
  });

  it("lists strategies in sorted order", () => {
    expect(strategyNamesOf(config())).toEqual(["demo", "tighten"]);
  });
});

describe("EvolutionProposalDialog", () => {
  it("submits a strategy candidate", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EvolutionProposalDialog
        open
        config={config()}
        snapshot={snapshot()}
        busy={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /创建候选/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "strategy", name: "demo-evolved" }),
    );
  });

  it("switches to prompt mode and submits its content", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EvolutionProposalDialog
        open
        config={config()}
        snapshot={snapshot()}
        busy={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "角色提示词" }));
    await userEvent.type(screen.getByLabelText("提示词内容"), "be precise");
    await userEvent.click(screen.getByRole("button", { name: /创建候选/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "prompt", role: "worker", content: "be precise" }),
    );
  });

  it("blocks submission when the target name is invalid", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EvolutionProposalDialog
        open
        config={config()}
        snapshot={snapshot()}
        busy={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    const name = screen.getByLabelText("候选策略名称");
    await userEvent.clear(name);
    await userEvent.type(name, "-bad");
    expect(screen.getByRole("button", { name: /创建候选/ })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
