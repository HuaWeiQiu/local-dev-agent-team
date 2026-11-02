import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import type { RepoTrace } from "../src/domain/repo-tree.js";
import { ExperienceService } from "../src/experience/service.js";
import type { RunStateStore } from "../src/state/store.js";
import type { RunState, TaskRunState } from "../src/state/types.js";
import { RunExperienceRecorder } from "../src/workflow/experience-recorder.js";

vi.mock("../src/experience/service.js", () => ({
  ExperienceService: { forLoaded: vi.fn() },
}));

const forLoaded = vi.mocked(ExperienceService.forLoaded);

function store(): { emit: ReturnType<typeof vi.fn>; events: Array<[string, unknown, unknown]> } {
  const events: Array<[string, unknown, unknown]> = [];
  const emit = vi.fn((runId: string, type: string, payload: unknown) => {
    events.push([runId, type, payload]);
  });
  return { emit, events } as unknown as {
    emit: ReturnType<typeof vi.fn>;
    events: Array<[string, unknown, unknown]>;
  };
}

function asStore(value: { emit: ReturnType<typeof vi.fn> }): RunStateStore {
  return value as unknown as RunStateStore;
}

function run(patch: Partial<RunState> = {}): RunState {
  return { id: "r1", ...patch } as RunState;
}

function taskState(id = "t1"): TaskRunState {
  return {
    task: { id, title: `Task ${id}` },
  } as TaskRunState;
}

function service(overrides: Record<string, unknown>): ExperienceService {
  forLoaded.mockReturnValue(overrides as unknown as ExperienceService);
  return overrides as unknown as ExperienceService;
}

function recorder(): RunExperienceRecorder {
  return new RunExperienceRecorder({} as LoadedConfig);
}

beforeEach(() => {
  forLoaded.mockReset();
});

