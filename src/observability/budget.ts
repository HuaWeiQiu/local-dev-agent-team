import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentInvocationObservation,
  AgentInvocationObserver,
} from "../agents/service.js";
import type { AgentUsage } from "../adapters/types.js";
import type { QualityReport } from "../quality/run.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState, RunUsage } from "../state/types.js";
import {
  legacyExecutionTimeoutSeconds,
  legacyMaxAgentInvocations,
  legacyMaxArtifactBytes,
  legacyMaxProcessOutputBytes,
} from "../strategies/defaults.js";
import { classifyError } from "../providers/failure.js";
import { AgentInvocationError } from "../adapters/invoke.js";

export class RunBudgetExceededError extends Error {
  readonly code = "RUN_BUDGET_EXCEEDED";
}

export interface RunBudgetTrackerOptions {
  now?: () => number;
  artifactBytesCacheTtlMs?: number;
}

const defaultArtifactBytesCacheTtlMs = 2_000;

export class RunBudgetTracker implements AgentInvocationObserver {
  readonly maxProcessOutputBytes: number;
  private artifactBytesCache?: { measuredAt: number; bytes: number };

  constructor(
    private readonly state: RunState,
    private readonly store: RunStateStore,
    private readonly options: RunBudgetTrackerOptions = {},
  ) {
    state.strategy.executionTimeoutSeconds ??= legacyExecutionTimeoutSeconds;
    state.strategy.maxAgentInvocations ??= legacyMaxAgentInvocations;
    state.strategy.maxProcessOutputBytes ??= legacyMaxProcessOutputBytes;
    state.strategy.maxArtifactBytes ??= legacyMaxArtifactBytes;
    state.usage ??= emptyUsage();
    this.maxProcessOutputBytes = state.strategy.maxProcessOutputBytes;
  }

  async beforeInvocation(
    observation: Omit<
      AgentInvocationObservation,
      "invocationId" | "durationMs" | "result" | "error"
    >,
  ): Promise<string> {
    await this.refreshArtifactBytes();
    this.assertArtifactBudget();
    const usage = this.state.usage!;
    if (usage.agentInvocations >= this.state.strategy.maxAgentInvocations) {
      throw new RunBudgetExceededError(
        `Agent invocation budget of ${this.state.strategy.maxAgentInvocations} exhausted`,
      );
    }
    usage.agentInvocations += 1;
    const invocationId = randomUUID();
    await this.store.save(this.state);
    this.store.emit(this.state.id, "agent.invocation.started", {
      invocationId,
      role: observation.role,
      profile: observation.profile,
      adapter: observation.adapter,
      model: observation.model,
      permission: observation.permission,
      externalTools: observation.externalTools,
      artifactKey: observation.artifactKey,
      invocation: usage.agentInvocations,
      limit: this.state.strategy.maxAgentInvocations,
    });
    return invocationId;
  }

