import { lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactKind, buildRunEvidence, LocalEvidenceStore } from "../src/evidence/local.js";
import type { ApprovalRequest, RunState } from "../src/state/types.js";
import { assertRunId, RunStateStore } from "../src/state/store.js";

describe("local run evidence", () => {
  it("lists and previews bounded run artifacts without following other paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-evidence-"));
    const states = new RunStateStore(path.join(root, "runs"));
    const state = fakeState("evidence-run");
    await states.save(state);
    const quality = states.artifactDirectory(state.id, "tasks", "api", "attempt-1", "quality");
    await mkdir(quality, { recursive: true });
    await writeFile(path.join(quality, "1.log"), "exit: 0\nall tests passed\n", "utf8");
    await writeFile(path.join(quality, "result.bin"), Buffer.from([0, 1, 2]));
    const outside = path.join(root, "outside.log");
    await writeFile(outside, "private", "utf8");
    await symlink(outside, path.join(quality, "outside.log"));
    const outsideDirectory = path.join(root, "outside");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "secret.md"), "private", "utf8");
    await symlink(outsideDirectory, path.join(quality, "outside-directory"));

    const evidence = new LocalEvidenceStore(states);
    const artifacts = await evidence.listArtifacts(state.id);
    expect(artifacts).toEqual([
      expect.objectContaining({
        path: "tasks/api/attempt-1/quality/1.log",
        kind: "quality",
        previewable: true,
      }),
      expect.objectContaining({
        path: "tasks/api/attempt-1/quality/result.bin",
        previewable: false,
      }),
    ]);
    await expect(evidence.readArtifact(state.id, artifacts[0]!.path)).resolves.toMatchObject({
      content: "exit: 0\nall tests passed\n",
      truncated: false,
    });
    await expect(evidence.readArtifact(state.id, "../state.json")).rejects.toThrow(
      "invalid segment",
    );
    await expect(evidence.readArtifact(state.id, artifacts[1]!.path)).rejects.toThrow(
      "not a previewable text file",
    );
    await expect(
      evidence.readArtifact(state.id, "tasks/api/attempt-1/quality/outside.log"),
    ).rejects.toThrow("not a regular file");
    await expect(
      evidence.readArtifact(
        state.id,
        "tasks/api/attempt-1/quality/outside-directory/secret.md",
      ),
    ).rejects.toThrow("not a regular file");
    expect(() => assertRunId("../other-run")).toThrow("Invalid run ID");
    expect(() => states.artifactDirectory(state.id, "..", "state.json")).toThrow(
      "must stay inside",
    );
  });

  it("reads a nested artifact directly without walking the whole tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-evidence-"));
    const states = new RunStateStore(path.join(root, "runs"));
    const state = fakeState("deep-run");
    await states.save(state);
    const nested = states.artifactDirectory(state.id, "tasks", "api", "attempt-1", "review");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "notes.md"), "review notes\n", "utf8");
    // Siblings that a full-tree walk would have to stat; a direct read ignores them.
    const noisy = states.artifactDirectory(state.id, "tasks", "web", "attempt-1");
    await mkdir(noisy, { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(path.join(noisy, `${index}.log`), `noise ${index}\n`, "utf8");
    }
    await writeFile(path.join(noisy, "payload.bin"), Buffer.from([1, 2, 3]));

    const evidence = new LocalEvidenceStore(states);
    await expect(
      evidence.readArtifact(state.id, "tasks/api/attempt-1/review/notes.md"),
    ).resolves.toMatchObject({
      path: "tasks/api/attempt-1/review/notes.md",
      content: "review notes\n",
      truncated: false,
    });

    await expect(
      evidence.readArtifact(state.id, "tasks/api/attempt-1/review/missing.md"),
    ).rejects.toThrow("was not found");
    await expect(
      evidence.readArtifact(state.id, "tasks/web/attempt-1/payload.bin"),
    ).rejects.toThrow("not a previewable text file");
    await expect(evidence.readArtifact(state.id, "..%2f..%2fstate.json")).rejects.toThrow(
      "was not found",
    );
    await expect(evidence.readArtifact(state.id, "/etc/hostname")).rejects.toThrow(
      "must be relative",
    );
  });

  it("builds deterministic approval-oriented readiness checks", () => {
    const state = fakeState("ready-run");
    state.status = "ready-to-merge";
    state.tasks[0]!.status = "merged";
    state.finalQuality = { passed: true, commands: [] };
    state.finalDecision = { decision: "ready", reason: "Local gates passed" };
    state.approvals = [{
      id: "00000000-0000-4000-8000-000000000001",
      gate: "final",
      status: "approved",
      summary: "Approve",
      checkpointId: "00000000-0000-4000-8000-000000000002",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      response: {
        decision: "approved",
        actor: "owner",
        reason: "Reviewed",
        respondedAt: new Date().toISOString(),
      },
    }];
    const evidence = buildRunEvidence(state, [], {
      available: true,
      baseCommit: "1234567",
      targetCommit: "89abcde",
      changedFiles: ["src/api.ts"],
      content: "diff",
      truncated: false,
    });
    expect(evidence.readiness).toBe("ready");
    expect(evidence.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });
});

