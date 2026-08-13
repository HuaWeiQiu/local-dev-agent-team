import { describe, expect, it } from "vitest";
import type { Task, TaskPlan } from "../src/domain/contracts.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessPlanCompleteness,
  canUseHandoverFallback,
  classifyTaskKind,
  expandPlanningGoal,
  extractNamedDeliverables,
  fallbackHandoverTaskPlan,
  fallbackNamedTaskPlan,
  pathsMayOverlap,
  selectTaskWave,
  validateTaskPlan,
} from "../src/domain/plan.js";
import { pathMatchesOwnedPath } from "../src/domain/owned-paths.js";

function plan(): TaskPlan {
  return {
    summary: "fixture",
    tasks: [
      {
        id: "api",
        title: "API",
        description: "Implement API",
        dependsOn: [],
        ownedPaths: ["src/api/**"],
        acceptanceCommands: [],
        profile: null,
      },
      {
        id: "web",
        title: "Web",
        description: "Implement web",
        dependsOn: [],
        ownedPaths: ["src/web/**"],
        acceptanceCommands: [],
        profile: null,
      },
      {
        id: "integration",
        title: "Integration",
        description: "Join both",
        dependsOn: ["api", "web"],
        ownedPaths: ["test/integration/**"],
        acceptanceCommands: [],
        profile: null,
      },
    ],
  };
}

