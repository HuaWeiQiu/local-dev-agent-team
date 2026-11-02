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

const COMMIT_UNREADABLE = "记录的任务提交当前不可读取";
const STAGED_EMPTY = "工作区暂无已暂存的改动";
const NOTHING_TO_SHOW = "任务尚未产生可查看的改动";

/** A task diff answer that carries no content, only the reason there is none. */
function taskDiffAnswer(
  taskId: string,
  detail: string,
  extra: { source?: "commit" | "worktree"; commit?: string } = {},
): TaskDiffEvidence {
  return {
    taskId,
    available: false,
    ...extra,
    changedFiles: [],
    truncated: false,
    detail,
  };
}

/** The commit a task recorded, when git can still read it. */
async function recordedCommitDiff(
  git: GitManager,
  taskId: string,
  commit: string,
): Promise<TaskDiffEvidence> {
  try {
    const diff = await git.commitDiff(commit);
    return {
      taskId,
      available: true,
      source: "commit",
      commit,
      changedFiles: diff.changedFiles,
      content: diff.content,
      truncated: diff.truncated,
    };
  } catch {
    return taskDiffAnswer(taskId, COMMIT_UNREADABLE, { commit });
  }
}

/** The staged worktree of a task that has not committed yet, if it holds any diff. */
async function stagedWorktreeDiff(
  git: GitManager,
  taskId: string,
  worktree: string,
): Promise<TaskDiffEvidence | undefined> {
  if (!(await directoryExists(worktree))) return undefined;
  try {
    const content = await git.stagedDiff(worktree);
    return worktreeDiffAnswer(taskId, content, await git.changedFiles(worktree));
  } catch {
    return undefined;
  }
}

function worktreeDiffAnswer(
  taskId: string,
  content: string,
  changedFiles: string[],
): TaskDiffEvidence {
  const staged = content.length > 0;
  return {
    taskId,
    available: staged,
    source: "worktree",
    changedFiles,
    ...(staged ? { content } : {}),
    truncated: content.includes("[diff truncated"),
    ...(staged ? {} : { detail: STAGED_EMPTY }),
  };
}

function directoryExists(directory: string): Promise<boolean> {
  return stat(directory).then(
    () => true,
    () => false,
  );
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
    const git = this.gitManager();
    if (task.commit) return recordedCommitDiff(git, taskId, task.commit);
    const staged = task.worktree
      ? await stagedWorktreeDiff(git, taskId, task.worktree)
      : undefined;
    return staged ?? taskDiffAnswer(taskId, NOTHING_TO_SHOW);
  }

  private gitManager(): GitManager {
    const worktrees = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    return new GitManager(this.loaded.root, worktrees);
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
