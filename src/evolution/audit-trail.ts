export type TrailKind = "rejection" | "archive" | "unarchive" | "delete" | string;

export interface TrailViolation {
  /** Position in the retained trail. */
  index: number;
  message(proposalId: string): string;
}

/**
 * The audit trail retained for a deleted proposal must read
 * rejection → (archive | unarchive)* → delete, with no repeats and nothing
 * after the deletion. Both the persisted ledger and the in-memory catalog
 * enforce exactly this; only their error types differ.
 */
export function auditTrailViolation(kinds: readonly TrailKind[]): TrailViolation | undefined {
  if (kinds[0] !== "rejection") return missingRejection();
  if (kinds[kinds.length - 1] !== "delete") return missingTombstone(kinds.length - 1);
  let archived = false;
  for (const [index, kind] of kinds.entries()) {
    const violation = stepViolation(kind, index, kinds.length - 1, archived);
    if (violation) return violation;
    if (kind === "archive") archived = true;
    if (kind === "unarchive") archived = false;
  }
  return undefined;
}

function missingRejection(): TrailViolation {
  return {
    index: 0,
    message: (id) => `begins the retained history of deleted proposal '${id}' without its rejection`,
  };
}

function missingTombstone(index: number): TrailViolation {
  return { index, message: (id) => `references missing proposal '${id}'` };
}

function stepViolation(
  kind: TrailKind,
  index: number,
  last: number,
  archived: boolean,
): TrailViolation | undefined {
  if (kind === "rejection" && index !== 0) {
    return { index, message: (id) => `duplicates rejection for deleted proposal '${id}'` };
  }
  if (kind === "delete" && index !== last) {
    return {
      index,
      message: (id) => `continues the history of deleted proposal '${id}' after its deletion`,
    };
  }
  if (kind === "archive" && archived) {
    return { index, message: (id) => `duplicates archive for deleted proposal '${id}'` };
  }
  if (kind === "unarchive" && !archived) {
    return { index, message: (id) => `unarchives non-archived deleted proposal '${id}'` };
  }
  return undefined;
}