describe("RunExperienceRecorder.loadPlanning", () => {
  it("counts the bundle by scope and announces it before planning", async () => {
    const retrieveForPlanning = vi.fn().mockResolvedValue({
      items: [
        { scope: "shared", id: "s1" },
        { scope: "project", id: "p1" },
        { scope: "project", id: "p2" },
      ],
    });
    service({ retrieveForPlanning });
    const sink = store();

    const bundle = await recorder().loadPlanning("goal", asStore(sink), "r1");

    expect(bundle.items).toHaveLength(3);
    expect(sink.events).toEqual([
      [
        "r1",
        "experience.retrieved",
        { purpose: "planning", count: 3, scopes: { shared: 1, project: 2 } },
      ],
    ]);
  });

  it("passes the repo trace through when the caller has one", async () => {
    const retrieveForPlanning = vi.fn().mockResolvedValue(undefined);
    service({ retrieveForPlanning });
    const trace = { files: [] } as unknown as RepoTrace;

    await recorder().loadPlanning("goal", asStore(store()), "r1", trace);
    await recorder().loadPlanning("goal", asStore(store()), "r1");

    expect(retrieveForPlanning).toHaveBeenNthCalledWith(1, "goal", { trace });
    expect(retrieveForPlanning).toHaveBeenNthCalledWith(2, "goal", {});
  });

  it("says nothing when the library has nothing for this goal", async () => {
    service({ retrieveForPlanning: vi.fn().mockResolvedValue(undefined) });
    const sink = store();

    await expect(recorder().loadPlanning("goal", asStore(sink), "r1")).resolves.toBeUndefined();
    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("turns a failure into an event instead of failing the run", async () => {
    service({ retrieveForPlanning: vi.fn().mockRejectedValue(new Error("library offline")) });
    const sink = store();

    await expect(recorder().loadPlanning("goal", asStore(sink), "r1")).resolves.toBeUndefined();
    expect(sink.events).toEqual([
      ["r1", "experience.retrieve-failed", { purpose: "planning", message: "library offline" }],
    ]);
  });

  it("reports a thrown value that is not an Error", async () => {
    service({ retrieveForPlanning: vi.fn().mockRejectedValue("boom") });
    const sink = store();

    await recorder().loadPlanning("goal", asStore(sink), "r1");

    expect(sink.events[0][2]).toEqual({ purpose: "planning", message: "boom" });
  });
});

describe("RunExperienceRecorder.loadRework", () => {
  it("asks for five rework cards and announces the bundle", async () => {
    const retrieveForRework = vi.fn().mockResolvedValue({ items: [{ id: "e1" }] });
    service({ retrieveForRework });
    const sink = store();

    await recorder().loadRework(
      run(),
      asStore(sink),
      { feedback: "tests failed", taskId: "t1", taskTitle: "Task t1" },
    );

    expect(retrieveForRework).toHaveBeenCalledWith({
      feedback: "tests failed",
      taskId: "t1",
      taskTitle: "Task t1",
      limit: 5,
    });
    expect(sink.events).toEqual([
      ["r1", "experience.retrieved", { purpose: "rework", taskId: "t1", count: 1 }],
    ]);
  });

  it("attaches the run repo trace when the run recorded one", async () => {
    const retrieveForRework = vi.fn().mockResolvedValue(undefined);
    service({ retrieveForRework });
    const trace = { files: [] } as unknown as RepoTrace;

    await recorder().loadRework(run({ repoTrace: trace }), asStore(store()), {
      feedback: "f",
      taskId: "t1",
      taskTitle: "T",
    });

    expect(retrieveForRework).toHaveBeenCalledWith(expect.objectContaining({ trace }));
  });

  it("swallows a rework retrieval failure into an event", async () => {
    service({ retrieveForRework: vi.fn().mockRejectedValue(new Error("no index")) });
    const sink = store();

    const result = await recorder().loadRework(run(), asStore(sink), {
      feedback: "f",
      taskId: "t1",
      taskTitle: "T",
    });

    expect(result).toBeUndefined();
    expect(sink.events).toEqual([
      [
        "r1",
        "experience.retrieve-failed",
        { purpose: "rework", taskId: "t1", message: "no index" },
      ],
    ]);
  });
});

describe("RunExperienceRecorder.extractFromRun", () => {
  it("announces the cards it created and promoted", async () => {
    service({
      extractFromRun: vi.fn().mockResolvedValue({
        created: [{ id: "c1" }, { id: "c2" }],
        autoPromoted: [{ id: "c2" }],
      }),
    });
    const sink = store();

    await recorder().extractFromRun(run(), asStore(sink));

    expect(sink.events).toEqual([
      ["r1", "experience.extracted", { count: 2, ids: ["c1", "c2"], autoPromoted: ["c2"] }],
    ]);
  });

  it("stays quiet when the run taught the library nothing", async () => {
    service({ extractFromRun: vi.fn().mockResolvedValue({ created: [], autoPromoted: [] }) });
    const sink = store();

    await recorder().extractFromRun(run(), asStore(sink));

    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("reports an extraction failure without touching the run", async () => {
    service({ extractFromRun: vi.fn().mockRejectedValue(new Error("disk full")) });
    const sink = store();

    await expect(recorder().extractFromRun(run(), asStore(sink))).resolves.toBeUndefined();
    expect(sink.events).toEqual([["r1", "experience.extract-failed", { message: "disk full" }]]);
  });
});

describe("RunExperienceRecorder.recordAttempt", () => {
  it("announces the card the attempt produced", async () => {
    service({
      recordAttempt: vi
        .fn()
        .mockResolvedValue({ taskId: "t1", attempt: 2, signature: "sig-2" }),
    });
    const sink = store();

    await recorder().recordAttempt(run(), asStore(sink), taskState("t1"), 2, "still failing");

    expect(sink.events).toEqual([
      ["r1", "experience.attempt-recorded", { taskId: "t1", attempt: 2, signature: "sig-2" }],
    ]);
  });

  it("sends the attempt with the task identity the card needs", async () => {
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    service({ recordAttempt });

    await recorder().recordAttempt(run(), asStore(store()), taskState("t7"), 1, "f");

    expect(recordAttempt).toHaveBeenCalledWith({
      runId: "r1",
      taskId: "t7",
      taskTitle: "Task t7",
      attempt: 1,
      feedback: "f",
    });
  });

  it("is silent when attempt cards are disabled", async () => {
    service({ recordAttempt: vi.fn().mockResolvedValue(undefined) });
    const sink = store();

    await recorder().recordAttempt(run(), asStore(sink), taskState(), 1, "f");

    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("reports a failed card alongside the attempt", async () => {
    service({ recordAttempt: vi.fn().mockRejectedValue(new Error("read-only store")) });
    const sink = store();

    await recorder().recordAttempt(run(), asStore(sink), taskState(), 1, "f");

    expect(sink.events).toEqual([
      ["r1", "experience.attempt-failed", { message: "read-only store" }],
    ]);
  });
});

describe("RunExperienceRecorder.recordSuccess", () => {
  it("announces how many experiences the success touched", async () => {
    service({ recordSuccess: vi.fn().mockResolvedValue(2) });
    const sink = store();

    await recorder().recordSuccess(run(), asStore(sink), ["e1", "e2"]);

    expect(sink.events).toEqual([
      ["r1", "experience.success-recorded", { count: 2, ids: ["e1", "e2"] }],
    ]);
  });

  it("stays quiet when no experience matched", async () => {
    service({ recordSuccess: vi.fn().mockResolvedValue(0) });
    const sink = store();

    await recorder().recordSuccess(run(), asStore(sink), ["e1"]);

    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("reports a success-recording failure without failing the run", async () => {
    service({ recordSuccess: vi.fn().mockRejectedValue(new Error("locked")) });
    const sink = store();

    await recorder().recordSuccess(run(), asStore(sink), ["e1"]);

    expect(sink.events).toEqual([["r1", "experience.success-failed", { message: "locked" }]]);
  });
});
