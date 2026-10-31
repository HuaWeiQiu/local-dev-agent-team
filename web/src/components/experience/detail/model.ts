import { formatExperienceCondition, formatExperienceTag } from "../../../presentation";
import type { ExperienceEntry } from "../../../types";

export interface ExperienceActions {
  promote: boolean;
  share: boolean;
  retire: boolean;
  reject: boolean;
  readOnly: boolean;
}

const MAX_CONDITIONS = 5;
const MAX_TAGS = 6;

/** Which buttons an entry earns, from its scope, status and portability. */
export function actionsFor(entry: ExperienceEntry): ExperienceActions {
  const promote = entry.scope === "project" && entry.status === "candidate";
  const share =
    entry.scope === "project" &&
    entry.status === "verified" &&
    entry.sensitivity === "low" &&
    entry.portability === "cross-project";
  const reject = entry.status === "candidate" || entry.status === "verified";
  const retire = entry.status === "verified";
  return { promote, share, retire, reject, readOnly: !promote && !share && !reject && !retire };
}

export function conditionLabels(entry: ExperienceEntry): string[] {
  return entry.conditions.slice(0, MAX_CONDITIONS).map(formatExperienceCondition);
}

export function tagLabels(entry: ExperienceEntry): string[] {
  return entry.tags.slice(0, MAX_TAGS).map(formatExperienceTag);
}

export function portabilityLabel(entry: ExperienceEntry): string {
  return entry.portability === "cross-project" ? "可跨项目" : "仅本项目";
}
