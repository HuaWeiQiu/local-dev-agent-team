import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokAdapter } from "../src/adapters/grok.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { adapterRoleWarning } from "../src/adapters/conformance.js";
import type { AgentProfile } from "../src/config/schema.js";
import { loadDesktopSettings, saveDesktopSettings } from "../src/desktop/settings.js";
import { loadProjectRoleSettings, saveProjectRoleSettings } from "../src/desktop/project-role-settings.js";
import {
  envSecretValues,
  redactEnvSecrets,
  sanitizedChildEnv,
} from "../src/process/env.js";
import { runProcess } from "../src/process/run.js";
import { runQualityCommands } from "../src/quality/run.js";

const SESSION_TOKEN = "session-token-0123456789abcdef";
const PROFILE_BASE: AgentProfile = {
  adapter: "kimi",
  model: "inherit",
  reasoning: "high",
  permission: "read-only",
  externalTools: "deny",
  timeoutSeconds: 60,
  args: [],
};

describe("sanitizedChildEnv", () => {
  it("strips AGENT_TEAM_* variables and keeps everything else", () => {
    const env = sanitizedChildEnv({
      AGENT_TEAM_SESSION_TOKEN: SESSION_TOKEN,
      AGENT_TEAM_HOME: "/tmp/agent-team-home",
      AGENT_TEAM_PROJECT_REGISTRY: "/tmp/registry.json",
      PATH: "/usr/bin",
      HOME: "/home/user",
      HTTPS_PROXY: "http://proxy:8080",
      KIMI_CODE_HOME: "/home/user/.kimi-code",
    });

    expect(env.AGENT_TEAM_SESSION_TOKEN).toBeUndefined();
    expect(env.AGENT_TEAM_HOME).toBeUndefined();
    expect(env.AGENT_TEAM_PROJECT_REGISTRY).toBeUndefined();
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/user",
      HTTPS_PROXY: "http://proxy:8080",
      KIMI_CODE_HOME: "/home/user/.kimi-code",
    });
  });
});

describe("env secret redaction", () => {
  it("collects only AGENT_TEAM_* values long enough to be secrets", () => {
    const secrets = envSecretValues({
      AGENT_TEAM_SESSION_TOKEN: SESSION_TOKEN,
      AGENT_TEAM_HOME: "/tmp/at",
      AGENT_TEAM_FLAG: "1",
      PATH: "/usr/bin",
    });

    expect(secrets).toEqual([SESSION_TOKEN]);
  });

  it("replaces exact secret occurrences with [redacted]", () => {
    const text = `token=${SESSION_TOKEN}\nagain ${SESSION_TOKEN}\nshort 1 stays`;
    const redacted = redactEnvSecrets(text, [SESSION_TOKEN]);

    expect(redacted).toBe(`token=[redacted]\nagain [redacted]\nshort 1 stays`);
    expect(redactEnvSecrets(text, [])).toBe(text);
  });
});

