import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RunState } from "../state/types.js";
import { assertRunId, RunStateStore } from "../state/store.js";
import type {
  EvidenceArtifact,
  EvidenceCheck,
  EvidenceFilePreview,
  IntegrationDiffEvidence,
  RunEvidence,
} from "./types.js";

const maxArtifactEntries = 1_000;
const maxPreviewBytes = 256 * 1024;
const previewableExtensions = new Set([
  ".diff",
  ".json",
  ".log",
  ".md",
  ".patch",
  ".txt",
  ".yaml",
  ".yml",
]);

export class LocalEvidenceStore {
  constructor(private readonly states: RunStateStore) {}

  async listArtifacts(runId: string): Promise<EvidenceArtifact[]> {
    assertRunId(runId);
    const root = this.states.artifactDirectory(runId);
    const artifacts: EvidenceArtifact[] = [];
    await walkArtifacts(root, root, artifacts).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    return artifacts.sort((left, right) => left.path.localeCompare(right.path));
  }

  async readArtifact(runId: string, relativePath: string): Promise<EvidenceFilePreview> {
    const normalized = normalizeArtifactPath(relativePath);
    if (!isPreviewableArtifact(normalized)) {
      throw new Error(`Artifact '${normalized}' is not a previewable text file`);
    }
    const segments = normalized.split("/");
    const root = this.states.artifactDirectory(runId);
    const target = this.states.artifactDirectory(runId, ...segments);
    let targetStats;
    try {
      targetStats = await validateArtifactPath(root, segments, normalized);
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`Artifact '${normalized}' was not found`);
      }
      throw error;
    }
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error(`Artifact '${normalized}' is not a regular file`);
    }
    const contents = await readFile(target);
    const truncated = contents.byteLength > maxPreviewBytes;
    return {
      path: normalized,
      size: targetStats.size,
      content: contents.subarray(0, maxPreviewBytes).toString("utf8"),
      truncated,
    };
  }

  async runBytes(runId: string): Promise<number> {
    assertRunId(runId);
    return await directoryBytes(this.states.runDirectory(runId));
  }
}

export function buildRunEvidence(
  state: RunState,
  artifacts: EvidenceArtifact[],
  diff: IntegrationDiffEvidence,
): RunEvidence {
  const checks = evidenceChecks(state);
  const hasFailure = checks.some((check) => check.status === "fail");
  const allPassed = checks.every((check) => check.status === "pass");
  const attentionStatuses = new Set(["blocked", "cancelled", "interrupted", "ci-failed"]);
  const readiness = allPassed && ["ready-to-merge", "completed"].includes(state.status)
    ? "ready"
    : hasFailure || attentionStatuses.has(state.status)
      ? "attention"
      : "in-progress";
  return {
    runId: state.id,
    status: state.status,
    readiness,
    checks,
    tasks: state.tasks.map((task) => ({
      id: task.task.id,
      title: task.task.title,
      status: task.status,
      attempts: task.attempts,
      ...(task.commit ? { commit: task.commit } : {}),
      ...(task.quality ? { qualityPassed: task.quality.passed } : {}),
      ...(task.review ? { reviewVerdict: task.review.verdict } : {}),
      ...(task.test ? { testVerdict: task.test.verdict } : {}),
      findingCount: task.review?.findings.length ?? 0,
    })),
    artifacts,
    artifactBytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
    diff,
  };
}

function evidenceChecks(state: RunState): EvidenceCheck[] {
  const taskFailures = state.tasks.filter((task) => task.status === "blocked").length;
  const tasksPassed = state.tasks.length > 0 && state.tasks.every((task) => task.status === "merged");
  const tasks: EvidenceCheck = taskFailures > 0
    ? { id: "tasks", label: "任务集成", status: "fail", detail: `${taskFailures} 个任务已阻塞` }
    : tasksPassed
      ? { id: "tasks", label: "任务集成", status: "pass", detail: `${state.tasks.length} 个任务已合并` }
      : { id: "tasks", label: "任务集成", status: "pending", detail: `${state.tasks.filter((task) => task.status === "merged").length}/${state.tasks.length} 个任务已合并` };
  const quality: EvidenceCheck = state.finalQuality
    ? {
        id: "quality",
        label: "最终质量门禁",
        status: state.finalQuality.passed ? "pass" : "fail",
        detail: state.finalQuality.passed ? "全部命令通过" : "存在失败的质量命令",
      }
    : { id: "quality", label: "最终质量门禁", status: "pending", detail: "尚未执行" };
  const decision: EvidenceCheck = state.finalDecision
    ? {
        id: "decision",
        label: "交付审查",
        status: state.finalDecision.decision === "ready" ? "pass" : "fail",
        detail: state.finalDecision.reason,
      }
    : { id: "decision", label: "交付审查", status: "pending", detail: "尚无最终判定" };
  const finalApproval = state.approvals?.filter((approval) => approval.gate === "final").at(-1);
  const approval: EvidenceCheck = !state.strategy.approvalGates.includes("final")
    ? { id: "approval", label: "交付审批", status: "pass", detail: "策略未要求最终审批" }
    : finalApproval
      ? {
          id: "approval",
          label: "交付审批",
          status: finalApproval.status === "approved" ? "pass" : finalApproval.status === "rejected" ? "fail" : "pending",
          detail: finalApproval.status === "approved"
            ? `已由 ${finalApproval.response?.actor ?? "操作者"} 批准`
            : finalApproval.status === "rejected"
              ? `已由 ${finalApproval.response?.actor ?? "操作者"} 拒绝`
              : "等待人工核对证据",
        }
      : { id: "approval", label: "交付审批", status: "pending", detail: "尚未进入审批边界" };
  return [tasks, quality, decision, approval];
}

async function walkArtifacts(
  root: string,
  current: string,
  artifacts: EvidenceArtifact[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (artifacts.length >= maxArtifactEntries) return;
    const target = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkArtifacts(root, target, artifacts);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await lstat(target);
    const relative = path.relative(root, target).split(path.sep).join("/");
    artifacts.push({
      path: relative,
      size: stats.size,
      kind: artifactKind(relative),
      previewable: isPreviewableArtifact(entry.name),
    });
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      total += (await lstat(target)).size;
    } else if (entry.isDirectory()) {
      total += await directoryBytes(target);
    } else if (entry.isFile()) {
      total += (await lstat(target)).size;
    }
  }
  return total;
}

function normalizeArtifactPath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be relative");
  }
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifact path contains an invalid segment");
  }
  return segments.join("/");
}

function isPreviewableArtifact(name: string): boolean {
  return previewableExtensions.has(path.extname(name).toLowerCase());
}

async function validateArtifactPath(
  root: string,
  segments: string[],
  relativePath: string,
) {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    const isLeaf = index === segments.length - 1;
    if (
      stats.isSymbolicLink() ||
      (isLeaf ? !stats.isFile() : !stats.isDirectory())
    ) {
      throw new Error(`Artifact '${relativePath}' is not a regular file`);
    }
    if (isLeaf) return stats;
  }
  throw new Error(`Artifact '${relativePath}' was not found`);
}

function artifactKind(relativePath: string): EvidenceArtifact["kind"] {
  const segments = relativePath.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  if (name === "context.json" || name.endsWith(".schema.json")) return "context";
  if (segments.includes("quality") || /^\d+\.log$/.test(name)) return "quality";
  if (segments.includes("review")) return "review";
  if (segments.includes("test")) return "test";
  if (["stdout.log", "stderr.log", "last-message.json"].includes(name)) return "agent-output";
  return "other";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
