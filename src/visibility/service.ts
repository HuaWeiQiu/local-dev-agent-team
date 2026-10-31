import { stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { LocalEvidenceStore } from "../evidence/local.js";
import type { TaskDiffEvidence } from "../evidence/types.js";
import type { SqliteEventStore } from "../events/store.js";
import type { RunEvent } from "../events/types.js";
import { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { explainRun, type RunExplanation } from "./explain.js";
import { buildReplay, type ReplayStep } from "./replay.js";
import {
  listTranscripts,
  readTranscript,
  type Transcript,
  type TranscriptSummary,
} from "./transcript.js";
import { foldRunUsage, type RunUsageBreakdown } from "./usage.js";

export class RunNotFound extends Error {
  override readonly name = "RunNotFound";
}

/**
 * Read-only views over one run: why it is in its state, what it cost, what
 * each agent said, what each task changed and how the run unfolded. Every view
 * is derived from persisted state, the ledger and artifacts.
 */
export class RunInsights {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly states: RunStateStore,
    private readonly evidence: LocalEvidenceStore,
    private readonly events: SqliteEventStore,
    private readonly get: (runId: string) => Promise<RunState | undefined>,
  ) {}

  async explain(runId: string): Promise<RunExplanation> {
    const state = await this.require(runId);
    return explainRun(state, this.runEvents(runId));
  }

  async usage(runId: string): Promise<RunUsageBreakdown> {
    await this.require(runId);
    return foldRunUsage(this.runEvents(runId));
  }

  async replay(runId: string): Promise<ReplayStep[]> {
    const state = await this.require(runId);
    return buildReplay(state, this.runEvents(runId));
  }

  async transcripts(runId: string): Promise<TranscriptSummary[]> {
    await this.require(runId);
    return listTranscripts(await this.evidence.listArtifacts(runId), this.runEvents(runId));
  }

  async transcript(runId: string, id: string): Promise<Transcript | undefined> {
    await this.require(runId);
    return await readTranscript(this.states, runId, id, this.runEvents(runId));
  }

  async taskDiff(runId: string, taskId: string): Promise<TaskDiffEvidence> {
    const state = await this.require(runId);
    const task = state.tasks.find((item) => item.task.id === taskId);
    if (!task) throw new RunNotFound(`Task '${taskId}' was not found`);
    const git = new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
    if (task.commit) {
      try {
        const diff = await git.commitDiff(task.commit);
        return {
          taskId,
          available: true,
          source: "commit",
          commit: task.commit,
          changedFiles: diff.changedFiles,
          content: diff.content,
          truncated: diff.truncated,
        };
      } catch {
        return {
          taskId,
          available: false,
          commit: task.commit,
          changedFiles: [],
          truncated: false,
          detail: "记录的任务提交当前不可读取",
        };
      }
    }
    if (task.worktree && (await stat(task.worktree).then(() => true, () => false))) {
      try {
        const content = await git.stagedDiff(task.worktree);
        return {
          taskId,
          available: content.length > 0,
          source: "worktree",
          changedFiles: await git.changedFiles(task.worktree),
          ...(content ? { content } : {}),
          truncated: content.includes("[diff truncated"),
          ...(content ? {} : { detail: "工作区暂无已暂存的改动" }),
        };
      } catch {
        // fall through to the unavailable answer
      }
    }
    return {
      taskId,
      available: false,
      changedFiles: [],
      truncated: false,
      detail: "任务尚未产生可查看的改动",
    };
  }

  private async require(runId: string): Promise<RunState> {
    const state = await this.get(runId);
    if (!state) throw new RunNotFound(`Run '${runId}' was not found`);
    return state;
  }

  private runEvents(runId: string): RunEvent[] {
    const collected: RunEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = this.events.listAfter(cursor, runId, 10_000);
      collected.push(...page);
      if (page.length < 10_000) return collected;
      cursor = page.at(-1)!.sequence;
    }
  }
}
