import { describe, expect, it } from "vitest";
import {
  approveBlockedBy,
  canEditPlan,
  completenessOf,
  dialogDescription,
  dialogTitle,
  dialogView,
  hasEdits,
  isIncomplete,
  submitLabel,
  submitPayload,
} from "../web/src/components/run/action-dialog/model.js";
import type { ApprovalRequest, RunState } from "../web/src/types.js";

function run(plan?: RunState["plan"]): RunState {
  return { id: "r1", goal: "实现导出", tasks: [], ...(plan ? { plan } : {}) } as RunState;
}

function plan(): NonNullable<RunState["plan"]> {
  return {
    summary: "计划",
    tasks: [
      {
        id: "T1",
        title: "实现",
        description: "实现导出",
        dependsOn: [],
        ownedPaths: ["src/a.ts"],
        acceptanceCommands: ["pnpm test"],
        profile: null,
      },
    ],
  } as NonNullable<RunState["plan"]>;
}

function approval(gate: string): ApprovalRequest {
  return { id: "a1", gate, summary: "s", expiresAt: "2026-01-01T00:00:00Z" } as ApprovalRequest;
}

describe("run action dialog model", () => {
  it("names each mode", () => {
    expect(dialogTitle("approval", approval("plan"))).toBe("审批执行计划");
    expect(dialogTitle("approval", approval("result"))).toBe("审批交付结果");
    expect(dialogTitle("pause")).toBe("暂停运行");
    expect(dialogDescription("approval")).toContain("人工门禁");
    expect(dialogDescription("resume")).toContain("检查点");
  });

  it("labels the primary action", () => {
    expect(submitLabel("approval", false, false)).toBe("批准");
    expect(submitLabel("approval", true, false)).toBe("批准修改后的计划");
    expect(submitLabel("pause", false, false)).toBe("暂停");
    expect(submitLabel("resume", false, false)).toBe("恢复");
    expect(submitLabel("approval", false, true)).toBe("提交中");
  });

  it("only edits a plan gate with a plan", () => {
    expect(canEditPlan("approval", approval("plan"), run(plan()))).toBe(true);
    expect(canEditPlan("approval", approval("result"), run(plan()))).toBe(false);
    expect(canEditPlan("pause", approval("plan"), run(plan()))).toBe(false);
  });

  it("detects edits against the run's plan", () => {
    expect(hasEdits(false, plan(), run(plan()))).toBe(false);
    expect(hasEdits(true, plan(), run(plan()))).toBe(false);
    const changed = plan();
    changed.tasks[0]!.title = "改名";
    expect(hasEdits(true, changed, run(plan()))).toBe(true);
  });

  it("reads completeness only for a plan gate with a run", () => {
    expect(completenessOf("approval", approval("plan"), run(plan()))).toBeDefined();
    expect(completenessOf("approval", approval("result"), run(plan()))).toBeUndefined();
    expect(completenessOf(undefined, approval("plan"), run(plan()))).toBeUndefined();
    expect(isIncomplete(undefined)).toBe(false);
  });

  it("blocks approval until an incomplete plan is acknowledged", () => {
    const complete = { status: "complete", issues: [] } as never;
    const incomplete = { status: "incomplete", issues: ["缺 T2"] } as never;
    expect(approveBlockedBy(complete, false, false)).toBe(false);
    expect(approveBlockedBy(incomplete, false, false)).toBe(true);
    expect(approveBlockedBy(incomplete, true, false)).toBe(false);
    expect(approveBlockedBy(incomplete, false, true)).toBe(false);
  });

  it("trims the payload and drops an empty one", () => {
    expect(submitPayload({ actor: "  ", reason: "x" })).toBeUndefined();
    expect(submitPayload({ actor: "ops", reason: "why", decision: "approved" })).toEqual({
      decision: "approved",
      actor: "ops",
      reason: "why",
    });
  });

  it("derives the whole view", () => {
    const view = dialogView({
      mode: "approval",
      approval: approval("plan"),
      run: run(plan()),
      draft: plan(),
      editing: false,
      acknowledged: false,
      actor: "ops",
      reason: "why",
    });
    expect(view).toMatchObject({ editable: true, edited: false, ready: true });
    expect(view.approveBlocked).toBe(false);
  });
});
