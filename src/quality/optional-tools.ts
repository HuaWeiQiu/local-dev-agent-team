import { access } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "../config/schema.js";

/**
 * Optional external tools used as quality gates — not embedded runtimes.
 * Prefer calling installed CLIs (e.g. Alibaba Open Code Review) over reimplementing them.
 */

/** Suggested quality command for OCR when the CLI is installed globally. */
export function ocrReviewCommand(extraArgs: string[] = []): CommandSpec {
  return {
    command: "ocr",
    args: ["review", ...extraArgs],
  };
}

/**
 * Resolve whether a command name is available on PATH (or as an absolute path).
 */
export async function commandAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isPathLike(command)) return await fileExists(command);
  for (const candidate of pathCandidates(command, env)) {
    if (await fileExists(candidate)) return true;
  }
  return false;
}

/** A command with a separator is a path the caller already resolved. */
function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Every place the shell would look, including the Windows executable suffixes. */
function pathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32"
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];
  return directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
}

export async function qualityCommandAvailability(
  commands: CommandSpec[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ command: string; available: boolean; hint?: string }>> {
  const results: Array<{ command: string; available: boolean; hint?: string }> = [];
  for (const spec of commands) {
    const available = await commandAvailable(spec.command, env);
    results.push({
      command: spec.command,
      available,
      ...(spec.command === "ocr" && !available
        ? {
            hint: "Install @alibaba-group/open-code-review (npm i -g) to enable optional OCR quality gate",
          }
        : {}),
    });
  }
  return results;
}
