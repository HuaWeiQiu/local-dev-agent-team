import type { RunEvidence } from "../../../types";

type TaskEvidence = RunEvidence["tasks"][number];

export type Verdict = "pass" | "fail" | "pending";

export interface EvidenceCell {
  verdict: Verdict;
  label: string;
}

const QUALITY_LABELS: Record<Verdict, string> = {
  pass: "通过",
  fail: "失败",
  pending: "待执行",
};

/** A boolean gate: undefined means it has not run yet. */
export function qualityCell(task: TaskEvidence): EvidenceCell {
  const verdict = verdictOf(task.qualityPassed);
  return { verdict, label: QUALITY_LABELS[verdict] };
}

/** A review or test verdict string: only "approve" counts as a pass. */
export function verdictCell(verdict: string | undefined): EvidenceCell {
  if (!verdict) return { verdict: "pending", label: "待执行" };
  return { verdict: verdict === "approve" ? "pass" : "fail", label: verdict };
}

function verdictOf(passed: boolean | undefined): Verdict {
  if (passed === undefined) return "pending";
  return passed ? "pass" : "fail";
}

export function commitLabel(task: TaskEvidence): string {
  return task.commit?.slice(0, 9) ?? "-";
}

export function taskSubtitle(task: TaskEvidence): string {
  return `${task.id} · ${task.status}`;
}

export function taskCountLabel(count: number): string {
  return `${count} 个任务`;
}
