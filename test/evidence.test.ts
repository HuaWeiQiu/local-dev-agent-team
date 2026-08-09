import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunEvidence, LocalEvidenceStore } from "../src/evidence/local.js";
import type { RunState } from "../src/state/types.js";
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
