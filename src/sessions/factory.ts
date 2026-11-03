import type { AgentProfile } from "../config/schema.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { sanitizedChildEnv } from "../process/env.js";
import { runProcess } from "../process/run.js";
import { ClaudeStreamSession } from "./claude-session.js";
import { CodexAppServerSession } from "./codex-session.js";
import { OneShotSession } from "./oneshot-session.js";
import {
  NO_CAPABILITIES,
  type AgentSession,
  type OpenSessionOptions,
  type SessionCapabilities,
  type SessionKind,
} from "./types.js";

/**
 * Protocol shapes were verified against these CLI versions. Older builds fall
 * back to one-shot invocation rather than risk a drifted experimental API.
 */
export const MIN_CODEX_APP_SERVER_VERSION = "0.140.0";
export const MIN_CLAUDE_STREAM_VERSION = "2.1.0";

export type SessionMode = "auto" | "off";

export interface SessionPlan {
  kind: SessionKind;
  capabilities: SessionCapabilities;
  /** Why a live session was not chosen; absent when the adapter's best kind is in use. */
  reason?: string;
  version?: string;
}

export interface SessionFactoryOptions {
  registry?: AdapterRegistry;
  mode?: SessionMode;
  /** Test seam: resolve the CLI version for an executable. */
  versionProbe?: (executable: string, cwd: string) => Promise<string | undefined>;
}

export class SessionFactory {
  private readonly registry: AdapterRegistry;
  private readonly mode: SessionMode;
  private readonly probe: (executable: string, cwd: string) => Promise<string | undefined>;
  private readonly versions = new Map<string, Promise<string | undefined>>();

  constructor(options: SessionFactoryOptions = {}) {
    this.registry = options.registry ?? new AdapterRegistry();
    this.mode = options.mode ?? "auto";
    this.probe = options.versionProbe ?? probeVersion;
  }

  async plan(adapterName: string, profile: AgentProfile, cwd: string): Promise<SessionPlan> {
    if (this.mode === "off") return oneShotPlan("sessions are disabled");
    if (!isStreamableAdapter(adapterName)) return oneShotPlan();
    if (profile.args.length > 0) {
      return oneShotPlan("profile.args apply to one-shot invocation only");
    }
    const executable = profile.executable ?? adapterName;
    const version = await this.version(executable, cwd);
    if (!version) return oneShotPlan(`could not read the ${adapterName} version`);
    const minimum = minimumStreamVersion(adapterName);
    if (compareVersions(version, minimum) < 0) {
      return oneShotPlan(`${adapterName} ${version} is older than ${minimum}`, version);
    }
    return streamPlan(adapterName, version, profile);
  }

  async open(
    options: OpenSessionOptions & {
      sessionSchema?: Record<string, unknown>;
      artifactDirectory?: string;
      runId?: string;
    },
  ): Promise<AgentSession> {
    const plan = await this.plan(options.adapterName, options.profile, options.cwd);
    const executable = options.profile.executable ?? options.adapterName;
    if (plan.kind === "codex-app-server") return new CodexAppServerSession(options, executable);
    if (plan.kind === "claude-stream") return new ClaudeStreamSession(options, executable);
    return new OneShotSession(options, this.registry, {
      ...(options.artifactDirectory ? { artifactDirectory: options.artifactDirectory } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    });
  }

  private version(executable: string, cwd: string): Promise<string | undefined> {
    let cached = this.versions.get(executable);
    if (!cached) {
      cached = this.probe(executable, cwd).catch(() => undefined);
      this.versions.set(executable, cached);
    }
    return cached;
  }
}

function oneShotPlan(reason?: string, version?: string): SessionPlan {
  return {
    kind: "one-shot",
    capabilities: NO_CAPABILITIES,
    ...(reason ? { reason } : {}),
    ...(version ? { version } : {}),
  };
}

/** Only these two adapters keep a long-lived session. */
function isStreamableAdapter(adapterName: string): adapterName is "codex" | "claude" {
  return adapterName === "codex" || adapterName === "claude";
}

function minimumStreamVersion(adapterName: "codex" | "claude"): string {
  return adapterName === "codex" ? MIN_CODEX_APP_SERVER_VERSION : MIN_CLAUDE_STREAM_VERSION;
}

/** A resumed session needs inherited external tools; everything else steers. */
function streamPlan(
  adapterName: "codex" | "claude",
  version: string,
  profile: AgentProfile,
): SessionPlan {
  return {
    kind: adapterName === "codex" ? "codex-app-server" : "claude-stream",
    capabilities: {
      steer: true,
      interrupt: true,
      askUser: true,
      resume: profile.externalTools === "inherit",
    },
    version,
  };
}

async function probeVersion(executable: string, cwd: string): Promise<string | undefined> {
  const result = await runProcess({
    command: executable,
    args: ["--version"],
    cwd,
    timeoutMs: 10_000,
    env: sanitizedChildEnv(),
    maxOutputBytes: 4_096,
  });
  if (result.exitCode !== 0) return undefined;
  return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