const fakeDiff = () => ({
  available: true,
  baseCommit: "1234567",
  targetCommit: "89abcde",
  changedFiles: ["src/api.ts"],
  content: "diff",
  truncated: false,
});

/** The shape the store produces: an unanswered gate carries no response at all. */
const finalApproval = (status: ApprovalRequest["status"]): ApprovalRequest => ({
  id: "00000000-0000-4000-8000-000000000001",
  gate: "final",
  status,
  summary: "Approve",
  checkpointId: "00000000-0000-4000-8000-000000000002",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...(status === "pending"
    ? {}
    : {
        response: {
          decision: status,
          actor: "owner",
          reason: "Reviewed",
          respondedAt: new Date().toISOString(),
        },
      }),
});

const checkNamed = (state: RunState, id: string) =>
  buildRunEvidence(state, [], fakeDiff()).checks.find((check) => check.id === id)!;

describe("readiness checks", () => {
  it("reports the four checks in the order the evidence panel renders them", () => {
    // The order is a UI contract: tasks -> quality -> decision -> approval is the
    // order a person reads a run. It lives in one array literal, so an assertion
    // is the only thing that keeps a future edit from reordering the panel.
    expect(buildRunEvidence(fakeState("order-run"), [], fakeDiff()).checks.map((c) => c.id)).toEqual([
      "tasks",
      "quality",
      "decision",
      "approval",
    ]);
  });

  it("fails the task check as soon as one task is blocked, even when others merged", () => {
    const state = fakeState("blocked-run");
    state.tasks = [state.tasks[0]!, { ...state.tasks[0]!, task: { ...state.tasks[0]!.task, id: "web" } }];
    state.tasks[0]!.status = "merged";
    state.tasks[1]!.status = "blocked";
    expect(checkNamed(state, "tasks")).toMatchObject({ status: "fail", detail: "1 个任务已阻塞" });
  });

  it("passes the task check only when every task merged", () => {
    const state = fakeState("merged-run");
    state.tasks[0]!.status = "merged";
    expect(checkNamed(state, "tasks")).toMatchObject({ status: "pass", detail: "1 个任务已合并" });
  });

  it("counts merged tasks against the total while work is in flight", () => {
    const state = fakeState("running-run");
    state.tasks = [state.tasks[0]!, { ...state.tasks[0]!, task: { ...state.tasks[0]!.task, id: "web" } }];
    state.tasks[0]!.status = "merged";
    expect(checkNamed(state, "tasks")).toMatchObject({ status: "pending", detail: "1/2 个任务已合并" });
  });

  it("treats a run with no tasks as pending rather than passed", () => {
    // `[].every(...)` is true, so an empty run would read as "all merged" without
    // the length guard — that is the case this pins down.
    const state = fakeState("empty-run");
    state.tasks = [];
    expect(checkNamed(state, "tasks")).toMatchObject({ status: "pending", detail: "0/0 个任务已合并" });
  });

  it("reports the final quality gate as pending until it ran, then by its verdict", () => {
    const state = fakeState("quality-run");
    expect(checkNamed(state, "quality")).toMatchObject({ status: "pending", detail: "尚未执行" });
    state.finalQuality = { passed: false, commands: [] };
    expect(checkNamed(state, "quality")).toMatchObject({
      status: "fail",
      detail: "存在失败的质量命令",
    });
    state.finalQuality = { passed: true, commands: [] };
    expect(checkNamed(state, "quality")).toMatchObject({ status: "pass", detail: "全部命令通过" });
  });

  it("reports the final decision by its verdict", () => {
    const state = fakeState("decision-run");
    expect(checkNamed(state, "decision")).toMatchObject({ status: "pending", detail: "尚无最终判定" });
    state.finalDecision = { decision: "escalate", reason: "Quality failed" };
    expect(checkNamed(state, "decision")).toMatchObject({ status: "fail", detail: "Quality failed" });
    state.finalDecision = { decision: "ready", reason: "Local gates passed" };
    expect(checkNamed(state, "decision")).toMatchObject({ status: "pass", detail: "Local gates passed" });
  });

  it("passes when the policy does not require a final approval", () => {
    // The only check in this file that passes without anyone doing anything.
    // `skipped` is what separates it from a real approval downstream.
    const state = fakeState("no-gate-run");
    state.strategy.approvalGates = [];
    expect(checkNamed(state, "approval")).toEqual({
      id: "approval",
      label: "交付审批",
      status: "pass",
      detail: "策略未要求最终审批",
      skipped: true,
    });
  });

  it("reads the last final-gate approval and reports approved or rejected", () => {
    const state = fakeState("approval-run");
    state.approvals = [finalApproval("pending"), finalApproval("approved")];
    expect(checkNamed(state, "approval")).toEqual({
      id: "approval",
      label: "交付审批",
      status: "pass",
      detail: "已由 owner 批准",
    });
    state.approvals = [finalApproval("rejected")];
    expect(checkNamed(state, "approval")).toMatchObject({
      status: "fail",
      detail: "已由 owner 拒绝",
    });
  });

  it("keeps the approval check pending when the final gate was requested but not answered", () => {
    const state = fakeState("waiting-run");
    state.approvals = [finalApproval("pending")];
    expect(checkNamed(state, "approval")).toMatchObject({
      status: "pending",
      detail: "等待人工核对证据",
    });
    state.approvals = undefined;
    expect(checkNamed(state, "approval")).toMatchObject({
      status: "pending",
      detail: "尚未进入审批边界",
    });
  });
});

