#!/usr/bin/env node
/**
 * Prepare the Node runtime and the production dependencies that ship inside the desktop
 * app under `src-tauri/runtime`.
 *
 * The executable entry is guarded and the pipeline is split in the same move, on purpose.
 * Importing this file used to start the whole pipeline: measure the Rust host, download
 * Node, extract it, install production dependencies, and replace
 * `src-tauri/runtime/app`. Nothing can test a file like that, so nothing did — every
 * function here sat at 0% coverage.
 *
 * Guarding it alone would have been worse. The top level carries about fifteen decisions,
 * and the moment they move inside a named function they enter the CRAP baseline at
 * cc15 @ 0% coverage: a 225-point debt, three times the size of the debt this file already
 * carried. Splitting the pipeline into the stages it really has keeps each stage small and
 * reachable from `main()`, so the guard buys testability instead of a bigger debt.
 *
 * The exported surface is the reusable judgement — platform mapping, checksum verdict,
 * portability invariant, staging cleanup, runtime assembly, the CLI projection — plus the
 * guard's own pure logic. The internal stages stay unexported: a step being testable by
 * going through `main()` is enough, and every extra export is an invitation to call it
 * from somewhere it was never meant to be called.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule as isEntryModule } from "./lib/is-main-module.mjs";

/**
 * The two fields the pipeline reads from a child process. Declared here so a test
 * can hand it a stand-in without reproducing `SpawnSyncReturns` — this file never
 * reads `pid`, `output` or `signal`, and requiring them would describe a wider
 * contract than the code has.
 *
 * @typedef {{ status: number | null, stdout: string, stderr: string }} ChildResult
 * @typedef {{
 *   spawn: (command: string, args: string[], options?: Record<string, unknown>) => ChildResult,
 *   fetch: (url: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, arrayBuffer: () => Promise<ArrayBuffer> }>,
 *   stdout: { write: (chunk: string) => unknown },
 *   run: (args: string[]) => ChildResult,
 * }} RuntimeIo
 */

const NODE_VERSION = "24.19.0";
const STAGING_PREFIX = ".app-staging-";

/**
 * Arguments the staging install must keep. `--prod` is the whole point: a dev dependency
 * that slips into this directory ships to every user, and `--frozen-lockfile` is what keeps
 * the shipped tree identical to the reviewed one.
 */
export const PNPM_INSTALL_ARGS = [
  "install",
  "--prod",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--config.node-linker=hoisted",
];

/** Build output copied next to the installed dependencies; paths are relative to the repo. */
const APPLICATION_ARTIFACTS = [["dist"], ["web", "dist"], ["prompts"], ["schemas"]];

/** Leftovers pnpm needs while installing and must not ship. */
const STAGING_NOISE = [
  ["pnpm-lock.yaml"],
  ["node_modules", ".bin"],
  ["node_modules", ".pnpm"],
  ["node_modules", ".modules.yaml"],
];

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_IO = {
  spawn: spawnSync,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  run: runPnpm,
};

/**
 * Turn an argv path into the file URL Node would use for the same file.
 *
 * Why not ``file://${argv[1]}``: on Windows `argv[1]` is `C:\...` while `import.meta.url` is
 * `file:///C:/...`, so that comparison is silently false and a guarded entry never runs —
 * the failure mode is a build that does nothing, which is far harder to diagnose than a
 * crash.
 *
 * Why a drive path does not go through `pathToFileURL` either: on Windows that helper
 * resolves `/D:/...` against the *current* drive and produces `\D:\...`, a URL naming a
 * different file, so the guard stays false for the same silent reason. The URL API has no
 * notion of a platform, so this branch is the same code on every runner — which is also what
 * lets a macOS test prove the Windows shape on a machine that has no `D:` drive.
 */
export function argvToModuleUrl(argvPath) {
  const slashed = argvPath.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(slashed)) {
    const url = new URL("file:///");
    url.pathname = `/${slashed}`;
    return url.href;
  }
  return pathToFileURL(slashed).href;
}

/**
 * Whether an argv path names this module: by the filesystem first, then by the
 * URL this platform would build from it. Two spellings of one path (`/tmp` and
 * `/private/tmp` on macOS) are one file, and only the filesystem knows that; a
 * modelled `D:\\…` argv has no local file at all, and only the URL knows that.
 */
function namesModule(moduleUrl, argvPath) {
  return argvToModuleUrl(argvPath) === moduleUrl || isEntryModule(moduleUrl, argvPath);
}

/** Whether an argv path names the module being evaluated. */
export function isMainModule(moduleUrl, argvPath) {
  if (argvPath === undefined || argvPath === "") return false;
  return namesModule(moduleUrl, argvPath);
}

