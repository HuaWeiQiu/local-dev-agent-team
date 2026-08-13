import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { buildRunEvidence, type LocalEvidenceStore } from "../evidence/local.js";
import type {
  EvidenceFilePreview,
  IntegrationDiffEvidence,
  RunCleanupCandidate,
  RunCleanupPreview,
  RunCleanupResult,
  RunEvidence,
} from "../evidence/types.js";
import type { SqliteEventStore } from "../events/store.js";
import { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState, RunUsage } from "../state/types.js";
import { branchSegment } from "../workflow/id.js";

export interface RunUsageDetail {
  agentInvocations: number;
  agentDurationMs: number;
  processOutputBytes: number;
  truncatedStreams: number;
  artifactBytes: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  costReported: boolean;
}

export interface RunUsageEntry {
  runId: string;
  goal: string;
  status: RunState["status"];
  strategy: string;
  createdAt: string;
  updatedAt: string;
  usage: RunUsageDetail;
}

export interface UsageReport {
  generatedAt: string;
  runCount: number;
  totals: RunUsageDetail;
  runs: RunUsageEntry[];
}

/**
 * Callbacks into RunSupervisor for the pieces of live-run state that retention
 * must consult (active map, action queues) without owning them.
 */
export interface RunRetentionHooks {
  get(runId: string): Promise<RunState | undefined>;
  requireRun(runId: string): Promise<RunState>;
  isActive(runId: string): boolean;
  hasActiveChild(runId: string): boolean;
  serializeActions<T>(runIds: string[], action: () => Promise<T>): Promise<T>;
}

