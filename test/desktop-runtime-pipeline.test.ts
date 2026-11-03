import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PNPM_INSTALL_ARGS,
  main,
  prepareApplicationRuntime,
} from "../scripts/prepare-desktop-runtime.mjs";
import {
  DARWIN_ARM_HOST,
  cleanupRoots,
  makeRepositoryTree,
  makeRoot,
  recordingStdout,
  rustcHost,
  stageExtractedRuntime,
  stagingEntries,
} from "./support/desktop-runtime-fixtures.js";

afterEach(cleanupRoots);

describe("application runtime assembly", () => {
  const runtimeOf = async (repositoryRoot: string): Promise<string> => {
    const runtimeDirectory = path.join(repositoryRoot, "src-tauri", "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    return runtimeDirectory;
  };

  it("publishes the staging copy with the install arguments the shipped tree depends on", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);
    const invocations: string[][] = [];
    await prepareApplicationRuntime(runtimeDirectory, {
      repositoryRoot,
      run: (args: string[]) => {
        invocations.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(invocations).toHaveLength(1);
    const args = invocations[0]!;
    expect(args.slice(0, 2)).toEqual(["--dir", expect.stringContaining(".app-staging-")]);
    expect(args.slice(2)).toEqual(PNPM_INSTALL_ARGS);

    const app = path.join(runtimeDirectory, "app");
    expect(existsSync(path.join(app, "package.json"))).toBe(true);
    expect(existsSync(path.join(app, "dist", "cli.js"))).toBe(true);
    expect(existsSync(path.join(app, "web", "dist", "index.html"))).toBe(true);
    expect(existsSync(path.join(app, "prompts", "plan.md"))).toBe(true);
    expect(existsSync(path.join(app, "schemas", "plan.json"))).toBe(true);
    // Install-time leftovers are what the portability check and the bundle size care about.
    expect(existsSync(path.join(app, "pnpm-lock.yaml"))).toBe(false);
    expect(await stagingEntries(runtimeDirectory)).toEqual([]);
  });

  it("keeps the previous app and drops the staging copy when the install fails", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);
    await mkdir(path.join(runtimeDirectory, "app"), { recursive: true });
    await writeFile(path.join(runtimeDirectory, "app", "stale.txt"), "previous build");

    await expect(
      prepareApplicationRuntime(runtimeDirectory, {
        repositoryRoot,
        run: () => ({ status: 1, stdout: "resolving", stderr: "ERR_PNPM_NO_MATCHING_VERSION" }),
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/ERR_PNPM_NO_MATCHING_VERSION/);

    expect(existsSync(path.join(runtimeDirectory, "app", "stale.txt"))).toBe(true);
    expect(await stagingEntries(runtimeDirectory)).toEqual([]);
  });

  it("quotes pnpm's stdout when it explained itself there instead of on stderr", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);

    await expect(
      prepareApplicationRuntime(runtimeDirectory, {
        repositoryRoot,
        run: () => ({ status: 1, stdout: "ERR_PNPM_OUTDATED_LOCKFILE", stderr: "" }),
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/ERR_PNPM_OUTDATED_LOCKFILE/);
  });

  it("names the step it failed at when the child process said nothing at all", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);

    await expect(
      prepareApplicationRuntime(runtimeDirectory, {
        repositoryRoot,
        run: () => ({ status: 1, stdout: "", stderr: "" }),
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("Unable to install desktop production dependencies: pnpm failed");
  });

  it("keeps the previous app and drops the staging copy when the smoke test fails", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);
    await mkdir(path.join(runtimeDirectory, "app"), { recursive: true });
    await writeFile(path.join(runtimeDirectory, "app", "stale.txt"), "previous build");

    await expect(
      prepareApplicationRuntime(runtimeDirectory, {
        repositoryRoot,
        run: () => ({ status: 0, stdout: "", stderr: "" }),
        spawn: () => ({ status: 1, stdout: "", stderr: "SyntaxError in dist/cli.js" }),
      }),
    ).rejects.toThrow(/SyntaxError in dist\/cli\.js/);

    expect(existsSync(path.join(runtimeDirectory, "app", "stale.txt"))).toBe(true);
    expect(await stagingEntries(runtimeDirectory)).toEqual([]);
  });

  it("clears a leftover staging directory before it starts and replaces the old app", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);
    await mkdir(path.join(runtimeDirectory, ".app-staging-interrupted"), { recursive: true });
    await writeFile(path.join(runtimeDirectory, ".app-staging-interrupted", "partial"), "x");
    await mkdir(path.join(runtimeDirectory, "app"), { recursive: true });
    await writeFile(path.join(runtimeDirectory, "app", "stale.txt"), "previous build");

    await prepareApplicationRuntime(runtimeDirectory, {
      repositoryRoot,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(existsSync(path.join(runtimeDirectory, "app", "stale.txt"))).toBe(false);
    expect(existsSync(path.join(runtimeDirectory, "app", "package.json"))).toBe(true);
    expect(await stagingEntries(runtimeDirectory)).toEqual([]);
  });

  it("refuses to publish a tree pnpm left a symbolic link in", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const runtimeDirectory = await runtimeOf(repositoryRoot);

    await expect(
      prepareApplicationRuntime(runtimeDirectory, {
        repositoryRoot,
        run: (args: string[]) => {
          mkdirSync(path.join(args[1]!, "node_modules"), { recursive: true });
          symlinkSync("/usr/lib/libz.dylib", path.join(args[1]!, "node_modules", "linked"));
          return { status: 0, stdout: "", stderr: "" };
        },
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/non-portable symbolic link/);

    expect(await stagingEntries(runtimeDirectory)).toEqual([]);
  });
});

describe("main", () => {
  const rustcOnly = (host: string) => (command: string) => {
    if (command === "rustc") return rustcHost(host);
    throw new Error(`unexpected child process: ${command}`);
  };

  /** Drive the whole pipeline against a warm cache: no download, no real pnpm, no real tar. */
  const runPreparation = (root: string, host = DARWIN_ARM_HOST) =>
    main({
      argv: ["node", "prepare-desktop-runtime.mjs"],
      env: {},
      root,
      io: {
        spawn: (command: string) => {
          if (command === "rustc") return rustcHost(host);
          if (command === "tar") throw new Error("the runtime is already extracted");
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch: async () => {
          throw new Error("the runtime is already extracted");
        },
        stdout: recordingStdout().stream,
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    });

  it("answers --describe-target before the host check, so any host can ask about any target", async () => {
    const root = await makeRoot();
    const { written, stream } = recordingStdout();

    // The host is aarch64-apple-darwin and the target is Windows: were the host check to run
    // first, this call would throw. Being able to ask from the wrong host is the entire point
    // of the flag — the packaging matrix uses it to learn which archive another runner gets.
    await main({
      argv: ["node", "prepare-desktop-runtime.mjs", "--describe-target"],
      env: { AGENT_TEAM_TAURI_TARGET: "x86_64-pc-windows-msvc" },
      root,
      io: { spawn: rustcOnly("aarch64-apple-darwin"), fetch: undefined as never, stdout: stream },
    });

    expect(JSON.parse(written.join(""))).toEqual({
      target: "x86_64-pc-windows-msvc",
      archiveName: "node-v24.19.0-win-x64.zip",
      binaryPath: "node.exe",
      destinationName: "agent-team-node-x86_64-pc-windows-msvc.exe",
    });
    expect(existsSync(path.join(root, ".cache"))).toBe(false);
  });

  it("refuses a foreign target when it is actually asked to package", async () => {
    const root = await makeRoot();
    const { stream } = recordingStdout();

    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: { AGENT_TEAM_TAURI_TARGET: "x86_64-pc-windows-msvc" },
        root,
        io: { spawn: rustcOnly("aarch64-apple-darwin"), fetch: undefined as never, stdout: stream },
      }),
    ).rejects.toThrow(/needs a matching native host; current host is aarch64-apple-darwin/);
  });

  it("prepares the runtime and only then replaces the app directory", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await stageExtractedRuntime(repositoryRoot);
    const { written, stream } = recordingStdout();

    const order: string[] = [];
    await main({
      argv: ["node", "prepare-desktop-runtime.mjs"],
      env: {},
      root: repositoryRoot,
      io: {
        spawn: (command: string, args: string[]) => {
          if (command === "rustc") return rustcHost(DARWIN_ARM_HOST);
          if (command === "tar") throw new Error("tar must not run: the runtime is already extracted");
          order.push("smoke");
          expect(args).toEqual([expect.stringContaining(path.join("dist", "cli.js")), "--version"]);
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch: async () => {
          throw new Error("the download path must not run: the runtime is already extracted");
        },
        stdout: stream,
        run: (args: string[]) => {
          order.push("install");
          // Order that matters: the sidecar binary and the licence are staged before the
          // install runs, and the install runs before the app directory is published.
          expect(
            existsSync(
              path.join(repositoryRoot, "src-tauri", "binaries", `agent-team-node-${DARWIN_ARM_HOST}`),
            ),
          ).toBe(true);
          expect(existsSync(path.join(repositoryRoot, "src-tauri", "runtime", "NODE-LICENSE"))).toBe(
            true,
          );
          expect(existsSync(path.join(repositoryRoot, "src-tauri", "runtime", "app"))).toBe(false);
          expect(args.slice(2)).toEqual(PNPM_INSTALL_ARGS);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });

    expect(order).toEqual(["install", "smoke"]);
    expect(written.join("")).toBe(
      `Prepared Node v24.19.0 desktop runtime and production dependencies for ${DARWIN_ARM_HOST}\n`,
    );
    const binary = path.join(repositoryRoot, "src-tauri", "binaries", `agent-team-node-${DARWIN_ARM_HOST}`);
    expect(existsSync(binary)).toBe(true);
    expect((await stat(binary)).mode & 0o111).not.toBe(0);
    expect(existsSync(path.join(repositoryRoot, "src-tauri", "runtime", "app", "dist", "cli.js"))).toBe(
      true,
    );
  });

  it("downloads, verifies and extracts the archive when the cache is cold", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const { written, stream } = recordingStdout();
    const archiveBytes = Buffer.from("node-archive-fixture");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");

    await main({
      argv: ["node", "prepare-desktop-runtime.mjs"],
      env: {},
      root: repositoryRoot,
      io: {
        spawn: (command: string, args: string[]) => {
          if (command === "rustc") return rustcHost(DARWIN_ARM_HOST);
          if (command !== "tar") return { status: 0, stdout: "", stderr: "" };
          // Stand in for the archive: the assertions that follow check what the script does
          // with an extracted tree, and a real 50 MB download is not part of that.
          const cacheRoot = args[args.indexOf("-C") + 1]!;
          const extracted = path.join(cacheRoot, "node-v24.19.0-darwin-arm64");
          mkdirSync(path.join(extracted, "bin"), { recursive: true });
          writeFileSync(path.join(extracted, "bin", "node"), "node-binary");
          writeFileSync(path.join(extracted, "LICENSE"), "node-license");
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch: async (url: string) =>
          url.endsWith("SHASUMS256.txt")
            ? {
                ok: true,
                status: 200,
                text: async () => `${digest}  node-v24.19.0-darwin-arm64.tar.gz\n`,
                arrayBuffer: async () => new ArrayBuffer(0),
              }
            : {
                ok: true,
                status: 200,
                text: async () => "",
                arrayBuffer: async () =>
                  archiveBytes.buffer.slice(
                    archiveBytes.byteOffset,
                    archiveBytes.byteOffset + archiveBytes.byteLength,
                  ) as ArrayBuffer,
              },
        stdout: stream,
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    });

    const cacheRoot = path.join(repositoryRoot, ".cache", "desktop-runtime", "node-v24.19.0");
    expect(existsSync(path.join(cacheRoot, "node-v24.19.0-darwin-arm64.tar.gz"))).toBe(true);
    expect(existsSync(path.join(cacheRoot, "node-v24.19.0-darwin-arm64.tar.gz.partial"))).toBe(false);
    expect(written.join("")).toContain("Prepared Node v24.19.0");
  });

  it("stops when the checksum list does not mention the archive", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: {},
        root: repositoryRoot,
        io: {
          spawn: rustcOnly(DARWIN_ARM_HOST),
          fetch: async () => ({
            ok: true,
            status: 200,
            text: async () => "deadbeef  node-v24.19.0-linux-x64.tar.xz\n",
            arrayBuffer: async () => new ArrayBuffer(0),
          }),
          stdout: recordingStdout().stream,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        },
      }),
    ).rejects.toThrow("Node checksum is unavailable for node-v24.19.0-darwin-arm64.tar.gz");
  });

  it("stops when the downloaded archive does not match its digest", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: {},
        root: repositoryRoot,
        io: {
          spawn: rustcOnly(DARWIN_ARM_HOST),
          fetch: async (url: string) => ({
            ok: true,
            status: 200,
            text: async () => `${"0".repeat(64)}  node-v24.19.0-darwin-arm64.tar.gz\n`,
            arrayBuffer: async () =>
              url.endsWith("SHASUMS256.txt")
                ? new ArrayBuffer(0)
                : new TextEncoder().encode("tampered").buffer,
          }),
          stdout: recordingStdout().stream,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        },
      }),
    ).rejects.toThrow("Node archive checksum verification failed for node-v24.19.0-darwin-arm64.tar.gz");
  });

  it("stops when the archive cannot be extracted", async () => {
    const repositoryRoot = await makeRepositoryTree();
    const archiveBytes = Buffer.from("node-archive-fixture");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");

    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: {},
        root: repositoryRoot,
        io: {
          spawn: (command: string) => {
            if (command === "rustc") return rustcHost(DARWIN_ARM_HOST);
            return { status: 2, stdout: "", stderr: "tar: not a valid archive" };
          },
          fetch: async (url: string) => ({
            ok: true,
            status: 200,
            text: async () => `${digest}  node-v24.19.0-darwin-arm64.tar.gz\n`,
            arrayBuffer: async () =>
              url.endsWith("SHASUMS256.txt")
                ? new ArrayBuffer(0)
                : (archiveBytes.buffer.slice(
                    archiveBytes.byteOffset,
                    archiveBytes.byteOffset + archiveBytes.byteLength,
                  ) as ArrayBuffer),
          }),
          stdout: recordingStdout().stream,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        },
      }),
    ).rejects.toThrow(/Unable to extract Node runtime: tar: not a valid archive/);
  });

  it("treats an unreadable rustc as a failed measurement, not as a missing host", async () => {
    const root = await makeRoot();
    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: {},
        root,
        io: {
          spawn: () => ({ status: 1, stdout: "", stderr: "rustc: command not found" }),
          fetch: undefined as never,
          stdout: recordingStdout().stream,
        },
      }),
    ).rejects.toThrow("Unable to inspect the Rust target: rustc: command not found");
  });

  it("rejects rustc output that has no host line", async () => {
    const root = await makeRoot();
    await expect(
      main({
        argv: ["node", "prepare-desktop-runtime.mjs"],
        env: {},
        root,
        io: {
          spawn: () => ({ status: 0, stdout: "rustc 1.90.0\n", stderr: "" }),
          fetch: undefined as never,
          stdout: recordingStdout().stream,
        },
      }),
    ).rejects.toThrow("Unable to determine the Rust host target");
  });

  it("keeps a staged binary of the same size and repairs its missing executable bit", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await stageExtractedRuntime(repositoryRoot);
    const destination = path.join(
      repositoryRoot,
      "src-tauri",
      "binaries",
      `agent-team-node-${DARWIN_ARM_HOST}`,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    // Same byte count as the packed binary, different content: a copy would overwrite it and
    // an unchanged file proves the size check decided not to copy.
    await writeFile(destination, "stale-binar");
    await chmod(destination, 0o644);

    await runPreparation(repositoryRoot);

    expect(await readFile(destination, "utf8")).toBe("stale-binar");
    expect((await stat(destination)).mode & 0o111).not.toBe(0);
  });

  it("leaves an executable binary of the same size untouched", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await stageExtractedRuntime(repositoryRoot);
    const destination = path.join(
      repositoryRoot,
      "src-tauri",
      "binaries",
      `agent-team-node-${DARWIN_ARM_HOST}`,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "stale-binar");
    await chmod(destination, 0o755);

    await runPreparation(repositoryRoot);

    expect(await readFile(destination, "utf8")).toBe("stale-binar");
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
  });

  it("does not touch the executable bit when the target is Windows", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await stageExtractedRuntime(repositoryRoot, { name: "win-x64", binary: ["node.exe"] });

    await runPreparation(repositoryRoot, "x86_64-pc-windows-msvc");

    expect(
      existsSync(
        path.join(
          repositoryRoot,
          "src-tauri",
          "binaries",
          "agent-team-node-x86_64-pc-windows-msvc.exe",
        ),
      ),
    ).toBe(true);
    expect(existsSync(path.join(repositoryRoot, "src-tauri", "runtime", "app", "package.json"))).toBe(
      true,
    );
  });

  it("allows a darwin host to package the other darwin architecture", async () => {
    const repositoryRoot = await makeRepositoryTree();
    await stageExtractedRuntime(repositoryRoot, { name: "darwin-x64" });
    const { written, stream } = recordingStdout();

    await main({
      argv: ["node", "prepare-desktop-runtime.mjs"],
      env: { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" },
      root: repositoryRoot,
      io: {
        spawn: (command: string, args: string[]) => {
          if (command === "rustc") return rustcHost(DARWIN_ARM_HOST);
          if (command === "tar") throw new Error("the runtime is already extracted");
          expect(args).toHaveLength(2);
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch: async () => {
          throw new Error("the runtime is already extracted");
        },
        stdout: stream,
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    });

    expect(written.join("")).toContain("for x86_64-apple-darwin");
    expect(
      existsSync(path.join(repositoryRoot, "src-tauri", "binaries", "agent-team-node-x86_64-apple-darwin")),
    ).toBe(true);
  });
});
