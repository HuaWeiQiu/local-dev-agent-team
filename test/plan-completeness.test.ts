import { describe, expect, it } from "vitest";
import {
  assessPlanCompleteness,
  namedDeliverablesInGoal,
  completenessBarCopy,
  planCompletenessForRun,
  taskKind,
  taskKindLabel,
  taskPhaseLabel,
  acceptanceSummary,
} from "../web/src/plan-completeness.js";
import type { Task, TaskRunState } from "../web/src/types.js";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "实现导出",
    description: "",
    dependsOn: [],
    ownedPaths: ["src/export.ts"],
    acceptanceCommands: [],
    ...patch,
  } as Task;
}

function taskState(patch: Record<string, unknown> = {}): TaskRunState {
  return { task: task(), status: "working", attempts: 1, ...patch } as unknown as TaskRunState;
}

describe("taskPhaseLabel", () => {
  it("names the working phase from the run status and artefacts", () => {
    expect(taskPhaseLabel(taskState(), "reviewing-testing")).toBe("审查 / 测试");
    expect(taskPhaseLabel(taskState({ review: {} }), "implementing")).toBe("审查 / 测试");
    expect(taskPhaseLabel(taskState({ test: {} }), "implementing")).toBe("审查 / 测试");
    expect(taskPhaseLabel(taskState({ quality: {} }), "implementing")).toBe("质量门");
    expect(taskPhaseLabel(taskState(), "implementing")).toBe("工作中");
  });

  it("names settled statuses and leaves pending blank", () => {
    expect(taskPhaseLabel(taskState({ status: "reworking" }), "implementing")).toBe("返工");
    expect(taskPhaseLabel(taskState({ status: "blocked" }), "implementing")).toBe("阻塞");
    expect(taskPhaseLabel(taskState({ status: "passed" }), "implementing")).toBe("已通过");
    expect(taskPhaseLabel(taskState({ status: "merged" }), "completed")).toBe("已合并");
    expect(taskPhaseLabel(taskState({ status: "pending" }), "planning")).toBeUndefined();
  });
});

describe("taskKind", () => {
  it("honours an explicit evidence kind", () => {
    expect(taskKind(task({ evidenceKind: "host-evidence" }))).toBe("host-evidence");
  });

  it("treats a commands task as docs only when everything it owns is docs", () => {
    expect(taskKind(task({ evidenceKind: "commands", ownedPaths: ["docs/a.md"] }))).toBe("docs");
    expect(taskKind(task({ evidenceKind: "commands", ownedPaths: [] }))).toBe("implement");
    expect(taskKind(task({ evidenceKind: "commands", ownedPaths: ["src/a.ts"] }))).toBe("implement");
    expect(
      taskKind(task({ evidenceKind: "commands", id: "docs-update", title: "文档", ownedPaths: ["docs/x.md"] })),
    ).toBe("docs");
  });

  it("infers recon and docs from wording and paths", () => {
    expect(taskKind(task({ id: "recon-1", title: "只读侦察代码库" }))).toBe("recon");
    expect(taskKind(task({ description: "只读侦察现有实现" }))).toBe("recon");
    expect(taskKind(task({ ownedPaths: ["docs/a.md", "docs/b.md"] }))).toBe("docs");
    expect(taskKind(task({ ownedPaths: ["docs/a.md"], description: "文档更新" }))).toBe("docs");
    expect(taskKind(task({ ownedPaths: ["src/a.ts", "docs/b.md"], description: "文档更新" }))).toBe("implement");
  });

  it("labels every kind", () => {
    expect(taskKindLabel("recon")).toBe("只读侦察");
    expect(taskKindLabel("docs")).toBe("文档");
    expect(taskKindLabel("implement")).toBe("实现");
    expect(taskKindLabel("host-evidence")).toBe("实机证据");
  });
});

