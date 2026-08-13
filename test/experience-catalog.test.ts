import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExperienceCatalog } from "../src/experience/catalog.js";
import { extractCandidatesFromRun } from "../src/experience/extract.js";
import { sharedExperienceCatalogPath } from "../src/experience/paths.js";
import { ExperienceService } from "../src/experience/service.js";
import type { RunState } from "../src/state/types.js";
import type { LoadedConfig } from "../src/config/load.js";
import { createDefaultConfig } from "../src/config/defaults.js";

describe("ExperienceCatalog v1", () => {
  it("extracts candidates and only returns verified experiences on retrieve", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-experience-"));
    const catalog = new ExperienceCatalog(ExperienceCatalog.defaultPath(root));

    const candidate = await catalog.extract({
      project: "demo",
      summary: "Prefer sequential strategy when path conflicts are common",
      conditions: ["topology=parallel-dag", "rework-high"],
      sourceRunId: "run-1",
      suiteDigest: "a".repeat(64),
      actor: "test",
      portability: "cross-project",
      tags: ["rework"],
    });
    expect(candidate.status).toBe("candidate");
    expect(candidate.portability).toBe("cross-project");
    expect(await catalog.retrieveVerified()).toEqual([]);

    const verified = await catalog.promote(
      candidate.id,
      "operator",
      "Validated on evaluation suite",
    );
    expect(verified.status).toBe("verified");
    expect(verified.verifiedBy).toBe("operator");

    const hits = await catalog.retrieveVerified({
      actor: "orchestrator",
      query: "sequential",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(candidate.id);
    expect(hits[0]?.hitCount).toBe(1);

    const listed = await catalog.list("candidate");
    expect(listed).toHaveLength(0);
    expect((await catalog.list("verified")).map((entry) => entry.hitCount)).toEqual([1]);
  });

  it("rejects promotion from non-candidate statuses and supports reject audit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-experience-"));
    const catalog = new ExperienceCatalog(
      path.join(root, "catalog.json"),
      () => Date.parse("2026-08-12T00:00:00.000Z"),
    );
    const entry = await catalog.extract({
      project: "demo",
      summary: "Do not open network for review roles",
      sourceRunId: "run-2",
    });
    await catalog.reject(entry.id, "operator", "Not generalizable");
    await expect(catalog.promote(entry.id, "operator", "nope")).rejects.toThrow(
      /cannot be promoted/,
    );
    const rejected = await catalog.list("rejected");
    expect(rejected[0]?.failureReason).toContain("Not generalizable");
  });

  it("retires verified experiences, excludes them from retrieval, and forbids other statuses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-experience-"));
    const catalog = new ExperienceCatalog(
      path.join(root, "catalog.json"),
      () => Date.parse("2026-08-12T00:00:00.000Z"),
    );
    const entry = await catalog.extract({
      project: "demo",
      summary: "Prefer pnpm over npm in this monorepo",
      sourceRunId: "run-3",
    });
    await expect(catalog.retire(entry.id, "operator", "too early")).rejects.toThrow(
      /cannot be retired/,
    );

    await catalog.promote(entry.id, "operator", "Validated on evaluation suite");
    expect(await catalog.retrieveVerified({ query: "pnpm" })).toHaveLength(1);

    const retired = await catalog.retire(entry.id, "operator", "Superseded by workspace policy");
    expect(retired.status).toBe("retired");
    expect(await catalog.retrieveVerified({ query: "pnpm" })).toEqual([]);
    expect(await catalog.list("verified")).toHaveLength(0);
    expect(await catalog.list("retired")).toHaveLength(1);
    // audit keeps both the retire action and the reason
    const doc = await catalog.load();
    expect(doc.audit).toContainEqual(
      expect.objectContaining({
        action: "retire",
        experienceId: entry.id,
        actor: "operator",
        reason: "Superseded by workspace policy",
      }),
    );
    await expect(catalog.retire(entry.id, "operator", "again")).rejects.toThrow(
      /cannot be retired/,
    );
  });

  it("preview retrieval stays read-only (no hitCount or audit growth)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-experience-"));
    const catalog = new ExperienceCatalog(ExperienceCatalog.defaultPath(root));
    const entry = await catalog.extract({
      project: "demo",
      summary: "Retry flaky docker pulls with backoff",
      sourceRunId: "run-4",
    });
    await catalog.promote(entry.id, "operator", "ok");

    const before = await catalog.load();
    const hits = await catalog.retrieveVerified({ query: "docker", recordHit: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.hitCount).toBe(0);
    const after = await catalog.load();
    expect(after.entries[0]?.hitCount).toBe(0);
    expect(after.audit.length).toBe(before.audit.length);

    const counted = await catalog.retrieveVerified({ query: "docker" });
    expect(counted[0]?.hitCount).toBe(1);
  });
});