export class RunRetention {
  private readonly cleanupPreviews = new Map<string, CleanupPreviewSnapshot>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly stateStore: RunStateStore,
    private readonly evidenceStore: LocalEvidenceStore,
    private readonly events: SqliteEventStore,
    private readonly hooks: RunRetentionHooks,
  ) {}

  async usageReport(): Promise<UsageReport> {
    const states = await this.stateStore.list();
    const runs: RunUsageEntry[] = states
      .map((state) => ({
        runId: state.id,
        goal: state.goal,
        status: state.status,
        strategy: state.strategy.name,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        usage: usageDetail(state.usage),
      }))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
      );
    const totals = runs.reduce(
      (acc, entry) => ({
        agentInvocations: acc.agentInvocations + entry.usage.agentInvocations,
        agentDurationMs: acc.agentDurationMs + entry.usage.agentDurationMs,
        processOutputBytes: acc.processOutputBytes + entry.usage.processOutputBytes,
        truncatedStreams: acc.truncatedStreams + entry.usage.truncatedStreams,
        artifactBytes: acc.artifactBytes + entry.usage.artifactBytes,
        inputTokens: acc.inputTokens + entry.usage.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + entry.usage.cachedInputTokens,
        outputTokens: acc.outputTokens + entry.usage.outputTokens,
        reportedCostUsd: acc.reportedCostUsd + entry.usage.reportedCostUsd,
        costReported: acc.costReported || entry.usage.costReported,
      }),
      {
        agentInvocations: 0,
        agentDurationMs: 0,
        processOutputBytes: 0,
        truncatedStreams: 0,
        artifactBytes: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reportedCostUsd: 0,
        costReported: false,
      },
    );
    return {
      generatedAt: new Date().toISOString(),
      runCount: runs.length,
      totals,
      runs,
    };
  }

  async evidence(runId: string): Promise<RunEvidence | undefined> {
    const state = await this.hooks.get(runId);
    if (!state) return undefined;
    const [artifacts, diff] = await Promise.all([
      this.evidenceStore.listArtifacts(runId),
      this.integrationDiff(state),
    ]);
    return buildRunEvidence(state, artifacts, diff);
  }

  async evidenceFile(runId: string, relativePath: string): Promise<EvidenceFilePreview> {
    await this.hooks.requireRun(runId);
    return await this.evidenceStore.readArtifact(runId, relativePath);
  }

  async previewCleanup(olderThanDays: number): Promise<RunCleanupPreview> {
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 3_650) {
      throw new Error("Cleanup age must be an integer from 0 to 3650 days");
    }
    this.expireCleanupPreviews();
    // 0 = all eligible terminal runs (updatedAt < now + 1s effectively all past)
    const cutoff =
      olderThanDays === 0
        ? new Date(Date.now() + 1_000).toISOString()
        : new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const allStates = await this.stateStore.list();
    const protectedParents = new Set(allStates.map((state) => state.parentRunId).filter((id): id is string => Boolean(id)));
    const states = allStates.filter(
      (state) => cleanupStatuses.has(state.status) && state.updatedAt < cutoff && !protectedParents.has(state.id) && !this.hooks.hasActiveChild(state.id),
    );
    const candidates = await Promise.all(states.map(async (state): Promise<RunCleanupCandidate> => ({
      id: state.id,
      goal: state.goal,
      status: state.status as RunCleanupCandidate["status"],
      updatedAt: state.updatedAt,
      bytes: await this.evidenceStore.runBytes(state.id),
    })));
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + cleanupPreviewTtlMs).toISOString();
    this.cleanupPreviews.set(token, { expiresAt, candidates });
    return {
      token,
      expiresAt,
      olderThanDays,
      cutoff,
      candidates,
      totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    };
  }

  async cleanup(token: string): Promise<RunCleanupResult> {
    this.expireCleanupPreviews();
    const preview = this.cleanupPreviews.get(token);
    if (!preview) {
      throw new Error("Cleanup preview is missing or expired; create a new preview");
    }
    this.cleanupPreviews.delete(token);

    return await this.hooks.serializeActions(preview.candidates.map((candidate) => candidate.id), async () => {
      const currentStates = await this.stateStore.list();
      const currentById = new Map(currentStates.map((state) => [state.id, state]));
      const protectedParents = new Set(currentStates.map((state) => state.parentRunId).filter((id): id is string => Boolean(id)));
      for (const candidate of preview.candidates) {
        const current = currentById.get(candidate.id);
        if (
          !current ||
          current.status !== candidate.status ||
          current.updatedAt !== candidate.updatedAt ||
          !cleanupStatuses.has(current.status) ||
          this.hooks.isActive(candidate.id) ||
          this.hooks.hasActiveChild(candidate.id) ||
          protectedParents.has(candidate.id)
        ) {
          throw new Error(`Run '${candidate.id}' changed after preview; create a new preview`);
        }
      }

      const deletedRunIds: string[] = [];
      let reclaimedBytes = 0;
      for (const candidate of preview.candidates) {
        const quarantined = await this.stateStore.quarantine(candidate.id);
        try {
          this.events.deleteRun(candidate.id);
        } catch (error) {
          await this.stateStore.restoreQuarantined(quarantined);
          throw error;
        }
        await this.stateStore.removeQuarantined(quarantined);
        await this.removeRunGitArtifacts(candidate.id);
        deletedRunIds.push(candidate.id);
        reclaimedBytes += candidate.bytes;
      }
      return { deletedRunIds, reclaimedBytes };
    });
  }

  /**
   * Delete one terminal run immediately (blocked/cancelled/completed/interrupted).
   * Active runs, parents of retained children, and non-terminal statuses are rejected.
   */
  async deleteRun(runId: string): Promise<RunCleanupResult> {
    return await this.hooks.serializeActions([runId], async () => {
      const state = await this.hooks.requireRun(runId);
      if (this.hooks.isActive(runId)) {
        throw new Error(`Run '${runId}' is still active; cancel it first`);
      }
      if (!cleanupStatuses.has(state.status)) {
        throw new Error(
          `Run '${runId}' status '${state.status}' cannot be deleted; only completed, cancelled, blocked, or interrupted runs`,
        );
      }
      if (this.hooks.hasActiveChild(runId)) {
        throw new Error(`Run '${runId}' still has an active child run`);
      }
      const allStates = await this.stateStore.list();
      const protectedParents = new Set(
        allStates.map((item) => item.parentRunId).filter((id): id is string => Boolean(id)),
      );
      if (protectedParents.has(runId)) {
        throw new Error(`Run '${runId}' is still referenced as a parent of another retained run`);
      }
      const bytes = await this.evidenceStore.runBytes(runId);
      const quarantined = await this.stateStore.quarantine(runId);
      try {
        this.events.deleteRun(runId);
      } catch (error) {
        await this.stateStore.restoreQuarantined(quarantined);
        throw error;
      }
      await this.stateStore.removeQuarantined(quarantined);
      await this.removeRunGitArtifacts(runId);
      return { deletedRunIds: [runId], reclaimedBytes: bytes };
    });
  }

  clearPreviews(): void {
    this.cleanupPreviews.clear();
  }

  /**
   * Startup sweep for worktree directories whose run id no longer exists in
   * the state store — e.g. runs deleted before worktree cleanup existed, or
   * runs whose state was quarantined by an interrupted cleanup. Only
   * directories matching the generated run-id shape are touched, and known
   * run ids are always preserved.
   */
  async sweepUnknownRunArtifacts(): Promise<{
    removedDirectories: string[];
    removedBranches: number;
  }> {
    const states = await this.stateStore.list();
    const known = new Set(states.map((state) => state.id));
    const worktreesRoot = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    let entries: string[] = [];
    try {
      entries = await readdir(worktreesRoot);
    } catch {
      return { removedDirectories: [], removedBranches: 0 };
    }
    const removedDirectories: string[] = [];
    let removedBranches = 0;
    for (const entry of entries) {
      if (!runIdShape.test(entry) || known.has(entry)) {
        continue;
      }
      removedBranches += await this.removeRunGitArtifacts(entry);
      removedDirectories.push(entry);
    }
    return { removedDirectories, removedBranches };
  }

  /**
   * Remove every Git worktree (task variants and integration) and local
   * branch a deleted run left behind. Best-effort: the run record is already
   * terminal and deleted, so failures only warn — they never resurrect or
   * block the deletion.
   */
  private async removeRunGitArtifacts(runId: string): Promise<number> {
    const worktreesRoot = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    const runWorktrees = path.join(worktreesRoot, runId);
    let entries: Dirent[] = [];
    try {
      entries = await readdir(runWorktrees, { withFileTypes: true });
    } catch {
      entries = [];
    }
    // Git operations are best-effort: the project may not be a Git
    // repository at all (test fixtures, non-git project roots), and a
    // deleted run must not resurrect just because cleanup could not run.
    let branchesRemoved = 0;
    try {
      const git = new GitManager(this.loaded.root, worktreesRoot);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const worktree = path.join(runWorktrees, entry.name);
        try {
          await git.removeWorktree(worktree);
        } catch (error) {
          console.warn(
            `[agent-team] failed to remove worktree '${worktree}': ${errorMessage(error)}`,
          );
        }
      }
      const prefix = `agent-team/${branchSegment(runId)}/`;
      const branches = await git.listBranches(`${prefix}*`);
      for (const branch of branches) {
        try {
          await git.deleteBranch(branch);
          branchesRemoved += 1;
        } catch (error) {
          console.warn(
            `[agent-team] failed to delete branch '${branch}': ${errorMessage(error)}`,
          );
        }
      }
      try {
        await git.pruneWorktrees();
      } catch (error) {
        console.warn(
          `[agent-team] failed to prune stale worktree registrations: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      console.warn(
        `[agent-team] skipped Git cleanup for run '${runId}': ${errorMessage(error)}`,
      );
    }
    try {
      await rm(runWorktrees, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `[agent-team] failed to remove run directory '${runWorktrees}': ${errorMessage(error)}`,
      );
    }
    return branchesRemoved;
  }

  private async integrationDiff(state: RunState): Promise<IntegrationDiffEvidence> {
    const targetCommit = state.checkpoints?.at(-1)?.integrationCommit;
    if (!targetCommit) {
      return {
        available: false,
        baseCommit: state.baseCommit,
        changedFiles: [],
        truncated: false,
        detail: "尚未生成持久化集成检查点",
      };
    }
    const git = new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
    try {
      const diff = await git.diffBetween(state.baseCommit, targetCommit);
      return {
        available: true,
        baseCommit: state.baseCommit,
        targetCommit,
        changedFiles: diff.changedFiles,
        content: diff.content,
        truncated: diff.truncated,
      };
    } catch {
      return {
        available: false,
        baseCommit: state.baseCommit,
        targetCommit,
        changedFiles: [],
        truncated: false,
        detail: "记录的 Git 检查点当前不可读取",
      };
    }
  }

  private expireCleanupPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.cleanupPreviews) {
      if (Date.parse(preview.expiresAt) <= now) this.cleanupPreviews.delete(token);
    }
  }
}

interface CleanupPreviewSnapshot {
  expiresAt: string;
  candidates: RunCleanupCandidate[];
}

const cleanupPreviewTtlMs = 5 * 60_000;

const cleanupStatuses = new Set<RunState["status"]>([
  "completed",
  "cancelled",
  "blocked",
  "interrupted",
]);

function usageDetail(usage: RunUsage | undefined): RunUsageDetail {
  return {
    agentInvocations: usage?.agentInvocations ?? 0,
    agentDurationMs: usage?.agentDurationMs ?? 0,
    processOutputBytes: usage?.processOutputBytes ?? 0,
    truncatedStreams: usage?.truncatedStreams ?? 0,
    artifactBytes: usage?.artifactBytes ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reportedCostUsd: usage?.reportedCostUsd ?? 0,
    costReported: usage?.reportedCostUsd !== undefined,
  };
}

/**
 * Generated run ids look like `20260812T081838Z-<goal-slug>-<6 hex chars>`
 * (see createRunId). The sweep only ever touches directories with this shape.
 */
const runIdShape = /^\d{8}T\d{6}Z-[a-z0-9-]+-[a-f0-9]{6}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