describe("task plans", () => {
  it("selects dependency-ready non-overlapping work", () => {
    const fixture = plan();
    validateTaskPlan(fixture);
    expect(selectTaskWave(fixture, new Set(), new Set(), 3).map((task) => task.id)).toEqual([
      "api",
      "web",
    ]);
  });

  it("detects dependency cycles", () => {
    const fixture = plan();
    fixture.tasks[0]!.dependsOn = ["integration"];
    expect(() => validateTaskPlan(fixture)).toThrow("dependency cycle");
  });

  it("conservatively detects path overlap", () => {
    expect(pathsMayOverlap(["src/**"], ["src/api/**"])).toBe(true);
    expect(pathsMayOverlap(["src/web/**"], ["src/api/**"])).toBe(false);
  });

  it("prefers packing the same batchKey before mixing other batches", () => {
    const fixture: TaskPlan = {
      summary: "batch affinity",
      tasks: [
        {
          id: "a1",
          title: "A1",
          description: "batch a",
          dependsOn: [],
          ownedPaths: ["src/a1.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-a",
        },
        {
          id: "b1",
          title: "B1",
          description: "batch b",
          dependsOn: [],
          ownedPaths: ["src/b1.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-b",
        },
        {
          id: "a2",
          title: "A2",
          description: "batch a",
          dependsOn: [],
          ownedPaths: ["src/a2.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-a",
        },
      ],
    };
    validateTaskPlan(fixture);
    const wave = selectTaskWave(fixture, new Set(), new Set(), 2);
    expect(wave.map((task) => task.id)).toEqual(["a1", "a2"]);
  });
});

function task(partial: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    description: partial.description ?? partial.title,
    dependsOn: [],
    ownedPaths: ["src/app.ts"],
    acceptanceCommands: [{ command: "pnpm", args: ["test"] }],
    profile: null,
    ...partial,
  };
}

describe("plan completeness", () => {
  it("expands T1-T4 and P0.x from the goal", () => {
    expect(extractNamedDeliverables("做完 T1-T4，另外 P0.1 和 P0-2")).toEqual([
      "P0.1",
      "P0.2",
      "T1",
      "T2",
      "T3",
      "T4",
    ]);
    expect(extractNamedDeliverables("根据交接文档完成任务")).toEqual(["T1", "T2", "T3", "T4"]);
    expect(extractNamedDeliverables("根据交接文档完成任务", { allowImpliedHandover: false })).toEqual([]);
    expect(expandPlanningGoal("根据交接文档完成任务")).toBe("根据交接文档完成任务");
    expect(expandPlanningGoal("根据交接文档完成任务", "/tmp/not-a-handover-repo")).toBe("根据交接文档完成任务");
    const fallback = fallbackHandoverTaskPlan();
    expect(fallback.tasks.map((task) => task.id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(assessPlanCompleteness(fallback, "根据交接文档完成任务").status).toBe("complete");
    const t1 = fallback.tasks.find((task) => task.id === "T1");
    expect(
      [
        "apps/photoshop-uxp/src/host/source-pixel-hash.mjs",
        "apps/photoshop-uxp/tests/source-pixel-hash.test.mjs",
      ].every((file) => t1?.ownedPaths.some((pattern) => pathMatchesOwnedPath(file, pattern))),
    ).toBe(true);
    const named = fallbackNamedTaskPlan(
      "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
    );
    expect(named?.tasks.map((task) => [task.id, task.ownedPaths[0]])).toEqual([
      ["T1", "src/greet.js"],
      ["T2", "test/greet.test.js"],
      ["T3", "CHANGELOG.md"],
    ]);
    expect(assessPlanCompleteness(named!, "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.").status).toBe("complete");
  });

  it("uses the Photoshop handover fallback only when the repo has that handover", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "agent-team-no-handoff-"));
    expect(canUseHandoverFallback("根据交接文档完成任务", emptyRoot)).toBe(false);
    expect(expandPlanningGoal("根据交接文档完成任务", emptyRoot)).toBe("根据交接文档完成任务");

    const handoverRoot = await mkdtemp(path.join(tmpdir(), "agent-team-handoff-"));
    await mkdir(path.join(handoverRoot, "docs"), { recursive: true });
    await writeFile(path.join(handoverRoot, "docs", "HANDOFF.zh-CN.md"), "# handoff\n");
    expect(canUseHandoverFallback("根据交接文档完成任务", handoverRoot)).toBe(true);
    expect(expandPlanningGoal("根据交接文档完成任务", handoverRoot)).toContain("T1 Add Imaging");
  });

  it("classifies recon, docs, host evidence and implement tasks", () => {
    expect(classifyTaskKind(task({ id: "inspect-handoff", title: "Read handover", description: "read-only inspect" }))).toBe("recon");
    expect(classifyTaskKind(task({ id: "docs", title: "Write docs", ownedPaths: ["docs/HANDOFF.md"] }))).toBe("docs");
    expect(classifyTaskKind(task({ id: "host", title: "Verify on device", evidenceKind: "host-evidence" }))).toBe("host-evidence");
    expect(classifyTaskKind(task({ id: "t1", title: "Add API" }))).toBe("implement");
  });

  it("rejects a lone recon plan when the goal names T1-T4", () => {
    const report = assessPlanCompleteness(
      {
        summary: "read first",
        tasks: [task({ id: "inspect-handoff", title: "Inspect handover", description: "read-only", acceptanceCommands: [] })],
      },
      "Implement T1-T4 from the handover",
    );
    expect(report.status).toBe("rejected");
    expect(report.issues.some((issue) => issue.includes("缺 T1"))).toBe(true);
    expect(report.issues.some((issue) => issue.includes("只读侦察"))).toBe(true);
  });

  it("rejects recon tasks that carry acceptanceCommands", () => {
    const report = assessPlanCompleteness(
      {
        summary: "mixed",
        tasks: [
          task({
            id: "inspect",
            title: "Inspect handover",
            description: "read-only",
            ownedPaths: ["docs/HANDOFF.md"],
            acceptanceCommands: [{ command: "pnpm", args: ["check"] }],
          }),
          task({ id: "t1", title: "Add T1 API" }),
        ],
      },
      "T1 only",
    );
    expect(report.status).toBe("rejected");
    expect(report.issues.some((issue) => issue.includes("禁止 acceptanceCommands"))).toBe(true);
  });

  it("does not treat implement packets as recon just because they mention a read-only reviewer", () => {
    const report = assessPlanCompleteness(
      {
        summary: "four packets",
        tasks: [
          task({
            id: "T1",
            title: "Add source-layer integrity verification",
            description: "After staging, a separate read-only reviewer checks the staged diff.",
            evidenceKind: "commands",
          }),
          task({
            id: "T2",
            title: "Add cancel and failure cleanup",
            description: "A separate read-only tester evaluates the recorded targeted command.",
            evidenceKind: "commands",
          }),
          task({
            id: "T3",
            title: "Write the Photoshop host-evidence runbook",
            acceptanceCommands: [],
            ownedPaths: ["docs/runbooks/p0.md"],
            evidenceKind: "host-evidence",
          }),
          task({
            id: "T4",
            title: "Write synchronized P0 handoff facts",
            ownedPaths: ["docs/HANDOFF.zh-CN.md", "PROJECT_STATE.md"],
            evidenceKind: "commands",
          }),
        ],
      },
      "Implement T1-T4",
    );
    expect(report.status).toBe("complete");
    expect(report.reconTaskIds).toEqual([]);
  });

  it("accepts a complete T1-T2 plan with commands or host-evidence", () => {
    const report = assessPlanCompleteness(
      {
        summary: "two deliverables",
        tasks: [
          task({ id: "t1", title: "Add T1 mock" }),
          task({
            id: "t2",
            title: "Verify T2 on host",
            acceptanceCommands: [],
            evidenceKind: "host-evidence",
          }),
        ],
      },
      "Deliver T1 and T2",
    );
    expect(report.status).toBe("complete");
    expect(report.coveredDeliverables).toEqual(["T1", "T2"]);
  });
});
