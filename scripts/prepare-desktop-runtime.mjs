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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nodeVersion = "24.19.0";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustc.status !== 0) {
  throw new Error(`Unable to inspect the Rust target: ${rustc.stderr || "rustc failed"}`);
}

const host = rustc.stdout.match(/^host:\s+(.+)$/m)?.[1]?.trim();
if (!host) {
  throw new Error("Unable to determine the Rust host target");
}

const target = process.env.AGENT_TEAM_TAURI_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
const distribution = distributionFor(target);
const archiveName = `node-v${nodeVersion}-${distribution.name}.${distribution.extension}`;
const downloadRoot = `https://nodejs.org/dist/v${nodeVersion}`;
const cacheRoot = path.join(repositoryRoot, ".cache", "desktop-runtime", `node-v${nodeVersion}`);
const archivePath = path.join(cacheRoot, archiveName);
const extractedRoot = path.join(cacheRoot, `node-v${nodeVersion}-${distribution.name}`);
const sourceBinary = path.join(extractedRoot, ...distribution.binaryPath);
const binaryDirectory = path.join(repositoryRoot, "src-tauri", "binaries");
const destinationName = `agent-team-node-${target}${distribution.platform === "windows" ? ".exe" : ""}`;
const destination = path.join(binaryDirectory, destinationName);

if (process.argv.includes("--describe-target")) {
  process.stdout.write(`${JSON.stringify({
    target,
    archiveName,
    binaryPath: distribution.binaryPath.join("/"),
    destinationName,
  })}\n`);
  process.exit(0);
}

const hostDistribution = distributionFor(host);
const supportsCrossArchitecture = distribution.platform === "darwin"
  && hostDistribution.platform === "darwin";
if (target !== host && !supportsCrossArchitecture) {
  throw new Error(
    `Desktop packaging target ${target} needs a matching native host; current host is ${host}`,
  );
}

await mkdir(cacheRoot, { recursive: true });

if (!(await exists(sourceBinary))) {
  const checksums = await fetchText(`${downloadRoot}/SHASUMS256.txt`);
  const expectedChecksum = checksums
    .split("\n")
    .find((line) => line.endsWith(`  ${archiveName}`))
    ?.split(/\s+/, 1)[0];
  if (!expectedChecksum) {
    throw new Error(`Node checksum is unavailable for ${archiveName}`);
  }
  if (!(await hasChecksum(archivePath, expectedChecksum))) {
    const partialPath = `${archivePath}.partial`;
    await downloadFile(`${downloadRoot}/${archiveName}`, partialPath);
    if (!(await hasChecksum(partialPath, expectedChecksum))) {
      throw new Error(`Node archive checksum verification failed for ${archiveName}`);
    }
    await rename(partialPath, archivePath);
  }
  const extraction = spawnSync("tar", [...distribution.tarArguments, archivePath, "-C", cacheRoot], {
    encoding: "utf8",
  });
  if (extraction.status !== 0) {
    throw new Error(`Unable to extract Node runtime: ${extraction.stderr || "tar failed"}`);
  }
}

await mkdir(binaryDirectory, { recursive: true });
const [sourceInfo, destinationInfo] = await Promise.all([
  stat(sourceBinary),
  stat(destination).catch(() => undefined),
]);
const needsCopy = !destinationInfo || destinationInfo.size !== sourceInfo.size;
if (needsCopy) {
  await copyFile(sourceBinary, destination);
}
if (distribution.platform !== "windows" && (needsCopy || (destinationInfo.mode & 0o111) === 0)) {
  await chmod(destination, 0o755);
}

const runtimeDirectory = path.join(repositoryRoot, "src-tauri", "runtime");
await mkdir(runtimeDirectory, { recursive: true });
const licenseSource = path.join(extractedRoot, "LICENSE");
const licenseDestination = path.join(runtimeDirectory, "NODE-LICENSE");
const [licenseSourceInfo, licenseDestinationInfo] = await Promise.all([
  stat(licenseSource),
  stat(licenseDestination).catch(() => undefined),
]);
if (!licenseDestinationInfo || licenseDestinationInfo.size !== licenseSourceInfo.size) {
  await copyFile(licenseSource, licenseDestination);
}
await prepareApplicationRuntime(runtimeDirectory);
process.stdout.write(`Prepared Node v${nodeVersion} desktop runtime and production dependencies for ${target}\n`);

async function prepareApplicationRuntime(runtimeDirectory) {
  const applicationDirectory = path.join(runtimeDirectory, "app");
  await cleanupApplicationStagingDirectories(runtimeDirectory);
  const stagingDirectory = await mkdtemp(path.join(runtimeDirectory, ".app-staging-"));
  try {
    await Promise.all([
      copyFile(path.join(repositoryRoot, "package.json"), path.join(stagingDirectory, "package.json")),
      copyFile(path.join(repositoryRoot, "pnpm-lock.yaml"), path.join(stagingDirectory, "pnpm-lock.yaml")),
    ]);

    const install = runPnpm([
      "--dir",
      stagingDirectory,
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
    ]);
    if (install.status !== 0) {
      throw new Error(`Unable to install desktop production dependencies: ${install.stderr || install.stdout || "pnpm failed"}`);
    }

    await Promise.all([
      cp(path.join(repositoryRoot, "dist"), path.join(stagingDirectory, "dist"), { recursive: true }),
      cp(path.join(repositoryRoot, "web", "dist"), path.join(stagingDirectory, "web", "dist"), { recursive: true }),
      cp(path.join(repositoryRoot, "prompts"), path.join(stagingDirectory, "prompts"), { recursive: true }),
      cp(path.join(repositoryRoot, "schemas"), path.join(stagingDirectory, "schemas"), { recursive: true }),
    ]);
    await Promise.all([
      rm(path.join(stagingDirectory, "pnpm-lock.yaml"), { force: true }),
      rm(path.join(stagingDirectory, "node_modules", ".bin"), { recursive: true, force: true }),
      rm(path.join(stagingDirectory, "node_modules", ".pnpm"), { recursive: true, force: true }),
      rm(path.join(stagingDirectory, "node_modules", ".modules.yaml"), { force: true }),
    ]);
    await assertPortableRuntime(stagingDirectory);

    const smoke = spawnSync(
      process.execPath,
      [path.join(stagingDirectory, "dist", "cli.js"), "--version"],
      { cwd: stagingDirectory, encoding: "utf8" },
    );
    if (smoke.status !== 0) {
      throw new Error(`Desktop production runtime smoke test failed: ${smoke.stderr || smoke.stdout || "CLI failed"}`);
    }

    await rm(applicationDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, applicationDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupApplicationStagingDirectories(runtimeDirectory) {
  for (const entry of await readdir(runtimeDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".app-staging-")) {
      await rm(path.join(runtimeDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
  return spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function assertPortableRuntime(directory) {
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

function distributionFor(targetTriple) {
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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return await response.text();
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destinationPath, new Uint8Array(await response.arrayBuffer()));
}

async function hasChecksum(filePath, expected) {
  try {
    const contents = await readFile(filePath);
    return createHash("sha256").update(contents).digest("hex") === expected;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function exists(filePath) {
  return await stat(filePath).then(() => true, () => false);
}
