import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { SqliteEventStore } from "../events/store.js";
import { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { ApprovalRequest, RunCheckpoint, RunState } from "../state/types.js";
import { legacyApprovalTimeoutSeconds } from "../strategies/defaults.js";
import type { ApprovalResponseRequest } from "./contracts.js";

/**
 * Callbacks into RunSupervisor for behavior shared with the live-run
 * lifecycle (approval responses are recorded through the same path whether
 * they come from an HTTP response or from startup reconciliation).
 */
export interface RunRecoveryHooks {
  recordApprovalResponse(
    state: RunState,
    approval: ApprovalRequest,
    response: Pick<ApprovalResponseRequest, "decision" | "actor" | "reason">,
  ): Promise<void>;
}

export class RunRecovery {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly stateStore: RunStateStore,
    private readonly events: SqliteEventStore,
    private readonly hooks: RunRecoveryHooks,
  ) {}

  async reconcileApprovalBoundary(state: RunState): Promise<boolean> {
    const checkpoint = await this.rebuildMissingCheckpoint(state);
    const requiredGate = checkpoint ? requiredApprovalGate(state, checkpoint.stage) : undefined;
    const approval = requiredGate
      ? state.approvals?.find(
          (item) => item.gate === requiredGate && item.checkpointId === checkpoint?.id,
        )
      : state.approvals?.at(-1);
    if (checkpoint && requiredGate && !approval) {
      return await this.restoreMissingApprovalRequest(state, checkpoint, requiredGate);
    }
    if (!approval) return false;
    if (approval.status === "pending") {
      return await this.reconcilePendingApproval(state, approval);
    }
    if (approval.status === "rejected") {
      return await this.reconcileRejectedApproval(state, approval);
    }
    if (approval.status === "approved") {
      return await this.reconcileApprovedApproval(state, approval);
    }
    return false;
  }

  /** Rebuilds the final-gate checkpoint for runs persisted before checkpoints existed. */
  private async rebuildMissingCheckpoint(state: RunState): Promise<RunCheckpoint | undefined> {
    const existing = state.checkpoints?.at(-1);
    if (existing) return existing;
    if (
      state.status !== "awaiting-human" ||
      !state.finalQuality?.passed ||
      state.finalDecision?.decision !== "ready"
    ) {
      return undefined;
    }
    const git = this.integrationGitManager();
    const [integrationCommit, clean] = await Promise.all([
      git.currentCommit(state.integrationWorktree).catch(() => undefined),
      git.isClean(state.integrationWorktree).catch(() => false),
    ]);
    if (!integrationCommit || !clean) return undefined;
    const checkpoint: RunCheckpoint = {
      id: randomUUID(),
      version: 1,
      stage: "local-gates-passed",
      integrationCommit,
      completedTaskIds: state.tasks
        .filter((task) => task.status === "merged")
        .map((task) => task.task.id)
        .sort(),
      createdAt: new Date().toISOString(),
    };
    state.checkpoints = [checkpoint];
    this.events.emit(state.id, "workflow.checkpoint-migrated", checkpoint);
    return checkpoint;
  }

  private async restoreMissingApprovalRequest(
    state: RunState,
    checkpoint: RunCheckpoint,
    requiredGate: ApprovalRequest["gate"],
  ): Promise<boolean> {
    const git = this.integrationGitManager();
    const [currentCommit, clean] = await Promise.all([
      git.currentCommit(state.integrationWorktree).catch(() => undefined),
      git.isClean(state.integrationWorktree).catch(() => false),
    ]);
    if (currentCommit !== checkpoint.integrationCommit || !clean) {
      return false;
    }
    const requestedAt = new Date();
    const approval: ApprovalRequest = {
      id: randomUUID(),
      gate: requiredGate,
      status: "pending",
      summary: requiredGate === "plan"
        ? `Approve ${state.tasks.length} planned task(s) before worker execution`
        : "All local gates passed; approve the integration result before publication",
      checkpointId: checkpoint.id,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(
        requestedAt.getTime() + (state.strategy.approvalTimeoutSeconds ?? legacyApprovalTimeoutSeconds) * 1_000,
      ).toISOString(),
    };
    state.approvals = [...(state.approvals ?? []), approval];
    await this.stateStore.transition(state, "awaiting-human", approval.summary);
    this.events.emit(state.id, "approval.requested", approval);
    return true;
  }

  private integrationGitManager(): GitManager {
    return new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
  }

  private async reconcilePendingApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (Date.now() > Date.parse(approval.expiresAt)) {
      await this.hooks.recordApprovalResponse(state, approval, {
        decision: "rejected",
        actor: "system:approval-expiry",
        reason: `Approval request expired at ${approval.expiresAt}`,
      });
      state.error = approval.response!.reason;
      await this.stateStore.transition(state, "blocked", state.error);
      return true;
    }
    if (state.status !== "awaiting-human") {
      await this.stateStore.transition(state, "awaiting-human", approval.summary);
      return true;
    }
    return false;
  }

  private async reconcileRejectedApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (state.status === "blocked") return false;
    state.error = `Approval rejected by ${approval.response?.actor ?? "unknown"}: ${approval.response?.reason ?? "no reason"}`;
    await this.stateStore.transition(state, "blocked", state.error);
    return true;
  }

  private async reconcileApprovedApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (approval.gate === "final" && state.status !== "ready-to-merge") {
      delete state.error;
      await this.stateStore.transition(state, "ready-to-merge", "Recovered final approval response");
      return true;
    }
    if (approval.gate === "plan" && state.status === "awaiting-human") {
      state.error = "Plan approval was recorded before its continuation started";
      await this.stateStore.transition(state, "interrupted", state.error);
      return true;
    }
    return false;
  }
}

function requiredApprovalGate(
  state: RunState,
  stage: import("../state/types.js").CheckpointStage,
): ApprovalRequest["gate"] | undefined {
  if (
    stage === "plan-ready" &&
    (state.strategy.approvalGates ?? ["final"]).includes("plan")
  ) {
    return "plan";
  }
  return stage === "local-gates-passed" ? "final" : undefined;
}
