import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { assertRoleProfilePermission } from "../security/permissions.js";
import { fallbackProfiles, resolveProfile } from "../profiles/resolve.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { invokeAgent } from "../adapters/invoke.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import {
  inquiryAnswerJsonSchema,
  inquiryAnswerSchema,
  type InquiryAnswer,
} from "./domain.js";

export interface InquiryAnswerResult extends InquiryAnswer {
  profileName: string;
  durationMs: number;
}

export class InquiryRunner {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly stateStore: RunStateStore,
  ) {}

  /**
   * Read-only snapshot answer. This method loads state.json but never saves,
   * transitions, or emits run events. The model is invoked with a read-only
   * role (non-worker profiles cannot be workspace-write).
   */
  async answer(options: {
    runId: string;
    stage: string;
    question: string;
    signal?: AbortSignal;
  }): Promise<InquiryAnswerResult> {
    const state = await this.stateStore.load(options.runId);
    const prompt = await this.renderPrompt(state, options.stage, options.question);
    const startedAt = Date.now();

    const candidates = [
      resolveProfile(this.loaded.config, "orchestrator", undefined),
      ...fallbackProfiles(this.loaded.config, "orchestrator"),
    ].filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.name === candidate.name) === index,
    );

    const failures: string[] = [];
    for (const candidate of candidates) {
      assertRoleProfilePermission(
        "orchestrator",
        candidate.name,
        candidate.profile.permission,
      );
      const artifactDirectory = path.join(
        this.loaded.root,
        this.loaded.config.project.stateDirectory,
        "inquiries",
        options.runId,
        `${Date.now()}-inquiry-artifacts`,
      );
      try {
        const result = await invokeAgent(
          {
            adapterName: candidate.profile.adapter,
            profile: candidate.profile,
            cwd: this.loaded.root,
            runId: options.runId,
            prompt,
            artifactDirectory,
            outputSchema: inquiryAnswerJsonSchema,
            maxOutputBytes: 64_000,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          new AdapterRegistry(),
        );
        const raw = result.structured ?? safeJsonParse(result.text);
        const parsed = inquiryAnswerSchema.safeParse(raw);
        if (!parsed.success) {
          failures.push(
            `${candidate.name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          );
          continue;
        }
        return {
          ...parsed.data,
          profileName: candidate.name,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        failures.push(
          `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        options.signal?.throwIfAborted();
      }
    }
    throw new Error(`所有总控 profile 都无法回答：${failures.join(" | ")}`);
  }

  private async renderPrompt(state: RunState, stage: string, question: string): Promise<string> {
    const template = await readFile(
      fileURLToPath(new URL("../../prompts/inquiry.md", import.meta.url)),
      "utf8",
    );
    const snapshot = {
      goal: state.goal,
      goalSummary: state.intake?.goalSummary,
      planSummary: state.plan?.summary,
      currentStatus: state.status,
      tasks: state.tasks.map((task) => ({
        id: task.task.id,
        title: task.task.title,
        status: task.status,
        attempts: task.attempts,
        summary: task.summary,
      })),
      stageSummaries: (state.stageSummaries ?? [])
        .filter((summary) => !stage || summary.stage === stage || summary.stage === state.status)
        .slice(-8),
      recentHistory: state.history.slice(-10).map((entry) => ({
        at: entry.at,
        status: entry.status,
        message: entry.message,
      })),
      finalQuality: state.finalQuality
        ? {
            passed: state.finalQuality.passed,
            commands: state.finalQuality.commands.map((command) => ({
              command: [command.spec.command, ...command.spec.args].join(" "),
              exitCode: command.exitCode,
            })),
          }
        : undefined,
      finalDecision: state.finalDecision,
      error: state.error,
    };
    return template
      .replace("{{STAGE}}", stage || state.status)
      .replace("{{RUN_SNAPSHOT}}", JSON.stringify(snapshot, null, 2))
      .replace("{{QUESTION}}", question);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
