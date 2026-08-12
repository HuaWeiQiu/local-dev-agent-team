import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runProcess } from "../process/run.js";

export type CliId = "codex" | "grok" | "kimi" | "claude";

export interface CliModelInfo {
  id: string;
  label: string;
  provider?: string;
  reasoningOptions?: string[];
}

export interface CliProviderInfo {
  id: string;
  baseUrl?: string;
  wireApi?: string;
}

export interface CliAuthInfo {
  status: "unknown" | "present" | "missing" | "invalid";
  detail?: string;
}

export interface CliProbeResult {
  id: CliId;
  binary?: string;
  installed: boolean;
  version?: string;
  auth: CliAuthInfo;
  configPaths: string[];
  models: CliModelInfo[];
  defaultModel?: string;
  defaultReasoning?: string;
  providers?: CliProviderInfo[];
  /** false when Agent Team cannot invoke this CLI yet */
  runtimeSupported: boolean;
}

export interface CliInventory {
  scannedAt: string;
  home: string;
  clis: CliProbeResult[];
}

const CODEX_REASONING = ["low", "medium", "high", "xhigh", "max"];
const GROK_REASONING = ["low", "medium", "high"];
const KIMI_REASONING = ["low", "medium", "high", "xhigh"];
const CLAUDE_REASONING = ["low", "medium", "high"];

export async function scanCliInventory(home = homedir()): Promise<CliInventory> {
  const clis = await Promise.all([
    probeCodex(home),
    probeGrok(home),
    probeKimi(home),
    probeClaude(home),
  ]);
  return {
    scannedAt: new Date().toISOString(),
    home,
    clis,
  };
}

async function probeCodex(home: string): Promise<CliProbeResult> {
  const configPath = path.join(home, ".codex", "config.toml");
  const authPath = path.join(home, ".codex", "auth.json");
  const configPaths: string[] = [];
  const binary = await whichBinary(["codex"]);
  let version: string | undefined;
  if (binary) version = await tryVersion(binary, ["--version"]);

  let defaultModel: string | undefined;
  let defaultReasoning: string | undefined;
  const models: CliModelInfo[] = [];
  const providers: CliProviderInfo[] = [];
  let auth: CliAuthInfo = { status: "unknown" };

  if (await exists(configPath)) {
    configPaths.push(configPath);
    const text = await readFile(configPath, "utf8");
    defaultModel = matchTomlString(text, "model") ?? undefined;
    defaultReasoning = matchTomlString(text, "model_reasoning_effort") ?? undefined;
    for (const block of matchTomlTables(text, "model_providers")) {
      providers.push({
        id: block.id,
        ...(block.fields.base_url ? { baseUrl: block.fields.base_url } : {}),
        ...(block.fields.wire_api ? { wireApi: block.fields.wire_api } : {}),
      });
    }
    if (defaultModel) {
      models.push({
        id: defaultModel,
        label: defaultModel,
        reasoningOptions: [...CODEX_REASONING],
      });
    }
    // Common models as suggestions even if not default
    for (const id of ["gpt-5.6-sol", "gpt-5.5", "o3", "o4-mini"]) {
      if (!models.some((m) => m.id === id)) {
        models.push({ id, label: id, reasoningOptions: [...CODEX_REASONING] });
      }
    }
  }

  if (await exists(authPath)) {
    configPaths.push(authPath);
    auth = { status: "present", detail: "auth.json 存在" };
  } else if (await exists(configPath)) {
    auth = { status: "missing", detail: "未找到 auth.json，可能未登录" };
  } else {
    auth = binary
      ? { status: "missing", detail: "未找到 ~/.codex/config.toml" }
      : { status: "missing", detail: "未安装 codex" };
  }

  return {
    id: "codex",
    ...(binary ? { binary } : {}),
    installed: Boolean(binary),
    ...(version ? { version } : {}),
    auth,
    configPaths,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoning ? { defaultReasoning } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    runtimeSupported: true,
  };
}

