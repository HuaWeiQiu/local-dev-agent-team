import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ApprovalRequest, RunState } from "../state/types.js";
import { assertRunId, type RunStateStore } from "../state/store.js";
import type {
  EvidenceArtifact,
  EvidenceCheck,
  EvidenceFilePreview,
  IntegrationDiffEvidence,
  RunEvidence,
} from "./types.js";

const mergeableStatuses = new Set<string>(["ready-to-merge", "completed"]);
const attentionStatuses = new Set<string>(["blocked", "cancelled", "interrupted", "ci-failed"]);

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
  return {
    runId: state.id,
    status: state.status,
    readiness: resolveReadiness(state, checks),
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

/**
 * The four checks, in the order the evidence panel renders them. The order is a
 * contract with the UI, not an accident of how this array is written: it is the
 * order a person reads tasks -> quality -> decision -> approval.
 */
/**
 * "Ready" needs both halves: every check passed *and* the run reached a
 * mergeable status. Either half alone is not readiness, which is why the two
 * attention sources below cannot be collapsed into one condition — a run can
 * have no failing check and still be blocked.
 */
function resolveReadiness(
  state: RunState,
  checks: EvidenceCheck[],
): RunEvidence["readiness"] {
  const allPassed = checks.every((check) => check.status === "pass");
  if (allPassed && mergeableStatuses.has(state.status)) return "ready";
  const hasFailure = checks.some((check) => check.status === "fail");
  if (hasFailure || attentionStatuses.has(state.status)) return "attention";
  return "in-progress";
}

function evidenceChecks(state: RunState): EvidenceCheck[] {
  return [tasksCheck(state), qualityCheck(state), decisionCheck(state), approvalCheck(state)];
}

/**
 * Blocked tasks outrank the all-merged case: a run with one blocked task and
 * three merged ones has failed, and reporting "3/4 已合并" would read as progress.
 */
function tasksCheck(state: RunState): EvidenceCheck {
  const blocked = state.tasks.filter((task) => task.status === "blocked").length;
  if (blocked > 0) {
    return { id: "tasks", label: "任务集成", status: "fail", detail: `${blocked} 个任务已阻塞` };
  }
  const merged = state.tasks.filter((task) => task.status === "merged").length;
  if (state.tasks.length > 0 && merged === state.tasks.length) {
    return {
      id: "tasks",
      label: "任务集成",
      status: "pass",
      detail: `${state.tasks.length} 个任务已合并`,
    };
  }
  return {
    id: "tasks",
    label: "任务集成",
    status: "pending",
    detail: `${merged}/${state.tasks.length} 个任务已合并`,
  };
}

function qualityCheck(state: RunState): EvidenceCheck {
  if (!state.finalQuality) {
    return { id: "quality", label: "最终质量门禁", status: "pending", detail: "尚未执行" };
  }
  return {
    id: "quality",
    label: "最终质量门禁",
    status: state.finalQuality.passed ? "pass" : "fail",
    detail: state.finalQuality.passed ? "全部命令通过" : "存在失败的质量命令",
  };
}

function decisionCheck(state: RunState): EvidenceCheck {
  if (!state.finalDecision) {
    return { id: "decision", label: "交付审查", status: "pending", detail: "尚无最终判定" };
  }
  return {
    id: "decision",
    label: "交付审查",
    status: state.finalDecision.decision === "ready" ? "pass" : "fail",
    detail: state.finalDecision.reason,
  };
}

/** Only the last final-gate approval counts; earlier ones were superseded. */
function approvalCheck(state: RunState): EvidenceCheck {
  if (!state.strategy.approvalGates.includes("final")) return approvalNotRequired();
  const approval = state.approvals?.filter((entry) => entry.gate === "final").at(-1);
  if (!approval) {
    return { id: "approval", label: "交付审批", status: "pending", detail: "尚未进入审批边界" };
  }
  return { id: "approval", label: "交付审批", ...approvalOutcome(approval) };
}

/**
 * The one check that passes without anyone doing anything. It carries
 * `skipped: true` because `status: "pass"` alone would make "a person approved
 * this" and "this run never needed approval" indistinguishable in the payload.
 */
function approvalNotRequired(): EvidenceCheck {
  return {
    id: "approval",
    label: "交付审批",
    status: "pass",
    detail: "策略未要求最终审批",
    skipped: true,
  };
}

function approvalOutcome(approval: ApprovalRequest): Pick<EvidenceCheck, "status" | "detail"> {
  const actor = approval.response?.actor ?? "操作者";
  if (approval.status === "approved") return { status: "pass", detail: `已由 ${actor} 批准` };
  if (approval.status === "rejected") return { status: "fail", detail: `已由 ${actor} 拒绝` };
  return { status: "pending", detail: "等待人工核对证据" };
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

/**
 * Classification rules in priority order. A data table rather than a chain of
 * ifs because the complexity here is the *number of rules*, and that number
 * grows: adding a rule should be adding a row, not raising the complexity of a
 * function that the quality gate scores.
 *
 * Order is the contract. `quality/context.json` is context, not quality, and
 * `quality/0.log` is quality, not agent output.
 */
const artifactKindRules: Array<{
  kind: EvidenceArtifact["kind"];
  matches: (segments: string[], name: string) => boolean;
}> = [
  {
    kind: "context",
    matches: (_segments, name) => name === "context.json" || name.endsWith(".schema.json"),
  },
  {
    kind: "quality",
    matches: (segments, name) => segments.includes("quality") || /^\d+\.log$/.test(name),
  },
  { kind: "review", matches: (segments) => segments.includes("review") },
  { kind: "test", matches: (segments) => segments.includes("test") },
  {
    kind: "agent-output",
    matches: (_segments, name) =>
      ["stdout.log", "stderr.log", "last-message.json"].includes(name),
  },
];

export function artifactKind(relativePath: string): EvidenceArtifact["kind"] {
  // Normalised here, not in the caller. The only caller happens to pass `/`
  // separators today, and depending on that would make a Windows caller
  // classify every artifact as "other" without failing — a silent wrong answer
  // is worse than a crash.
  const segments = relativePath.replaceAll("\\", "/").toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return artifactKindRules.find((rule) => rule.matches(segments, name))?.kind ?? "other";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
