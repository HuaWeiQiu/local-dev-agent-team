import { describe, expect, it, vi } from "vitest";

const { runPs } = vi.hoisted(() => ({ runPs: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = (() => {
    throw new Error("promisified form only");
  }) as unknown as Record<symbol, unknown>;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (file: string, args: string[]) =>
    runPs(file, args);
  return { execFile };
});

const { processIsRunning, processLiveness, processStartToken, signalAlive } = await import(
  "../src/process/alive.js"
);

function ps(stdout: string): void {
  runPs.mockResolvedValue({ stdout, stderr: "" });
}

function psFails(): void {
  runPs.mockRejectedValue(new Error("ps: not found"));
}

function reset(): void {
  runPs.mockReset();
  vi.restoreAllMocks();
}

function asErrno(code: string): Error & { code: string } {
  const error = new Error(`kill ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

describe("processLiveness", () => {
  it.each([0, -1, 1.5, Number.NaN])("calls pid %s dead without asking ps", async (pid) => {
    reset();
    ps("Z");

    await expect(processLiveness(pid)).resolves.toBe("dead");
    expect(runPs).not.toHaveBeenCalled();
  });

  it("treats a Z ps state as a zombie even though the signal would succeed", async () => {
    reset();
    ps("Z+\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(processLiveness(4242)).resolves.toBe("zombie");
    expect(runPs).toHaveBeenCalledWith("ps", ["-o", "stat=", "-p", "4242"]);
  });

  it("asks the signal when ps reports a live state", async () => {
    reset();
    ps("S+\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(processLiveness(4242)).resolves.toBe("alive");
  });

  it("falls back to the signal when ps prints nothing", async () => {
    reset();
    ps("\n");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw asErrno("ESRCH");
    });

    await expect(processLiveness(4242)).resolves.toBe("dead");
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("falls back to the signal when ps cannot be run", async () => {
    reset();
    psFails();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(processLiveness(4242)).resolves.toBe("alive");
  });

  it("reads liveness from the signal alone on Windows", async () => {
    reset();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(processLiveness(4242)).resolves.toBe("alive");
    } finally {
      platform.mockRestore();
    }
    expect(kill).toHaveBeenCalledWith(4242, 0);
    expect(runPs).not.toHaveBeenCalled();
  });

  it("reports a dead Windows process", async () => {
    reset();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw asErrno("ESRCH");
    });
    try {
      await expect(processLiveness(4242)).resolves.toBe("dead");
    } finally {
      platform.mockRestore();
    }
  });
});

describe("signalAlive", () => {
  it("counts a successful probe as alive", () => {
    reset();
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(signalAlive(4242)).toBe(true);
  });

  it("counts EPERM as alive because the process exists but belongs to another user", () => {
    reset();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw asErrno("EPERM");
    });

    expect(signalAlive(1)).toBe(true);
  });

  it("counts ESRCH as dead", () => {
    reset();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw asErrno("ESRCH");
    });

    expect(signalAlive(4242)).toBe(false);
  });
});

describe("processIsRunning", () => {
  it("is true only for a live process, so a zombie reads as not running", async () => {
    reset();
    ps("S");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(processIsRunning(4242)).resolves.toBe(true);

    reset();
    ps("Z");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(processIsRunning(4242)).resolves.toBe(false);
  });
});

describe("processStartToken", () => {
  it("returns the start time ps reports", async () => {
    reset();
    ps("Mon Nov  2 10:00:00 2026\n");

    await expect(processStartToken(4242)).resolves.toBe("Mon Nov  2 10:00:00 2026");
    expect(runPs).toHaveBeenCalledWith("ps", ["-o", "lstart=", "-p", "4242"]);
  });

  it("reports no token when ps prints nothing", async () => {
    reset();
    ps("\n");

    await expect(processStartToken(4242)).resolves.toBeUndefined();
  });

  it("reports no token when ps fails", async () => {
    reset();
    psFails();

    await expect(processStartToken(4242)).resolves.toBeUndefined();
  });
});