/** Map a Rust target triple onto the Node distribution built for it. */
export function distributionFor(targetTriple) {
  const supported = {
    "aarch64-apple-darwin": {
      platform: "darwin",
      name: "darwin-arm64",
      extension: "tar.gz",
      binaryPath: ["bin", "node"],
      tarArguments: ["-xzf"],
    },
    "x86_64-apple-darwin": {
      platform: "darwin",
      name: "darwin-x64",
      extension: "tar.gz",
      binaryPath: ["bin", "node"],
      tarArguments: ["-xzf"],
    },
    "aarch64-unknown-linux-gnu": {
      platform: "linux",
      name: "linux-arm64",
      extension: "tar.xz",
      binaryPath: ["bin", "node"],
      tarArguments: ["-xJf"],
    },
    "x86_64-unknown-linux-gnu": {
      platform: "linux",
      name: "linux-x64",
      extension: "tar.xz",
      binaryPath: ["bin", "node"],
      tarArguments: ["-xJf"],
    },
    "x86_64-pc-windows-msvc": {
      platform: "windows",
      name: "win-x64",
      extension: "zip",
      binaryPath: ["node.exe"],
      tarArguments: ["-xf"],
    },
  };
  const selected = supported[targetTriple];
  if (!selected) {
    throw new Error(`Desktop runtime preparation does not yet support ${targetTriple}`);
  }
  return selected;
}

/**
 * How to start pnpm. When pnpm runs this script (`pnpm desktop:prepare`) it leaves its own
 * entry point in `npm_execpath`; launching that through `process.execPath` works on every
 * platform, while a bare `pnpm` would depend on PATH and on the `.cmd` shim on Windows.
 */
export function resolvePnpmInvocation({ npmExecPath, platform, execPath }) {
  if (npmExecPath && /\.[cm]?js$/i.test(npmExecPath)) {
    return { command: execPath, args: [npmExecPath] };
  }
  return { command: platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };
}

/**
 * Whether a file already holds the expected digest. A missing file is not an error — it is
 * the ordinary "nothing cached yet" case — while a read that fails for any other reason
 * (a directory, a permission problem) is a real failure and must not be swallowed into
 * "please download it", which would hide the cause behind a fresh download attempt.
 */
