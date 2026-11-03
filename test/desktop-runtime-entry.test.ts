import { describe, expect, it } from "vitest";
import {
  argvToModuleUrl,
  describeTarget,
  distributionFor,
  isMainModule,
  resolvePnpmInvocation,
} from "../scripts/prepare-desktop-runtime.mjs";

describe("module entry guard", () => {
  it("matches a POSIX argv path against the file URL Node reports", () => {
    expect(isMainModule("file:///repo/scripts/prepare.mjs", "/repo/scripts/prepare.mjs")).toBe(true);
  });

  it("matches a Windows drive path, which a `file://${argv}` comparison would miss", () => {
    // `import.meta.url` on Windows is `file:///C:/...` while argv[1] is `C:\...`. Concatenating
    // them yields `file://C:\...`, which is not a URL shape and never compares equal — the
    // entry would then be skipped in silence on the windows-latest packaging runner.
    expect(argvToModuleUrl("C:\\repo\\scripts\\x.mjs")).toBe("file:///C:/repo/scripts/x.mjs");
    expect(isMainModule("file:///C:/repo/scripts/x.mjs", "C:\\repo\\scripts\\x.mjs")).toBe(true);
  });

  it("rejects a different file, an absent argv path, and an empty one", () => {
    expect(isMainModule("file:///C:/repo/scripts/x.mjs", "C:\\repo\\scripts\\y.mjs")).toBe(false);
    expect(isMainModule("file:///repo/scripts/x.mjs", undefined)).toBe(false);
    expect(isMainModule("file:///repo/scripts/x.mjs", "")).toBe(false);
  });

  it("encodes the characters a URL cannot carry verbatim on both sides", () => {
    expect(isMainModule("file:///repo/my%20scripts/x.mjs", "/repo/my scripts/x.mjs")).toBe(true);
  });
});

describe("target distributions", () => {
  it("maps every supported triple onto its Node archive", () => {
    expect(distributionFor("aarch64-apple-darwin")).toMatchObject({
      name: "darwin-arm64",
      extension: "tar.gz",
      binaryPath: ["bin", "node"],
    });
    expect(distributionFor("x86_64-apple-darwin").name).toBe("darwin-x64");
    expect(distributionFor("aarch64-unknown-linux-gnu")).toMatchObject({
      name: "linux-arm64",
      extension: "tar.xz",
      tarArguments: ["-xJf"],
    });
    expect(distributionFor("x86_64-unknown-linux-gnu").name).toBe("linux-x64");
    expect(distributionFor("x86_64-pc-windows-msvc")).toMatchObject({
      platform: "windows",
      name: "win-x64",
      extension: "zip",
      binaryPath: ["node.exe"],
    });
  });

  it("refuses a triple it has no archive for", () => {
    expect(() => distributionFor("riscv64-unknown-linux-gnu")).toThrow(
      "Desktop runtime preparation does not yet support riscv64-unknown-linux-gnu",
    );
  });
});

describe("pnpm invocation", () => {
  it("runs pnpm's own entry point through the current Node when pnpm started the script", () => {
    for (const npmExecPath of ["/opt/pnpm/bin/pnpm.cjs", "/opt/pnpm/bin/pnpm.mjs"]) {
      expect(
        resolvePnpmInvocation({
          npmExecPath,
          platform: "darwin",
          execPath: "/usr/local/bin/node",
        }),
      ).toEqual({ command: "/usr/local/bin/node", args: [npmExecPath] });
    }
  });

  it("falls back to PATH, with the .cmd shim on Windows", () => {
    expect(
      resolvePnpmInvocation({ npmExecPath: undefined, platform: "darwin", execPath: "/n" }),
    ).toEqual({ command: "pnpm", args: [] });
    expect(
      resolvePnpmInvocation({ npmExecPath: undefined, platform: "win32", execPath: "/n" }),
    ).toEqual({ command: "pnpm.cmd", args: [] });
  });

  it("ignores an npm_execpath that is not a script", () => {
    expect(
      resolvePnpmInvocation({ npmExecPath: "/opt/pnpm/bin/pnpm", platform: "linux", execPath: "/n" }),
    ).toEqual({ command: "pnpm", args: [] });
  });
});

describe("--describe-target projection", () => {
  it("reduces the plan to the fields the packaging matrix reads", () => {
    expect(
      describeTarget({
        target: "x86_64-pc-windows-msvc",
        archiveName: "node-v24.19.0-win-x64.zip",
        distribution: { binaryPath: ["node.exe"] },
        destinationName: "agent-team-node-x86_64-pc-windows-msvc.exe",
      }),
    ).toEqual({
      target: "x86_64-pc-windows-msvc",
      archiveName: "node-v24.19.0-win-x64.zip",
      binaryPath: "node.exe",
      destinationName: "agent-team-node-x86_64-pc-windows-msvc.exe",
    });
  });
});