describe("task projection", () => {
  it("carries the optional task evidence only when the task produced it", () => {
    const bare = buildRunEvidence(fakeState("bare-run"), [], fakeDiff()).tasks[0]!;
    expect(bare).toEqual({ id: "api", title: "API", status: "working", attempts: 1, findingCount: 0 });
    expect(bare).not.toHaveProperty("commit");

    const state = fakeState("full-run");
    state.tasks[0]!.commit = "abc1234";
    state.tasks[0]!.quality = { passed: true, commands: [] };
    state.tasks[0]!.review = {
      verdict: "approve",
      summary: "Looks right",
      findings: [
        { severity: "nit", title: "naming", detail: "rename it", path: "src/api.ts" },
        { severity: "blocker", title: "gap", detail: "missing case", path: "src/api.ts" },
      ],
    };
    state.tasks[0]!.test = { verdict: "request_changes", summary: "No coverage", missingTests: ["edge"] };

    expect(buildRunEvidence(state, [], fakeDiff()).tasks[0]).toEqual({
      id: "api",
      title: "API",
      status: "working",
      attempts: 1,
      commit: "abc1234",
      qualityPassed: true,
      reviewVerdict: "approve",
      testVerdict: "request_changes",
      findingCount: 2,
    });
  });
});

describe("delivery readiness", () => {
  it("is ready only when every check passed and the run is mergeable", () => {
    const state = fakeState("ready-run");
    state.status = "ready-to-merge";
    state.tasks[0]!.status = "merged";
    state.finalQuality = { passed: true, commands: [] };
    state.finalDecision = { decision: "ready", reason: "ok" };
    state.approvals = [finalApproval("approved")];
    expect(buildRunEvidence(state, [], fakeDiff()).readiness).toBe("ready");

    // Same passing checks, status not mergeable: the second half of the
    // condition is what stops this from being ready.
    state.status = "implementing";
    expect(buildRunEvidence(state, [], fakeDiff()).readiness).toBe("in-progress");
  });

  it("is attention when a check failed", () => {
    const state = fakeState("failed-run");
    state.tasks[0]!.status = "blocked";
    expect(buildRunEvidence(state, [], fakeDiff()).readiness).toBe("attention");
  });

  it("is attention when the status needs a person, even with no failed check", () => {
    // Nothing here fails: every check is pending, not failed. The status alone
    // has to be enough, which is why the two attention sources cannot be merged.
    const state = fakeState("blocked-status-run");
    state.status = "blocked";
    expect(buildRunEvidence(state, [], fakeDiff()).checks.some((c) => c.status === "fail")).toBe(false);
    expect(buildRunEvidence(state, [], fakeDiff()).readiness).toBe("attention");
  });
});

