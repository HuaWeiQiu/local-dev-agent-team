import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const DARWIN_ARM_HOST = "aarch64-apple-darwin";

const roots: string[] = [];

/** A temporary directory that `cleanupRoots` reclaims, so no case leaks a tree behind. */
export const makeRoot = async (prefix = "desktop-runtime-"): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

export const cleanupRoots = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
};

/** A repository root laid out the way the packaging script expects to find it. */
export const makeRepositoryTree = async (): Promise<string> => {
  const root = await makeRoot();
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "web", "dist"), { recursive: true });
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await mkdir(path.join(root, "schemas"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}');
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(root, "dist", "cli.js"), "process.stdout.write('fixture');\n");
  await writeFile(path.join(root, "web", "dist", "index.html"), "<!doctype html>");
  await writeFile(path.join(root, "prompts", "plan.md"), "prompt");
  await writeFile(path.join(root, "schemas", "plan.json"), "{}");
  return root;
};

/** A Node runtime already extracted into the cache, so the download path stays untouched. */
export const stageExtractedRuntime = async (
  root: string,
  { name = "darwin-arm64", binary = ["bin", "node"] }: { name?: string; binary?: string[] } = {},
): Promise<void> => {
  const extracted = path.join(
    root,
    ".cache",
    "desktop-runtime",
    "node-v24.19.0",
    `node-v24.19.0-${name}`,
  );
  const binaryPath = path.join(extracted, ...binary);
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, "node-binary");
  await writeFile(path.join(extracted, "LICENSE"), "node-license");
};

/** What `rustc -vV` prints, in the shape the script parses. */
export const rustcHost = (host: string) => ({
  status: 0,
  stdout: `rustc 1.90.0 (fixture)\nbinary: rustc\nhost: ${host}\nrelease: 1.90.0\n`,
  stderr: "",
});

/** A stand-in for `process.stdout` that records what the entry printed. */
export const recordingStdout = () => {
  const written: string[] = [];
  return {
    written,
    stream: {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    },
  };
};

export const stagingEntries = async (runtimeDirectory: string): Promise<string[]> =>
  (await readdir(runtimeDirectory)).filter((name) => name.startsWith(".app-staging-"));