  async afterInvocation(observation: AgentInvocationObservation): Promise<void> {
    const usage = this.state.usage!;
    const process = observation.result?.process;
    usage.agentDurationMs += process?.durationMs ?? observation.durationMs;
    usage.processOutputBytes +=
      (process?.stdoutBytes ?? Buffer.byteLength(process?.stdout ?? "")) +
      (process?.stderrBytes ?? Buffer.byteLength(process?.stderr ?? ""));
    usage.truncatedStreams += Number(process?.stdoutTruncated === true);
    usage.truncatedStreams += Number(process?.stderrTruncated === true);
    addReportedUsage(usage, observation.result?.usage);
    await this.refreshArtifactBytes();
    await this.store.save(this.state);
    const overArtifactBudget = usage.artifactBytes > this.state.strategy.maxArtifactBytes;
    const failure =
      observation.error === undefined
        ? undefined
        : observation.error instanceof AgentInvocationError
          ? observation.error.classification
          : classifyError(observation.error);
    this.store.emit(this.state.id, "agent.invocation.completed", {
      invocationId: observation.invocationId,
      role: observation.role,
      profile: observation.profile,
      adapter: observation.adapter,
      model: observation.model,
      permission: observation.permission,
      externalTools: observation.externalTools,
      artifactKey: observation.artifactKey,
      durationMs: process?.durationMs ?? observation.durationMs,
      success: !observation.error && !overArtifactBudget,
      ...(process?.stdoutBytes !== undefined ? { stdoutBytes: process.stdoutBytes } : {}),
      ...(process?.stderrBytes !== undefined ? { stderrBytes: process.stderrBytes } : {}),
      ...(process?.stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(process?.stderrTruncated ? { stderrTruncated: true } : {}),
      ...(observation.result?.usage ? { usage: observation.result.usage } : {}),
      ...(observation.error ? { error: errorMessage(observation.error) } : {}),
      ...(failure
        ? {
            failureCode: failure.code,
            failureCategory: failure.category,
            infrastructureFailure: failure.infrastructure,
            pauseEvolution: failure.pauseEvolution,
          }
        : {}),
      ...(overArtifactBudget
        ? { error: `Artifact budget of ${this.state.strategy.maxArtifactBytes} bytes exceeded` }
        : {}),
    });
    this.assertArtifactBudget();
  }

  async recordQuality(report: QualityReport): Promise<void> {
    const usage = this.state.usage!;
    for (const command of report.commands) {
      usage.processOutputBytes +=
        (command.stdoutBytes ?? Buffer.byteLength(command.stdout)) +
        (command.stderrBytes ?? Buffer.byteLength(command.stderr));
      usage.truncatedStreams += Number(command.stdoutTruncated === true);
      usage.truncatedStreams += Number(command.stderrTruncated === true);
    }
    await this.refreshArtifactBytes();
    await this.store.save(this.state);
    this.assertArtifactBudget();
  }

  private async refreshArtifactBytes(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = this.options.artifactBytesCacheTtlMs ?? defaultArtifactBytesCacheTtlMs;
    const cached = this.artifactBytesCache;
    if (cached && now - cached.measuredAt < ttlMs) {
      this.state.usage!.artifactBytes = cached.bytes;
      return;
    }
    const bytes = await directorySize(this.store.artifactDirectory(this.state.id));
    this.artifactBytesCache = { measuredAt: now, bytes };
    this.state.usage!.artifactBytes = bytes;
  }

  private assertArtifactBudget(): void {
    const bytes = this.state.usage!.artifactBytes;
    if (bytes > this.state.strategy.maxArtifactBytes) {
      throw new RunBudgetExceededError(
        `Artifact budget of ${this.state.strategy.maxArtifactBytes} bytes exceeded (${bytes} bytes)`,
      );
    }
  }
}

export interface ExecutionDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export function createExecutionDeadline(
  timeoutSeconds: number,
  parent?: AbortSignal,
): ExecutionDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new RunBudgetExceededError(
        `Execution timeout of ${timeoutSeconds} seconds exceeded`,
      ),
    );
  }, timeoutSeconds * 1_000);
  timer.unref();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function emptyUsage(): RunUsage {
  return {
    agentInvocations: 0,
    agentDurationMs: 0,
    processOutputBytes: 0,
    truncatedStreams: 0,
    artifactBytes: 0,
  };
}

function addReportedUsage(
  target: RunUsage,
  reported: AgentUsage | undefined,
): void {
  if (!reported) return;
  addNumber(target, "inputTokens", reported.inputTokens);
  addNumber(target, "cachedInputTokens", reported.cachedInputTokens);
  addNumber(target, "outputTokens", reported.outputTokens);
  addNumber(target, "reportedCostUsd", reported.reportedCostUsd);
}

function addNumber(
  target: RunUsage,
  key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reportedCostUsd",
  value: number | undefined,
): void {
  if (value !== undefined) target[key] = (target[key] ?? 0) + value;
}

async function directorySize(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let bytes = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directorySize(entryPath);
    } else if (entry.isFile()) {
      bytes += (await stat(entryPath)).size;
    }
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)} [truncated]`;
}
