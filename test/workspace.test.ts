import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { startControlService } from "../src/server/start.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";
import { loadWorkspace } from "../src/workspace/load.js";
import { startWorkspaceControlService } from "../src/workspace/service.js";

describe("multi-project workspace", () => {
  it("loads relative project configs and rejects duplicate IDs and repository roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-workspace-"));
    await writeProject(root, "alpha", "Alpha");
    await writeProject(root, "beta", "Beta");
    const manifestPath = await writeWorkspace(root, [
      { id: "alpha", config: "./alpha/agent-team.yaml" },
      { id: "beta", config: "./beta/agent-team.yaml" },
    ]);

    const workspace = await loadWorkspace(root, manifestPath);
    expect(workspace.projects.map((project) => project.id)).toEqual(["alpha", "beta"]);
    expect(workspace.projects.map((project) => project.loaded.config.project.name)).toEqual([
      "Alpha",
      "Beta",
    ]);

    await writeWorkspace(root, [
      { id: "same", config: "./alpha/agent-team.yaml" },
      { id: "same", config: "./beta/agent-team.yaml" },
    ]);
    await expect(loadWorkspace(root, manifestPath)).rejects.toThrow("Duplicate project ID 'same'");

    await writeWorkspace(root, [
      { id: "first", config: "./alpha/agent-team.yaml" },
      { id: "second", config: "./alpha/agent-team.yaml" },
    ]);
    await expect(loadWorkspace(root, manifestPath)).rejects.toThrow(
      "resolve to the same repository root",
    );
  });

  it("serves isolated project APIs and releases every lease on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-workspace-"));
    const alphaRoot = await writeProject(root, "alpha", "Alpha");
    const betaRoot = await writeProject(root, "beta", "Beta");
    await saveRun(alphaRoot, "alpha-run", "Build Alpha");
    await saveRun(betaRoot, "beta-run", "Build Beta");
    const manifestPath = await writeWorkspace(root, [
      { id: "alpha", config: "./alpha/agent-team.yaml" },
      { id: "beta", config: "./beta/agent-team.yaml" },
    ]);
    const workspace = await loadWorkspace(root, manifestPath);
    const service = await startWorkspaceControlService(workspace, { port: 0 });

    const discovery = await fetch(`${service.url}/api/workspace`).then(
      async (response) => await response.json() as { mode: string; projects: Array<{ id: string }> },
    );
    expect(discovery).toMatchObject({
      mode: "workspace",
      defaultProjectId: "alpha",
      connectedCount: 2,
      registeredCount: 2,
      projects: [
        { id: "alpha", name: "Alpha", defaultBranch: "main" },
        { id: "beta", name: "Beta", defaultBranch: "main" },
      ],
    });
    expect(discovery.registry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alpha", connected: true }),
        expect.objectContaining({ id: "beta", connected: true }),
      ]),
    );
    expect(await listRunIds(service.url, "alpha")).toEqual(["alpha-run"]);
    expect(await listRunIds(service.url, "beta")).toEqual(["beta-run"]);
    expect((await fetch(`${service.url}/api/projects/missing/runs`)).status).toBe(404);
    expect((await fetch(`${service.url}/api/runs`)).status).toBe(404);
    expect((await fetch(`${service.url}/api`)).status).toBe(404);

    await service.close();
    for (const project of workspace.projects) {
      const recovered = await startControlService(project.loaded, { port: 0 });
      await recovered.close();
    }
  });

  it("cleans up projects opened before a later lease failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-workspace-"));
    const alphaRoot = await writeProject(root, "alpha", "Alpha");
    const betaRoot = await writeProject(root, "beta", "Beta");
    const manifestPath = await writeWorkspace(root, [
      { id: "alpha", config: "./alpha/agent-team.yaml" },
      { id: "beta", config: "./beta/agent-team.yaml" },
    ]);
    const workspace = await loadWorkspace(root, manifestPath);
    const occupied = await startControlService(await loadConfig(betaRoot), { port: 0 });
    try {
      await expect(startWorkspaceControlService(workspace, { port: 0 })).rejects.toThrow(
        "Another control service is already running",
      );
      const recovered = await startControlService(await loadConfig(alphaRoot), { port: 0 });
      await recovered.close();
    } finally {
      await occupied.close();
    }
  });
});

async function writeProject(root: string, directory: string, name: string): Promise<string> {
  const projectRoot = path.join(root, directory);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "agent-team.yaml"),
    stringifyYaml(createDefaultConfig(name)),
    "utf8",
  );
  return projectRoot;
}

async function writeWorkspace(
  root: string,
  projects: Array<{ id: string; config: string }>,
): Promise<string> {
  const target = path.join(root, "agent-team.workspace.yaml");
  await writeFile(target, stringifyYaml({ version: 1, projects }), "utf8");
  return target;
}

async function saveRun(root: string, id: string, goal: string): Promise<void> {
  const now = new Date().toISOString();
  const state: RunState = {
    id,
    goal,
    root,
    configPath: path.join(root, "agent-team.yaml"),
    baseBranch: "main",
    baseCommit: "abc123",
    integrationBranch: `agent-team/${id}/integration`,
    integrationWorktree: path.join(root, ".agent-team", "worktrees", id),
    status: "completed",
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
    tasks: [],
    history: [],
  };
  await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);
}

async function listRunIds(serviceUrl: string, projectId: string): Promise<string[]> {
  const response = await fetch(`${serviceUrl}/api/projects/${projectId}/runs`);
  expect(response.status).toBe(200);
  const body = await response.json() as { runs: Array<{ id: string }> };
  return body.runs.map((run) => run.id);
}
