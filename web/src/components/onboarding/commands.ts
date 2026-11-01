import type { OnboardingStatus } from "../../types";

/** A command as the wizard stores it: the program and its arguments, never a shell line. */
export interface CommandSpec {
  command: string;
  args: string[];
}

export function formatCommand(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

/** 空白切分；不解析引号，也永远不会交给 shell 执行。 */
export function parseCommandLine(text: string): CommandSpec | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = parts;
  return command ? { command, args } : undefined;
}

/**
 * What the footer saves: the ticked commands in detection order, then the extra
 * line if it parsed into anything.
 */
export function selectedCommands(
  detection: OnboardingStatus["detection"],
  picked: Set<number>,
  extra: CommandSpec | undefined,
): CommandSpec[] {
  return [
    ...detection.commands.filter((_, index) => picked.has(index)).map((entry) => entry.command),
    ...(extra ? [extra] : []),
  ];
}
