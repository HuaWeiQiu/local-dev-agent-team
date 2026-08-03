import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentProfile } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import type { AgentRunResult } from "./types.js";
import { AdapterRegistry } from "./registry.js";

export interface InvokeOptions {
  adapterName: string;
  profile: AgentProfile;
  cwd: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  artifactDirectory?: string;
}

export async function invokeAgent(
  options: InvokeOptions,
  registry = new AdapterRegistry(),
): Promise<AgentRunResult> {
  const adapter = registry.get(options.adapterName);
  let outputFile: string | undefined;
  if (options.artifactDirectory) {
    await mkdir(options.artifactDirectory, { recursive: true });
    outputFile = path.join(options.artifactDirectory, "last-message.json");
    if (options.outputSchema && options.adapterName === "codex") {
      await writeFile(
        `${outputFile}.schema.json`,
        `${JSON.stringify(options.outputSchema, null, 2)}\n`,
      );
    }
  }
  const invocation = adapter.buildInvocation(options.profile, {
    cwd: options.cwd,
    prompt: options.prompt,
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(outputFile ? { outputFile } : {}),
  });
  const process = await runProcess(invocation);
  const result = await adapter.parseResult(invocation, process);
  if (process.exitCode !== 0) {
    throw new Error(
      `${options.adapterName} exited with ${process.exitCode}: ${process.stderr.trim() || result.text}`,
    );
  }
  return result;
}
