import type { ExperienceSnapshot } from "../../../types";
import type { ExperienceFilter } from "../model";

type Entry = ExperienceSnapshot["entries"][number];

/** Filter == status, or one of the two scope pseudo-filters. */
function matchesFilter(entry: Entry, filter: ExperienceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "shared") return entry.scope === "shared";
  if (filter === "project") return entry.scope === "project";
  return entry.status === filter;
}

function matchesQuery(entry: Entry, normalized: string): boolean {
  if (!normalized) return true;
  return [
    entry.summary,
    entry.conditions.join(" "),
    entry.tags.join(" "),
    entry.sourceRunId,
    entry.project,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalized);
}

/** Entries visible under the current filter and search box. */
export function filterEntries(
  snapshot: ExperienceSnapshot | undefined,
  filter: ExperienceFilter,
  query: string,
): Entry[] {
  if (!snapshot) return [];
  const normalized = query.trim().toLocaleLowerCase();
  return snapshot.entries.filter(
    (entry) => matchesFilter(entry, filter) && matchesQuery(entry, normalized),
  );
}

/** Keep the current selection while it still exists, else take the first entry. */
export function keepSelection(
  entries: Entry[],
  current: string | undefined,
): string | undefined {
  if (current && entries.some((entry) => entry.id === current)) return current;
  return entries[0]?.id;
}

export function selectedEntry(
  snapshot: ExperienceSnapshot | undefined,
  selectedId: string | undefined,
): Entry | undefined {
  return snapshot?.entries.find((entry) => entry.id === selectedId);
}

export interface ActionInput {
  mode: "promote" | "reject" | "retire" | "share";
  reason: string;
  suiteDigest: string;
  forceWithoutSuite: boolean;
  requireSuite: boolean;
}

/** Dialog validation before any mutation is attempted. */
export function actionError(input: ActionInput): string | undefined {
  if (!input.reason.trim()) return "请填写原因";
  if (input.mode !== "promote") return undefined;
  const digest = input.suiteDigest.trim();
  if (input.requireSuite && !digest && !input.forceWithoutSuite) {
    return "需要填写 suiteDigest，或勾选强制晋升";
  }
  if (digest && !/^[a-f0-9]{64}$/.test(digest)) {
    return "suiteDigest 须为 64 位十六进制 SHA-256";
  }
  return undefined;
}

/** The promote payload, with empty optional fields omitted. */
export function promoteOptions(input: {
  suiteDigest: string;
  forceWithoutSuite: boolean;
}): { suiteDigest?: string; forceWithoutSuite?: boolean } {
  const digest = input.suiteDigest.trim();
  return {
    ...(digest ? { suiteDigest: digest } : {}),
    ...(input.forceWithoutSuite ? { forceWithoutSuite: true } : {}),
  };
}

export function statsOf(snapshot: ExperienceSnapshot): Array<{ label: string; value: number; tone: string }> {
  return [
    { label: "候选", value: snapshot.counts.candidate, tone: "text-warning-ink" },
    { label: "已验证", value: snapshot.counts.verified, tone: "text-success-ink" },
    { label: "公共", value: snapshot.counts.shared, tone: "text-info-ink" },
  ];
}