describe("experience extract + shared service", () => {
  it("extracts portable failure lessons without LLM", () => {
    const state = fixtureRun({
      status: "blocked",
      error: "spawn codex ENOENT",
      tasks: [],
    });
    const candidates = extractCandidatesFromRun(state, "demo");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.summary).toMatch(/Codex|PATH|Homebrew/);
    expect(candidates[0]?.conditions.some((item) => item.includes("找不到 Codex"))).toBe(true);
    expect(candidates[0]?.tags).toContain("失败");
    expect(candidates[0]?.portability).toBe("cross-project");
    expect(candidates[0]?.sensitivity).toBe("low");
  });

  it("does not dump raw English stacks into project-bound summaries", () => {
    const state = fixtureRun({
      status: "blocked",
      error:
        "Error: spawn /usr/bin/foo ENOENT\n    at Process.ChildProcess._handle.onexit (node:internal/child_process:285:19)",
      tasks: [],
    });
    const candidates = extractCandidatesFromRun(state, "demo");
    expect(candidates[0]?.summary).not.toMatch(/ChildProcess|node:internal/);
    expect(candidates[0]?.summary).toMatch(/失败|阻塞/);
  });

  it("injects verified failure experiences for rework queries", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-rework-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const env = { ...process.env, AGENT_TEAM_HOME: home };
    const service = ExperienceService.forLoaded(fixtureLoaded(projectRoot), env);

    const entry = await service.extractFromRun(
      fixtureRun({
        status: "blocked",
        error: "spawn codex ENOENT",
        tasks: [],
      }),
    );
    await service.promote(entry.created[0]!.id, "operator", "ok");
    const rework = await service.retrieveForRework({
      feedback: "codex missing PATH",
      taskTitle: "fix build",
    });
    expect(rework?.items.length).toBeGreaterThan(0);
    expect(rework?.note).toMatch(/返工/);
  });

  it("gates promote when requireSuiteForPromote is enabled", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-suite-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const config = createDefaultConfig("demo");
    config.experience.requireSuiteForPromote = true;
    const loaded: LoadedConfig = {
      root: projectRoot,
      path: path.join(projectRoot, "agent-team.yaml"),
      config,
    };
    const service = ExperienceService.forLoaded(loaded, {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });
    const entry = await service.extractFromRun(
      fixtureRun({ status: "blocked", error: "spawn codex ENOENT", tasks: [] }),
    );
    await expect(
      service.promote(entry.created[0]!.id, "operator", "no suite"),
    ).rejects.toThrow(/suiteDigest|forceWithoutSuite/);
    const forced = await service.promote(entry.created[0]!.id, "operator", "force", {
      forceWithoutSuite: true,
    });
    expect(forced.status).toBe("verified");
  });

  it("promotes project experience into the software-wide shared catalog", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-project-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const env = { ...process.env, AGENT_TEAM_HOME: home };

    const loaded = fixtureLoaded(projectRoot);
    const service = ExperienceService.forLoaded(loaded, env);

    const state = fixtureRun({
      status: "blocked",
      error: "spawn codex ENOENT",
      tasks: [],
    });
    const extracted = await service.extractFromRun(state);
    expect(extracted.created).toHaveLength(1);

    await service.promote(extracted.created[0]!.id, "operator", "确认为桌面 PATH 问题");
    const shared = await service.share(extracted.created[0]!.id, "operator", "跨项目可复用");
    expect(shared.scope).toBe("shared");
    expect(shared.status).toBe("verified");

    const sharedPath = sharedExperienceCatalogPath(env);
    expect(sharedPath.startsWith(home)).toBe(true);

    const snapshot = await service.snapshot();
    expect(snapshot.counts.shared).toBe(1);
    expect(snapshot.counts.verified).toBeGreaterThanOrEqual(1);

    const planning = await service.retrieveForPlanning("启动桌面 codex 失败");
    expect(planning?.items.some((item) => item.scope === "shared")).toBe(true);
  });

  it("extracts evaluation success patterns without injecting unverified candidates", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-project-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const service = ExperienceService.forLoaded(fixtureLoaded(projectRoot), {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });

    const evo = fixtureRun({
      status: "completed",
      purpose: "evolution-evaluation",
      tasks: [
        {
          task: {
            id: "t1",
            title: "x",
            description: "x",
            dependsOn: [],
            ownedPaths: ["src/a.ts"],
            acceptanceCommands: [],
            profile: null,
          },
          status: "merged",
          attempts: 1,
        },
      ],
    });
    const result = await service.extractFromRun(evo);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.tags).toContain("评测");
    expect(result.autoPromoted).toEqual([]);
    // still candidate — not injected until verified
    expect(await service.retrieveForPlanning("评测 策略")).toBeUndefined();
  });

  it("records attempt cards and surfaces them on rework", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-attempt-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const service = ExperienceService.forLoaded(fixtureLoaded(projectRoot), {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });
    await service.recordAttempt({
      runId: "run-a",
      taskId: "t1",
      taskTitle: "api",
      attempt: 1,
      feedback: "owned path violation on src/other.ts",
    });
    const rework = await service.retrieveForRework({
      feedback: "ownedPaths check failed",
      taskId: "t1",
    });
    expect(rework?.recentAttempts?.length).toBeGreaterThan(0);
  });

  it("increments successCount after experience helped a later pass", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-exp-success-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
    const service = ExperienceService.forLoaded(fixtureLoaded(projectRoot), {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });
    const extracted = await service.extractFromRun(
      fixtureRun({ status: "blocked", error: "spawn codex ENOENT", tasks: [] }),
    );
    const verified = await service.promote(extracted.created[0]!.id, "op", "ok");
    expect(verified.successCount).toBe(0);
    const updated = await service.recordSuccess([verified.id]);
    expect(updated).toBe(1);
    const listed = await service.snapshot("verified");
    expect(listed.entries[0]?.successCount).toBe(1);
  });
});

function fixtureLoaded(root: string): LoadedConfig {
  return {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createDefaultConfig("demo"),
  };
}

function fixtureRun(
  partial: Partial<RunState> & Pick<RunState, "status">,
): RunState {
  const now = "2026-08-12T00:00:00.000Z";
  return {
    id: partial.id ?? "run-fixture",
    traceId: "trace",
    goal: partial.goal ?? "demo goal",
    root: "/tmp/demo",
    configPath: "/tmp/demo/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/run/integration",
    integrationWorktree: "/tmp/wt",
    status: partial.status,
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: partial.strategy ?? {
      name: "balanced",
      topology: { mode: "parallel-dag" },
      maxParallel: 2,
      maxReworkAttempts: 1,
      executionTimeoutSeconds: 3600,
      maxAgentInvocations: 32,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks: partial.tasks ?? [],
    history: [{ at: now, status: partial.status, message: "fixture" }],
    ...(partial.error ? { error: partial.error } : {}),
    ...(partial.purpose ? { purpose: partial.purpose } : {}),
  };
}