export async function hasChecksum(filePath, expected) {
  try {
    const contents = await readFile(filePath);
    return createHash("sha256").update(contents).digest("hex") === expected;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Refuse a production tree that cannot be moved to another machine. A symbolic link or a
 * target-specific native addon works on the machine that produced it and fails on the
 * user's, and it fails at first use rather than at packaging time.
 */
export async function assertPortableRuntime(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Desktop production runtime contains a non-portable symbolic link: ${entryPath}`);
    }
    if (entry.isFile() && entry.name.endsWith(".node")) {
      throw new Error(`Desktop production runtime contains a target-specific native addon: ${entryPath}`);
    }
    if (entry.isDirectory()) await assertPortableRuntime(entryPath);
  }
}

/** Remove staging directories a previous interrupted run left behind. */
export async function cleanupApplicationStagingDirectories(runtimeDirectory) {
  for (const entry of await readdir(runtimeDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(STAGING_PREFIX)) {
      await rm(path.join(runtimeDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Assemble `runtimeDirectory/app` from a fresh staging copy.
 *
 * The staging directory exists so a failed install never replaces a working app: the old
 * directory is removed only after the new tree passed the portability check and the smoke
 * test, and every failure path removes the staging copy before it rethrows.
 */
export async function prepareApplicationRuntime(
  runtimeDirectory,
  /** @type {{ repositoryRoot?: string, run?: (args: string[]) => ChildResult, spawn?: (command: string, args: string[], options?: Record<string, unknown>) => ChildResult }} */ {
    repositoryRoot = defaultRepositoryRoot,
    run = runPnpm,
    spawn = spawnSync,
  } = {},
) {
  const applicationDirectory = path.join(runtimeDirectory, "app");
  await cleanupApplicationStagingDirectories(runtimeDirectory);
  const stagingDirectory = await mkdtemp(path.join(runtimeDirectory, STAGING_PREFIX));
  try {
    await copyStagingManifests(stagingDirectory, repositoryRoot);
    await installProductionDependencies(stagingDirectory, run);
    await copyApplicationArtifacts(stagingDirectory, repositoryRoot);
    await removeStagingNoise(stagingDirectory);
    await assertPortableRuntime(stagingDirectory);
    await runRuntimeSmoke(stagingDirectory, spawn);
    await rm(applicationDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, applicationDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** The projection `--describe-target` prints; it never touches the filesystem. */
export function describeTarget(plan) {
  return {
    target: plan.target,
    archiveName: plan.archiveName,
    binaryPath: plan.distribution.binaryPath.join("/"),
    destinationName: plan.destinationName,
  };
}

/**
 * The executable entry.
 *
 * Every argument is required, including `root` and `io`. A default here would be a loaded
 * gun: the only reason to call `main` in a test is to drive it away from the real repository,
 * and a forgotten `root` would then quietly package `src-tauri/runtime` in the checkout. The
 * one place that knows the production values is the guard at the bottom of this file.
 *
 * `--describe-target` returns before the host check on purpose: describing a target is how a
 * packaging matrix asks "which archive would Windows get" from whichever host happens to run
 * the question, so requiring a matching native host would make the question unanswerable on
 * every other platform.
 */
/**
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   root: string,
 *   io: RuntimeIo,
 * }} options
 */
export async function main({ argv, env, root, io }) {
  const host = readRustHost(io.spawn);
  const plan = planDesktopRuntime({ env, host, root });
  if (argv.includes("--describe-target")) {
    io.stdout.write(`${JSON.stringify(describeTarget(plan))}\n`);
    return;
  }
  assertNativeHost(plan, host);
  await prepareNodeRuntime(plan, io);
  io.stdout.write(
    `Prepared Node v${NODE_VERSION} desktop runtime and production dependencies for ${plan.target}\n`,
  );
}

function readRustHost(spawn) {
  const rustc = spawn("rustc", ["-vV"], { encoding: "utf8" });
  if (rustc.status !== 0) {
    throw new Error(`Unable to inspect the Rust target: ${rustc.stderr || "rustc failed"}`);
  }
  const host = rustc.stdout.match(/^host:\s+(.+)$/m)?.[1]?.trim();
  if (!host) {
    throw new Error("Unable to determine the Rust host target");
  }
  return host;
}

function planDesktopRuntime({ env, host, root }) {
  const target = env.AGENT_TEAM_TAURI_TARGET ?? env.TAURI_ENV_TARGET_TRIPLE ?? host;
  const distribution = distributionFor(target);
  const archiveName = `node-v${NODE_VERSION}-${distribution.name}.${distribution.extension}`;
  const cacheRoot = path.join(root, ".cache", "desktop-runtime", `node-v${NODE_VERSION}`);
  const extractedRoot = path.join(cacheRoot, `node-v${NODE_VERSION}-${distribution.name}`);
  const destinationName = `agent-team-node-${target}${
    distribution.platform === "windows" ? ".exe" : ""
  }`;
  const binaryDirectory = path.join(root, "src-tauri", "binaries");
  return {
    root,
    host,
    target,
    distribution,
    archiveName,
    downloadRoot: `https://nodejs.org/dist/v${NODE_VERSION}`,
    cacheRoot,
    archivePath: path.join(cacheRoot, archiveName),
    extractedRoot,
    sourceBinary: path.join(extractedRoot, ...distribution.binaryPath),
    binaryDirectory,
    destinationName,
    destination: path.join(binaryDirectory, destinationName),
    runtimeDirectory: path.join(root, "src-tauri", "runtime"),
  };
}

function assertNativeHost(plan, host) {
  const hostDistribution = distributionFor(host);
  const supportsCrossArchitecture =
    plan.distribution.platform === "darwin" && hostDistribution.platform === "darwin";
  if (plan.target !== host && !supportsCrossArchitecture) {
    throw new Error(
      `Desktop packaging target ${plan.target} needs a matching native host; current host is ${host}`,
    );
  }
}

/**
 * The stages run in this order for a reason: the binary has to exist before the staging
 * install copies `dist`, the licence has to be staged before the app directory is replaced,
 * and nothing may be published before the smoke test passed. The order is observed by a
 * test that asserts the prerequisites exist at the moment the install runs.
 */
async function prepareNodeRuntime(plan, io) {
  await mkdir(plan.cacheRoot, { recursive: true });
  await ensureNodeArchive(plan, io);
  await installNodeBinary(plan);
  await stageNodeLicense(plan);
  await prepareApplicationRuntime(plan.runtimeDirectory, {
    repositoryRoot: plan.root,
    run: io.run,
    spawn: io.spawn,
  });
}

async function ensureNodeArchive(plan, io) {
  if (await exists(plan.sourceBinary)) return;
  const checksums = await fetchText(`${plan.downloadRoot}/SHASUMS256.txt`, io.fetch);
  const expectedChecksum = resolveExpectedChecksum(checksums, plan.archiveName);
  if (!expectedChecksum) {
    throw new Error(`Node checksum is unavailable for ${plan.archiveName}`);
  }
  if (!(await hasChecksum(plan.archivePath, expectedChecksum))) {
    const partialPath = `${plan.archivePath}.partial`;
    await downloadFile(`${plan.downloadRoot}/${plan.archiveName}`, partialPath, io.fetch);
    if (!(await hasChecksum(partialPath, expectedChecksum))) {
      throw new Error(`Node archive checksum verification failed for ${plan.archiveName}`);
    }
    await rename(partialPath, plan.archivePath);
  }
  await extractArchive(plan, io.spawn);
}

function resolveExpectedChecksum(checksums, archiveName) {
  return checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${archiveName}`))
    ?.split(/\s+/, 1)[0];
}

async function extractArchive(plan, spawn) {
  const extraction = spawn(
    "tar",
    [...plan.distribution.tarArguments, plan.archivePath, "-C", plan.cacheRoot],
    { encoding: "utf8" },
  );
  if (extraction.status !== 0) {
    throw new Error(`Unable to extract Node runtime: ${failureDetail(extraction, "tar failed")}`);
  }
}

async function installNodeBinary(plan) {
  await mkdir(plan.binaryDirectory, { recursive: true });
  const [sourceInfo, destinationInfo] = await Promise.all([
    stat(plan.sourceBinary),
    stat(plan.destination).catch(() => undefined),
  ]);
  const needsCopy = !destinationInfo || destinationInfo.size !== sourceInfo.size;
  if (needsCopy) {
    await copyFile(plan.sourceBinary, plan.destination);
  }
  if (plan.distribution.platform !== "windows" && (needsCopy || (destinationInfo.mode & 0o111) === 0)) {
    await chmod(plan.destination, 0o755);
  }
}

async function stageNodeLicense(plan) {
  await mkdir(plan.runtimeDirectory, { recursive: true });
  const licenseSource = path.join(plan.extractedRoot, "LICENSE");
  const licenseDestination = path.join(plan.runtimeDirectory, "NODE-LICENSE");
  const [licenseSourceInfo, licenseDestinationInfo] = await Promise.all([
    stat(licenseSource),
    stat(licenseDestination).catch(() => undefined),
  ]);
  if (!licenseDestinationInfo || licenseDestinationInfo.size !== licenseSourceInfo.size) {
    await copyFile(licenseSource, licenseDestination);
  }
}

async function copyStagingManifests(stagingDirectory, repositoryRoot) {
  await Promise.all([
    copyFile(path.join(repositoryRoot, "package.json"), path.join(stagingDirectory, "package.json")),
    copyFile(
      path.join(repositoryRoot, "pnpm-lock.yaml"),
      path.join(stagingDirectory, "pnpm-lock.yaml"),
    ),
  ]);
}

async function installProductionDependencies(stagingDirectory, run) {
  const install = run(["--dir", stagingDirectory, ...PNPM_INSTALL_ARGS]);
  if (install.status !== 0) {
    throw new Error(
      `Unable to install desktop production dependencies: ${failureDetail(install, "pnpm failed")}`,
    );
  }
}

async function copyApplicationArtifacts(stagingDirectory, repositoryRoot) {
  await Promise.all(
    APPLICATION_ARTIFACTS.map((segments) =>
      cp(path.join(repositoryRoot, ...segments), path.join(stagingDirectory, ...segments), {
        recursive: true,
      }),
    ),
  );
}

async function removeStagingNoise(stagingDirectory) {
  await Promise.all(
    STAGING_NOISE.map((segments) =>
      rm(path.join(stagingDirectory, ...segments), { recursive: true, force: true }),
    ),
  );
}

async function runRuntimeSmoke(stagingDirectory, spawn) {
  const smoke = spawn(
    process.execPath,
    [path.join(stagingDirectory, "dist", "cli.js"), "--version"],
    { cwd: stagingDirectory, encoding: "utf8" },
  );
  if (smoke.status !== 0) {
    throw new Error(
      `Desktop production runtime smoke test failed: ${failureDetail(smoke, "CLI failed")}`,
    );
  }
}

function runPnpm(args) {
  const invocation = resolvePnpmInvocation({
    npmExecPath: process.env.npm_execpath,
    platform: process.platform,
    execPath: process.execPath,
  });
  return spawnSync(invocation.command, [...invocation.args, ...args], {
    cwd: defaultRepositoryRoot,
    encoding: "utf8",
  });
}

/** A failed child process explains itself on either stream; keep whichever it wrote. */
function failureDetail(result, fallback) {
  return result.stderr || result.stdout || fallback;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return await response.text();
}

async function downloadFile(url, destinationPath, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destinationPath, new Uint8Array(await response.arrayBuffer()));
}

async function exists(filePath) {
  return await stat(filePath).then(
    () => true,
    () => false,
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main({
    argv: process.argv,
    env: process.env,
    root: defaultRepositoryRoot,
    io: DEFAULT_IO,
  });
}
