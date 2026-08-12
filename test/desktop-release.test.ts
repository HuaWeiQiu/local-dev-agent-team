import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("desktop PR release", () => {
  it("packages a self-contained production runtime", async () => {
    const config = JSON.parse(
      await readFile(path.join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { bundle: { resources: Record<string, string> } };
    const preparation = await readFile(
      path.join(repositoryRoot, "scripts", "prepare-desktop-runtime.mjs"),
      "utf8",
    );

    expect(config.bundle.resources).toEqual({ "runtime/": "runtime/" });
    expect(preparation).toContain('"--prod"');
    expect(preparation).toContain('"--frozen-lockfile"');
    expect(preparation).toContain('"--config.node-linker=hoisted"');
    expect(preparation).toContain('"dist", "cli.js"), "--version"');
  });

  it("declares native installer icons for macOS and Windows", async () => {
    const config = JSON.parse(
      await readFile(path.join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { bundle: { icon: string[] } };

    expect(config.bundle.icon).toContain("icons/icon.icns");
    expect(config.bundle.icon).toContain("icons/icon.ico");
    await expect(
      readFile(path.join(repositoryRoot, "src-tauri", "icons", "icon.ico")),
    ).resolves.not.toHaveLength(0);
  });

  it("describes the pinned Windows sidecar without downloading it", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "prepare-desktop-runtime.mjs"), "--describe-target"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_TEAM_TAURI_TARGET: "x86_64-pc-windows-msvc",
        },
      },
    );

    expect(JSON.parse(output)).toEqual({
      target: "x86_64-pc-windows-msvc",
      archiveName: "node-v24.19.0-win-x64.zip",
      binaryPath: "node.exe",
      destinationName: "agent-team-node-x86_64-pc-windows-msvc.exe",
    });
  });

  it("builds every PR revision with read-only pinned actions", async () => {
    const source = await readFile(
      path.join(repositoryRoot, ".github", "workflows", "desktop-pr-build.yml"),
      "utf8",
    );
    const workflow = parse(source) as {
      on: {
        pull_request: { types: string[] };
        workflow_dispatch?: Record<string, unknown> | null;
      };
      permissions: Record<string, string>;
      jobs: {
        "build-desktop": {
          permissions?: Record<string, string>;
          strategy: {
            matrix: {
              include: Array<{ label: string; platform: string; target: string; args: string }>;
            };
          };
          steps: Array<{ uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }>;
        };
      };
    };
    const job = workflow.jobs["build-desktop"];

    expect(workflow.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(job.strategy.matrix.include).toEqual([
      { label: "macos-arm64", platform: "macos-latest", target: "aarch64-apple-darwin", args: "--target aarch64-apple-darwin", "rust-targets": "aarch64-apple-darwin,x86_64-apple-darwin" },
      { label: "macos-x64", platform: "macos-latest", target: "x86_64-apple-darwin", args: "--target x86_64-apple-darwin", "rust-targets": "aarch64-apple-darwin,x86_64-apple-darwin" },
      { label: "windows-x64", platform: "windows-latest", target: "x86_64-pc-windows-msvc", args: "", "rust-targets": "" },
    ]);
    const actionRefs = job.steps.flatMap((step) => step.uses ? [step.uses] : []);
    expect(actionRefs.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true);
    const build = job.steps.find((step) => step.uses?.startsWith("tauri-apps/tauri-action@"));
    expect(build?.env).toEqual({ AGENT_TEAM_TAURI_TARGET: "${{ matrix.target }}" });
    expect(build?.with).toMatchObject({
      uploadUpdaterJson: false,
      uploadWorkflowArtifacts: true,
    });
  });

  it("publishes from one trusted workflow_run job without executing PR code", async () => {
    const source = await readFile(
      path.join(repositoryRoot, ".github", "workflows", "desktop-pr-release.yml"),
      "utf8",
    );
    const workflow = parse(source) as {
      on: { workflow_run: { workflows: string[]; types: string[] } };
      permissions: Record<string, string>;
      jobs: {
        publish: {
          if: string;
          permissions: Record<string, string>;
          steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        };
      };
    };
    const publish = workflow.jobs.publish;

    expect(workflow.on.workflow_run).toEqual({
      workflows: ["Desktop PR Build"],
      types: ["completed"],
    });
    expect(workflow.permissions).toEqual({});
    expect(publish.if).toContain("head_repository.full_name == github.repository");
    expect(publish.permissions).toEqual({ actions: "read", contents: "write" });
    expect(publish.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(publish.steps.some((step) => step.uses?.startsWith("tauri-apps/tauri-action@"))).toBe(false);
    const download = publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(download?.with).toMatchObject({
      "merge-multiple": true,
      "run-id": "${{ github.event.workflow_run.id }}",
    });
    const publisherScript = publish.steps.map((step) => step.run ?? "").join("\n");
    expect(publisherScript).toContain("*aarch64*.dmg");
    expect(publisherScript).toContain("*x64*.dmg");
    expect(publisherScript).toContain("*.msi|*.exe");
    expect(publisherScript).toContain("tag_sha");
    expect(publisherScript).toContain('"$tag_sha" != "$HEAD_SHA"');
    expect(publisherScript).toContain("gh release create");
  });
});