async function probeGrok(home: string): Promise<CliProbeResult> {
  const configPath = path.join(home, ".grok", "config.toml");
  const localBin = path.join(home, ".grok", "bin", "grok");
  const binary = (await exists(localBin)) ? localBin : await whichBinary(["grok"]);
  let version: string | undefined;
  if (binary) version = await tryVersion(binary, ["--version"]);

  const configPaths: string[] = [];
  const models: CliModelInfo[] = [];
  let defaultModel: string | undefined;
  let auth: CliAuthInfo = { status: "unknown" };

  if (await exists(configPath)) {
    configPaths.push(configPath);
    const text = await readFile(configPath, "utf8");
    defaultModel = matchTomlString(text, "default", "models") ?? matchTomlString(text, "model", "model.grok") ?? "grok";
    const hasKey = /api_key\s*=\s*["']?[^"'\s]+/i.test(text);
    auth = hasKey
      ? { status: "present", detail: "config.toml 中已配置 api_key（未读取内容）" }
      : { status: "missing", detail: "config.toml 存在但未发现 api_key" };
    for (const block of matchTomlTables(text, "model")) {
      models.push({
        id: block.id,
        label: block.fields.name ?? block.fields.model ?? block.id,
        reasoningOptions: [...GROK_REASONING],
      });
    }
    if (models.length === 0) {
      models.push({ id: "grok", label: "grok", reasoningOptions: [...GROK_REASONING] });
    }
  } else {
    auth = binary
      ? { status: "missing", detail: "未找到 ~/.grok/config.toml" }
      : { status: "missing", detail: "未安装 grok" };
    models.push({ id: "grok", label: "grok", reasoningOptions: [...GROK_REASONING] });
  }

  return {
    id: "grok",
    ...(binary ? { binary } : {}),
    installed: Boolean(binary),
    ...(version ? { version } : {}),
    auth,
    configPaths,
    models,
    ...(defaultModel ? { defaultModel } : { defaultModel: "grok" }),
    defaultReasoning: "high",
    runtimeSupported: true,
  };
}

async function probeKimi(home: string): Promise<CliProbeResult> {
  const configPath = path.join(home, ".kimi-code", "config.toml");
  const localBin = path.join(home, ".kimi-code", "bin", "kimi");
  const binary = (await exists(localBin)) ? localBin : await whichBinary(["kimi"]);
  let version: string | undefined;
  if (binary) version = await tryVersion(binary, ["--version"]);

  const configPaths: string[] = [];
  const models: CliModelInfo[] = [];
  let defaultModel: string | undefined;
  let defaultReasoning: string | undefined;
  let auth: CliAuthInfo = { status: "unknown" };

  if (await exists(configPath)) {
    configPaths.push(configPath);
    const text = await readFile(configPath, "utf8");
    defaultModel = matchTomlString(text, "default_model") ?? undefined;
    defaultReasoning = matchTomlString(text, "effort", "thinking") ?? undefined;
    const hasProviderKey = /\[providers\.[^\]]+\][\s\S]*?api_key\s*=/i.test(text);
    auth = hasProviderKey
      ? { status: "present", detail: "providers 中已配置 api_key（未读取内容）" }
      : { status: "missing", detail: "config.toml 存在但未发现 provider api_key" };
    for (const block of matchTomlTables(text, "models")) {
      models.push({
        id: block.id,
        label: block.fields.display_name ?? block.fields.model ?? block.id,
        ...(block.fields.provider ? { provider: block.fields.provider } : {}),
        reasoningOptions: [...KIMI_REASONING],
      });
    }
  } else {
    auth = binary
      ? { status: "missing", detail: "未找到 ~/.kimi-code/config.toml" }
      : { status: "missing", detail: "未安装 kimi" };
  }

  return {
    id: "kimi",
    ...(binary ? { binary } : {}),
    installed: Boolean(binary),
    ...(version ? { version } : {}),
    auth,
    configPaths,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoning ? { defaultReasoning } : {}),
    runtimeSupported: true,
  };
}

