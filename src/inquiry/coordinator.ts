import { randomUUID } from "node:crypto";
import type { LoadedConfig } from "../config/load.js";
import type { RunStateStore } from "../state/store.js";
import {
  inquiryTimeoutMs,
  maxInquiriesPerRun,
  type InquiryRecord,
} from "./domain.js";
import { InquiryStore } from "./store.js";
import { InquiryRunner, type InquiryAnswerResult } from "./runner.js";

export interface InquiryRunnerLike {
  answer(options: {
    runId: string;
    stage: string;
    question: string;
    signal?: AbortSignal;
  }): Promise<InquiryAnswerResult>;
}

export class InquiryCoordinator {
  private readonly store: InquiryStore;
  private readonly runner: InquiryRunnerLike;
  private readonly active = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;

  constructor(
    loaded: LoadedConfig,
    private readonly stateStore: RunStateStore,
    runner: InquiryRunnerLike = new InquiryRunner(loaded, stateStore),
  ) {
    this.store = new InquiryStore(loaded.root, loaded.config.project.stateDirectory);
    this.runner = runner;
  }

  async ask(runId: string, question: string, stage?: string): Promise<InquiryRecord> {
    if (this.closed) {
      throw new Error("Control service is closing; inquiries are disabled");
    }
    await this.stateStore.load(runId);
    const existing = await this.store.list(runId);
    if (existing.filter((record) => record.status === "running").length > 0) {
      throw new Error(`Run '${runId}' already has an in-flight inquiry`);
    }
    if (existing.length >= maxInquiriesPerRun) {
      throw new Error(
        `Run '${runId}' reached the inquiry limit of ${maxInquiriesPerRun}; delete older inquiries first`,
      );
    }
    const state = await this.stateStore.load(runId);
    const record: InquiryRecord = {
      id: randomUUID(),
      version: 1,
      runId,
      stage: stage ?? state.status,
      runStatusAtAsk: state.status,
      question,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(record);

    const controller = new AbortController();
    this.active.set(record.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Inquiry timed out"));
    }, inquiryTimeoutMs);
    timer.unref();

    const task = this.runInquiry(record, controller.signal, () => timedOut, () => {
      clearTimeout(timer);
      this.active.delete(record.id);
    });
    this.tasks.add(task);
    void task.finally(() => {
      this.tasks.delete(task);
    });
    return { ...record };
  }

  async list(runId: string): Promise<InquiryRecord[]> {
    await this.stateStore.load(runId);
    return await this.store.list(runId);
  }

  async get(runId: string, inquiryId: string): Promise<InquiryRecord> {
    await this.stateStore.load(runId);
    return await this.store.load(runId, inquiryId);
  }

  async delete(runId: string, inquiryId: string): Promise<void> {
    this.active.get(inquiryId)?.abort(new Error("Inquiry deleted"));
    await this.store.delete(runId, inquiryId);
  }

  async deleteForRun(runId: string): Promise<void> {
    await this.store.deleteForRun(runId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.values()) {
      controller.abort(new Error("Control service is shutting down"));
    }
    await Promise.allSettled([...this.tasks]);
  }

  private async runInquiry(
    record: InquiryRecord,
    signal: AbortSignal,
    timedOut: () => boolean,
    finish: () => void,
  ): Promise<void> {
    try {
      const answer = await this.runner.answer({
        runId: record.runId,
        stage: record.stage,
        question: record.question,
        signal,
      });
      record.answer = answer.answer;
      record.keyPoints = answer.keyPoints;
      record.status = "completed";
      record.usage = { durationMs: answer.durationMs, profileName: answer.profileName };
    } catch (error) {
      if (timedOut()) {
        record.status = "failed";
        record.error = `咨询超时（${Math.round(inquiryTimeoutMs / 1_000)}s）`;
      } else if (this.closed) {
        record.status = "cancelled";
        record.error = "控制服务关闭，咨询已取消";
      } else {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      await this.store.save(record).catch(() => undefined);
      finish();
    }
  }
}
