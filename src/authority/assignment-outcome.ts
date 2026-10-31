/**
 * How a run's final status reads as an Assignment outcome.
 *
 * The two vocabularies are deliberately separate: a run has many statuses because
 * the workflow has many stages, while an Assignment only needs to say whether the
 * work finished, failed, is waiting on a person, or was interrupted. Anything
 * this map does not name counts as `failed`, because an unknown end state is not
 * evidence that the work succeeded.
 */

import type { RunStatus } from "../state/types.js";
import type { AssignmentOutcome } from "./ticket.js";

const OUTCOMES: Partial<Record<RunStatus, AssignmentOutcome>> = {
  completed: "completed",
  "ready-to-merge": "completed",
  publishing: "completed",
  "waiting-ci": "completed",
  blocked: "blocked",
  "ci-failed": "failed",
  repairing: "failed",
  cancelled: "interrupted",
  interrupted: "interrupted",
};

export function assignmentOutcome(status: RunStatus | undefined): AssignmentOutcome {
  if (!status) return "interrupted";
  return OUTCOMES[status] ?? "failed";
}
