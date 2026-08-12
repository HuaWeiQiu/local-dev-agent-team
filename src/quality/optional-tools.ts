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
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const parts = pathValue.split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of parts) {
    for (const name of candidates) {
      try {
        await access(path.join(dir, name));
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
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