describe("child process environment hygiene", () => {
  afterEach(() => {
    delete process.env.AGENT_TEAM_SESSION_TOKEN;
  });

  it("does not pass AGENT_TEAM_* variables to spawned processes by default", async () => {
    process.env.AGENT_TEAM_SESSION_TOKEN = SESSION_TOKEN;

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log(process.env.AGENT_TEAM_SESSION_TOKEN ?? 'unset')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("unset");
    expect(result.stdout).not.toContain(SESSION_TOKEN);
  });

  it("redacts the session token from captured and streamed output", async () => {
    process.env.AGENT_TEAM_SESSION_TOKEN = SESSION_TOKEN;
    const streamed: string[] = [];

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(`leaked ${SESSION_TOKEN} end`)})`],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onStdout: (chunk) => streamed.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("leaked [redacted] end\n");
    expect(result.stdout).not.toContain(SESSION_TOKEN);
    expect(streamed.join("")).toBe("leaked [redacted] end\n");
  });

  it("does not expose AGENT_TEAM_* variables to quality commands", async () => {
    process.env.AGENT_TEAM_SESSION_TOKEN = SESSION_TOKEN;
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-env-"));
    const artifactDirectory = path.join(cwd, "artifacts");

    const report = await runQualityCommands(
      cwd,
      [
        {
          command: process.execPath,
          args: ["-e", "console.log(process.env.AGENT_TEAM_SESSION_TOKEN ?? 'unset')"],
        },
      ],
      30,
      artifactDirectory,
    );

    expect(report.passed).toBe(true);
    expect(report.commands[0]?.stdout.trim()).toBe("unset");
    const log = await readFile(path.join(artifactDirectory, "1.log"), "utf8");
    expect(log).not.toContain(SESSION_TOKEN);
  });

  it("keeps CI=true for quality commands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-quality-ci-"));

    const report = await runQualityCommands(
      cwd,
      [{ command: process.execPath, args: ["-e", "console.log(process.env.CI)"] }],
      30,
    );

    expect(report.commands[0]?.stdout.trim()).toBe("true");
  });
});

describe("adapter child environments", () => {
  afterEach(() => {
    delete process.env.AGENT_TEAM_SESSION_TOKEN;
  });

  it("kimi invocations never inherit AGENT_TEAM_* variables", () => {
    process.env.AGENT_TEAM_SESSION_TOKEN = SESSION_TOKEN;

    const invocation = new KimiAdapter().buildInvocation(PROFILE_BASE, {
      cwd: "/tmp/repo",
      prompt: "Review",
    });

    expect(invocation.env).toBeDefined();
    const keys = Object.keys(invocation.env ?? {});
    expect(keys.some((key) => key.startsWith("AGENT_TEAM_"))).toBe(false);
    expect(invocation.env?.KIMI_CODE_HOME).toBeDefined();
    expect(invocation.env?.PATH).toBe(process.env.PATH);
  });

  it("grok invocations never inherit AGENT_TEAM_* variables", () => {
    process.env.AGENT_TEAM_SESSION_TOKEN = SESSION_TOKEN;
    const grokProfile: AgentProfile = { ...PROFILE_BASE, adapter: "grok" };
    const request = { cwd: "/tmp/repo", prompt: "Review", promptFile: "/tmp/managed/prompt.txt" };

    const denied = new GrokAdapter().buildInvocation(grokProfile, request);
    const inherited = new GrokAdapter().buildInvocation(
      { ...grokProfile, externalTools: "inherit", permission: "workspace-write" },
      request,
    );

    for (const env of [denied.env, inherited.env]) {
      expect(env).toBeDefined();
      expect(Object.keys(env ?? {}).some((key) => key.startsWith("AGENT_TEAM_"))).toBe(false);
      expect(env?.PATH).toBe(process.env.PATH);
    }
    // The HOME isolation for deny-mode Grok invocations is preserved.
    expect(denied.env?.HOME).toBe("/tmp/managed");
    expect(denied.env?.GROK_HOME).toBeDefined();
  });
});

describe("kimi read-only role warning", () => {
  it("warns when a read-only-designed role runs on a kimi profile", () => {
    const warning = adapterRoleWarning("reviewer", PROFILE_BASE);

    expect(warning).toBeDefined();
    expect(warning).toContain("reviewer");
    expect(warning).toContain("prompt-based");
    expect(warning).toContain("no execution-layer enforcement");
  });

  it("stays silent for the worker role and for enforcing adapters", () => {
    expect(adapterRoleWarning("worker", { ...PROFILE_BASE, permission: "workspace-write" })).toBeUndefined();
    expect(adapterRoleWarning("worker", PROFILE_BASE)).toBeUndefined();
    expect(
      adapterRoleWarning("reviewer", { ...PROFILE_BASE, adapter: "codex" }),
    ).toBeUndefined();
    expect(
      adapterRoleWarning("reviewer", { ...PROFILE_BASE, permission: "workspace-write" }),
    ).toBeUndefined();
  });
});

describe("desktop settings file permissions", () => {
  it("writes desktop-settings.json with mode 0600", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-settings-"));

    await saveDesktopSettings(await loadDesktopSettings(home), home);

    const filePath = path.join(home, ".agent-team", "desktop-settings.json");
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions of a pre-existing 0644 settings file on load", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-settings-"));
    const settingsDirectory = path.join(home, ".agent-team");
    const filePath = path.join(settingsDirectory, "desktop-settings.json");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ version: 1 }, null, 2)}\n`, "utf8");
    await chmod(filePath, 0o644);
    expect((await stat(filePath)).mode & 0o777).toBe(0o644);

    const settings = await loadDesktopSettings(home);

    expect(settings.version).toBe(1);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("writes project role-settings.json with mode 0600", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-project-roles-"));

    await saveProjectRoleSettings(root, ".agent-team", {
      version: 1,
      roles: { worker: { cli: "grok", model: "grok-4.6", reasoning: "high" } },
    });
    const filePath = path.join(root, ".agent-team", "role-settings.json");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const loaded = await loadProjectRoleSettings(root, ".agent-team");
    expect(loaded.roles.worker?.cli).toBe("grok");
  });
});
