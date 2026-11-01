import { useEffect, useState } from "react";
import type { OnboardingStatus } from "../../types";
import { formatCommand } from "./commands";

/**
 * Which checkboxes a freshly opened wizard starts with.
 *
 * When `agent-team.yaml` already lists commands, the file wins and the
 * detection's own `selected` flags are ignored; without a file, the detected
 * defaults are used as they are.
 */
function preselection(status: OnboardingStatus): Set<number> {
  const configured = new Set(status.current.commands.map(formatCommand));
  const useCurrent = status.source === "file" && configured.size > 0;
  return new Set(
    status.detection.commands.flatMap((entry, index) =>
      (useCurrent ? configured.has(formatCommand(entry.command)) : entry.selected) ? [index] : [],
    ),
  );
}

function toggled(current: Set<number>, index: number): Set<number> {
  const next = new Set(current);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export interface CommandPicks {
  picked: Set<number>;
  toggle(index: number): void;
  /** The extra command line the user typed, unparsed. */
  custom: string;
  setCustom(value: string): void;
}

/**
 * The wizard's state and the single rule that resets it: every time the dialog
 * opens on a new status, the ticks follow that status and the extra command
 * line starts empty.
 */
export function useCommandPicks(open: boolean, status: OnboardingStatus | undefined): CommandPicks {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!open || !status) return;
    setPicked(preselection(status));
    setCustom("");
  }, [open, status]);

  const toggle = (index: number) => setPicked((current) => toggled(current, index));

  return { picked, toggle, custom, setCustom };
}