describe("artifact accounting", () => {
  it("counts files, nested directories and symbolic links by their on-disk size", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-evidence-"));
    const states = new RunStateStore(path.join(root, "runs"));
    const state = fakeState("bytes-run");
    await states.save(state);
    const store = new LocalEvidenceStore(states);
    // Measured as a delta: the run directory also holds state.json, and this case
    // is about what the walk adds, not about the size of the record beside it.
    const before = await store.runBytes(state.id);
    const artifacts = states.artifactDirectory(state.id, "tasks", "api", "attempt-1");
    await mkdir(path.join(artifacts, "quality"), { recursive: true });
    await writeFile(path.join(artifacts, "top.log"), "123456", "utf8");
    await writeFile(path.join(artifacts, "quality", "1.log"), "1234567890", "utf8");
    const outside = path.join(root, "outside.log");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(artifacts, "link.log"));
    // A link contributes the size of the link itself, not of its target, and the
    // walk must not follow it into the tree outside the run.
    const linkBytes = (await lstat(path.join(artifacts, "link.log"))).size;

    await expect(store.runBytes(state.id)).resolves.toBe(before + 6 + 10 + linkBytes);
  });
});

describe("artifact classification", () => {
  it("classifies by rule priority, so a context file inside quality is context", () => {
    expect(artifactKind("tasks/api/attempt-1/quality/context.json")).toBe("context");
    expect(artifactKind("tasks/api/attempt-1/plan.schema.json")).toBe("context");
  });

  it("classifies numbered logs and the quality directory as quality output", () => {
    expect(artifactKind("tasks/api/attempt-1/quality/notes.md")).toBe("quality");
    expect(artifactKind("tasks/api/attempt-1/0.log")).toBe("quality");
  });

  it("classifies review, test, agent output and anything else", () => {
    expect(artifactKind("tasks/api/attempt-1/review/findings.md")).toBe("review");
    expect(artifactKind("tasks/api/attempt-1/test/run.json")).toBe("test");
    expect(artifactKind("tasks/api/attempt-1/stdout.log")).toBe("agent-output");
    expect(artifactKind("tasks/api/attempt-1/last-message.json")).toBe("agent-output");
    expect(artifactKind("tasks/api/attempt-1/notes.md")).toBe("other");
  });

  it("accepts a Windows-style path instead of silently calling everything other", () => {
    // Only `walkArtifacts` calls this today and it already normalises separators;
    // depending on that would turn a Windows caller's every artifact into
    // "other" without raising — a wrong answer is worse than a crash.
    expect(artifactKind("tasks\\api\\attempt-1\\quality\\1.log")).toBe("quality");
    expect(artifactKind("tasks\\api\\attempt-1\\review\\findings.md")).toBe("review");
  });
});

function fakeState(id: string): RunState {
  const now = new Date().toISOString();
  return {
    id,
    goal: "Collect evidence",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "1234567",
    integrationBranch: `agent-team/${id}/integration`,
    integrationWorktree: `/tmp/${id}`,
    status: "implementing",
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks: [{
      task: {
        id: "api",
        title: "API",
        description: "Implement API",
        dependsOn: [],
        ownedPaths: ["src/**"],
        acceptanceCommands: [],
        profile: null,
      },
      status: "working",
      attempts: 1,
    }],
    history: [],
  };
}
