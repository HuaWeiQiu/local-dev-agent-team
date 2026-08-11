import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
process.stdout.write(`Prepared Node v${nodeVersion} desktop runtime for ${target}\n`);

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