async function probeClaude(home: string): Promise<CliProbeResult> {
  const settingsPath = path.join(home, ".claude", "settings.json");
  const binary = await whichBinary(["claude"]);
  let version: string | undefined;
  if (binary) version = await tryVersion(binary, ["--version"]);

  const configPaths: string[] = [];
  const models: CliModelInfo[] = [];
  let defaultModel: string | undefined;
  let auth: CliAuthInfo = { status: "unknown" };

  if (await exists(settingsPath)) {
    configPaths.push(settingsPath);
    try {
      const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      if (typeof raw.model === "string") {
        defaultModel = raw.model;
        models.push({ id: raw.model, label: raw.model, reasoningOptions: [...CLAUDE_REASONING] });
      }
      if (Array.isArray(raw.availableModels)) {
        for (const item of raw.availableModels) {
          const id = typeof item === "string" ? item : typeof item === "object" && item && "id" in item
            ? String((item as { id: unknown }).id)
            : undefined;
          if (id && !models.some((m) => m.id === id)) {
            models.push({ id, label: id, reasoningOptions: [...CLAUDE_REASONING] });
          }
        }
      }
      auth = { status: "present", detail: "settings.json 存在" };
    } catch {
      auth = { status: "unknown", detail: "settings.json 无法解析" };
    }
  } else {
    auth = binary
      ? { status: "missing", detail: "未找到 ~/.claude/settings.json" }
      : { status: "missing", detail: "未安装 claude" };
  }

  if (models.length === 0) {
    for (const id of ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "sonnet", "opus"]) {
      models.push({ id, label: id, reasoningOptions: [...CLAUDE_REASONING] });
    }
  }

  return {
    id: "claude",
    ...(binary ? { binary } : {}),
    installed: Boolean(binary),
    ...(version ? { version } : {}),
    auth,
    configPaths,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    defaultReasoning: "high",
    runtimeSupported: true,
  };
}

async function whichBinary(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      const result = await runProcess({
        command: process.platform === "win32" ? "where" : "which",
        args: [name],
        cwd: homedir(),
        timeoutMs: 3_000,
      });
      const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
      if (result.exitCode === 0 && line) return line.trim();
    } catch {
      // continue
    }
  }
  return undefined;
}

async function tryVersion(binary: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runProcess({
      command: binary,
      args,
      cwd: homedir(),
      timeoutMs: 5_000,
    });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return text.split(/\r?\n/).find(Boolean)?.slice(0, 120);
  } catch {
    return undefined;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function matchTomlString(text: string, key: string, section?: string): string | null {
  if (section) {
    const sectionRe = new RegExp(
      `\\[${escapeRegExp(section)}\\]([^\\[]*)`,
      "i",
    );
    const block = text.match(sectionRe)?.[1] ?? "";
    return matchTomlString(block, key);
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, "mi");
  const m = text.match(re);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function matchTomlTables(
  text: string,
  prefix: string,
): Array<{ id: string; fields: Record<string, string> }> {
  const re = new RegExp(
    `\\[${escapeRegExp(prefix)}\\.("([^"]+)"|([A-Za-z0-9_.-]+))\\]([^\\[]*)`,
    "gi",
  );
  const out: Array<{ id: string; fields: Record<string, string> }> = [];
  for (const match of text.matchAll(re)) {
    const id = match[2] ?? match[3] ?? "";
    const body = match[4] ?? "";
    const fields: Record<string, string> = {};
    for (const line of body.split(/\r?\n/)) {
      const fm = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]+))/);
      if (!fm?.[1]) continue;
      const value = (fm[2] ?? fm[3] ?? fm[4] ?? "").trim();
      if (/key|token|secret|password/i.test(fm[1])) continue;
      fields[fm[1]] = value;
    }
    out.push({ id, fields });
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