describe("assessPlanCompleteness", () => {
  it("passes a plan that covers its deliverables", () => {
    const report = assessPlanCompleteness(
      { tasks: [task({ acceptanceCommands: [{ command: "pnpm", args: ["test"] }] as never })] },
      "实现 T1 的导出",
    );
    expect(report.status).toBe("complete");
    expect(report.issues).toEqual([]);
  });

  it("rejects a plan that misses a named deliverable", () => {
    const report = assessPlanCompleteness({ tasks: [task({ title: "别的" })] }, "实现 T1 与 T2");
    expect(report.status).toBe("rejected");
    expect(report.issues.join(" ")).toContain("缺");
  });

  it("rejects two recon tasks and recon with acceptance commands", () => {
    const recon = (id: string) =>
      task({ id, title: `只读侦察 ${id}`, acceptanceCommands: [{ command: "x", args: [] }] as never });
    const report = assessPlanCompleteness({ tasks: [recon("R1"), recon("R2")] }, "看一遍");
    expect(report.issues.join(" ")).toContain("只读侦察超过 1 条");
    expect(report.issues.join(" ")).toContain("禁止 acceptanceCommands");
  });

  it("rejects an implementation task without proof", () => {
    const report = assessPlanCompleteness({ tasks: [task({ ownedPaths: [] })] }, "实现 T1");
    expect(report.status).toBe("rejected");
    expect(report.issues.join(" ")).toContain("需要验收命令");
  });

  it("accepts an implementation task proven by host evidence", () => {
    const report = assessPlanCompleteness(
      { tasks: [task({ ownedPaths: [], evidenceKind: "host-evidence" })] },
      "实现 T1",
    );
    expect(report.status).toBe("complete");
  });

  it("warns about a lone recon task when no deliverable is named", () => {
    const report = assessPlanCompleteness({ tasks: [task({ title: "只读侦察" })] }, "看看");
    expect(report.status).toBe("incomplete");
    expect(report.issues).toContain("唯一任务是只读侦察");
  });

  it("notes a recon task among others", () => {
    const report = assessPlanCompleteness(
      {
        tasks: [
          task({ id: "R1", title: "只读侦察", ownedPaths: [] }),
          task({ acceptanceCommands: [{ command: "x", args: [] }] as never }),
        ],
      },
      "增加导出",
    );
    expect(report.issues.join(" ")).toContain("含只读侦察 R1");
  });
});

describe("report helpers", () => {
  it("builds a report from a run", () => {
    expect(planCompletenessForRun({ goal: "x", plan: undefined, tasks: [], error: undefined })).toBeUndefined();
    const report = planCompletenessForRun({
      goal: "实现 T1",
      plan: undefined,
      tasks: [taskState({ task: task({ ownedPaths: [] }) })],
      error: undefined,
    });
    expect(report?.status).toBe("rejected");

    const escalated = planCompletenessForRun({
      goal: "实现 T1",
      plan: { summary: "", tasks: [task({ acceptanceCommands: [{ command: "x", args: [] }] as never })] },
      tasks: [],
      error: "Plan completeness rejected by the controller",
    });
    expect(escalated?.status).toBe("rejected");
    expect(escalated?.issues[0]).toContain("Plan completeness rejected");
  });

  it("copies the bar tone per status", () => {
    expect(completenessBarCopy({ status: "complete" } as never).tone).toBe("success");
    expect(completenessBarCopy({ status: "incomplete" } as never).tone).toBe("warning");
    expect(completenessBarCopy({ status: "rejected" } as never).tone).toBe("danger");
  });

  it("summarizes acceptance commands", () => {
    expect(acceptanceSummary(task({ acceptanceCommands: [{ command: "pnpm", args: ["test"] }] as never }))).toBe(
      "pnpm test",
    );
    expect(acceptanceSummary(task({ acceptanceCommands: [] }))).toBe("无独立验收");
    expect(acceptanceSummary(task({ evidenceKind: "host-evidence", acceptanceCommands: [] }))).toBe("实机 · 未验证");
  });
});

describe("deliverable ids", () => {
  it("extracts, normalizes and orders them", () => {
    expect(namedDeliverablesInGoal("实现 T1、T2 与 P1.1")).toEqual(["P1.1", "T1", "T2"]);
    expect(namedDeliverablesInGoal("T3 - T5 一起做")).toEqual(["T3", "T4", "T5"]);
    expect(namedDeliverablesInGoal("没有编号")).toEqual([]);
  });

  it("orders by prefix, then major, then minor", () => {
    const ids = namedDeliverablesInGoal("P2.1 T10 T9 P1.2 P1.10 T1");
    expect(ids).toEqual(["P1.2", "P1.10", "P2.1", "T1", "T9", "T10"]);
  });
});
