import { access, readFile, stat } from "node:fs/promises";
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
  /**
   * Fingerprint of watched CLI config files (mtime + size).
   * Used by settings cache to auto-invalidate when the user changes models / thinking / auth files.
   */
  sourceFingerprint?: string;
}

const CODEX_REASONING = ["low", "medium", "high", "xhigh", "max"];
const GROK_REASONING = ["low", "medium", "high"];
const KIMI_REASONING = ["low", "medium", "high", "xhigh"];
const CLAUDE_REASONING = ["low", "medium", "high"];

/** Known config / auth paths that should trigger inventory refresh when they change. */
export function watchedCliConfigPaths(home = homedir()): string[] {
  return [
    path.join(home, ".codex", "config.toml"),
    path.join(home, ".codex", "auth.json"),
    path.join(home, ".grok", "config.toml"),
    path.join(home, ".kimi-code", "config.toml"),
    path.join(home, ".claude", "settings.json"),
  ];
}

/**
 * Build a cheap fingerprint from watched config files.
 * Does not read file contents (no secrets); only path + mtimeMs + size, or "missing".
 */
export async function inventorySourceFingerprint(home = homedir()): Promise<string> {
  const parts: string[] = [];
  for (const filePath of watchedCliConfigPaths(home)) {
    try {
      const info = await stat(filePath);
      parts.push(`${filePath}:${Math.trunc(info.mtimeMs)}:${info.size}`);
    } catch {
      parts.push(`${filePath}:missing`);
    }
  }
  return parts.join("|");
}

export async function scanCliInventory(home = homedir()): Promise<CliInventory> {
  const [clis, sourceFingerprint] = await Promise.all([
    Promise.all([
      probeCodex(home),
      probeGrok(home),
      probeKimi(home),
      probeClaude(home),
    ]),
    inventorySourceFingerprint(home),
  ]);
  return {
    scannedAt: new Date().toISOString(),
    home,
    clis,
    sourceFingerprint,
  };
}

/** Everything Codex reports from ~/.codex, plus the auth verdict. */
async function codexFiles(input: {
  configPath: string;
  authPath: string;
  installed: boolean;
}): Promise<{
  configPaths: string[];
  defaultModel: string | undefined;
  defaultReasoning: string | undefined;
  models: CliModelInfo[];
  providers: CliProviderInfo[];
  auth: CliAuthInfo;
}> {
  const hasConfigFile = await exists(input.configPath);
  const parsed = hasConfigFile
    ? codexConfig(await readFile(input.configPath, "utf8"))
    : { defaultModel: undefined, defaultReasoning: undefined, models: [], providers: [] };
  const hasAuthFile = await exists(input.authPath);
  return {
    configPaths: [hasConfigFile ? input.configPath : "", hasAuthFile ? input.authPath : ""].filter(Boolean),
    defaultModel: parsed.defaultModel,
    defaultReasoning: parsed.defaultReasoning,
    models: parsed.models,
    providers: parsed.providers,
    auth: codexAuthStatus({ hasAuthFile, hasConfigFile, installed: input.installed }),
  };
}

/** The models Codex offers as suggestions even when unconfigured. */
const CODEX_SUGGESTED_MODELS = ["gpt-5.6-sol", "gpt-5.5", "o3", "o4-mini"];

/** Read ~/.codex/config.toml into the inventory fields it controls. */
export function codexConfig(text: string): {
  defaultModel: string | undefined;
  defaultReasoning: string | undefined;
  models: CliModelInfo[];
  providers: CliProviderInfo[];
} {
  const defaultModel = matchTomlString(text, "model") ?? undefined;
  const providers = matchTomlTables(text, "model_providers").map((block) => ({
    id: block.id,
    ...(block.fields.base_url ? { baseUrl: block.fields.base_url } : {}),
    ...(block.fields.wire_api ? { wireApi: block.fields.wire_api } : {}),
  }));
  const models: CliModelInfo[] = [];
  if (defaultModel) {
    models.push({ id: defaultModel, label: defaultModel, reasoningOptions: [...CODEX_REASONING] });
  }
  for (const id of CODEX_SUGGESTED_MODELS) {
    if (!models.some((entry) => entry.id === id)) {
      models.push({ id, label: id, reasoningOptions: [...CODEX_REASONING] });
    }
  }
  return {
    defaultModel,
    defaultReasoning: matchTomlString(text, "model_reasoning_effort") ?? undefined,
    models,
    providers,
  };
}

/** Codex is authenticated by auth.json; without it the detail says why. */
function codexAuthStatus(input: {
  hasAuthFile: boolean;
  hasConfigFile: boolean;
  installed: boolean;
}): CliAuthInfo {
  if (input.hasAuthFile) return { status: "present", detail: "auth.json 存在" };
  if (input.hasConfigFile) return { status: "missing", detail: "未找到 auth.json，可能未登录" };
  return {
    status: "missing",
    detail: input.installed ? "未找到 ~/.codex/config.toml" : "未安装 codex",
  };
}

const GROK_DEFAULT_MODEL: CliModelInfo = {
  id: "grok-4.6",
  label: "Grok 4.6",
  reasoningOptions: [...GROK_REASONING],
};

/** Grok names its default in any of four places; a bare `grok` means 4.6. */
export function grokDefaultModel(text: string): string | undefined {
  const found =
    matchTomlString(text, "default", "models")
    ?? matchTomlString(text, "model", 'model."grok-4.6"')
    ?? matchTomlString(text, "model", "model.grok-4.6")
    ?? matchTomlString(text, "model", "model.grok")
    ?? undefined;
  return found === "grok" ? "grok-4.6" : found;
}

export function grokModels(text: string): CliModelInfo[] {
  const models = matchTomlTables(text, "model").map((block) => ({
    id: block.id,
    label: block.fields.name ?? block.fields.model ?? block.id,
    reasoningOptions: [...GROK_REASONING],
  }));
  return models.length > 0 ? models : [GROK_DEFAULT_MODEL];
}

/** A config that names an api_key is authenticated; the value is never read. */
export function apiKeyAuth(text: string): CliAuthInfo {
  return /api_key\s*=\s*["']?[^"'\s]+/i.test(text)
    ? { status: "present", detail: "config.toml 中已配置 api_key（未读取内容）" }
    : { status: "missing", detail: "config.toml 存在但未发现 api_key" };
}

/** Without a config file, the detail depends on whether the CLI is installed. */
export function missingConfigAuth(
  binary: string | undefined,
  cli: string,
  configLabel: string,
): CliAuthInfo {
  return {
    status: "missing",
    detail: binary ? `未找到 ${configLabel}` : `未安装 ${cli}`,
  };
}

/** Read ~/.kimi-code/config.toml into the inventory fields it controls. */
export function kimiConfig(text: string): {
  defaultModel: string | undefined;
  defaultReasoning: string | undefined;
  auth: CliAuthInfo;
  models: CliModelInfo[];
} {
  const hasProviderKey = /\[providers\.[^\]]+\][\s\S]*?api_key\s*=/i.test(text);
  return {
    defaultModel: matchTomlString(text, "default_model") ?? undefined,
    defaultReasoning: matchTomlString(text, "effort", "thinking") ?? undefined,
    auth: hasProviderKey
      ? { status: "present", detail: "providers 中已配置 api_key（未读取内容）" }
      : { status: "missing", detail: "config.toml 存在但未发现 provider api_key" },
    models: matchTomlTables(text, "models").map((block) => ({
      id: block.id,
      label: block.fields.display_name ?? block.fields.model ?? block.id,
      ...(block.fields.provider ? { provider: block.fields.provider } : {}),
      reasoningOptions: [...KIMI_REASONING],
    })),
  };
}

/** Read ~/.claude/settings.json; a broken file still reports as unknown. */
export function claudeSettings(text: string): {
  defaultModel: string | undefined;
  auth: CliAuthInfo;
  models: CliModelInfo[];
} {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return {
      defaultModel: typeof raw.model === "string" ? raw.model : undefined,
      auth: { status: "present", detail: "settings.json 存在" },
      models: claudeModels(raw),
    };
  } catch {
    return { defaultModel: undefined, auth: { status: "unknown", detail: "settings.json 无法解析" }, models: [] };
  }
}

function claudeModels(raw: Record<string, unknown>): CliModelInfo[] {
  const models: CliModelInfo[] = [];
  if (typeof raw.model === "string") {
    models.push({ id: raw.model, label: raw.model, reasoningOptions: [...CLAUDE_REASONING] });
  }
  for (const id of declaredModelIds(raw.availableModels)) {
    if (!models.some((entry) => entry.id === id)) {
      models.push({ id, label: id, reasoningOptions: [...CLAUDE_REASONING] });
    }
  }
  return models;
}

/** availableModels holds either strings or `{ id }` objects. */
function declaredModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item) return String((item as { id: unknown }).id);
      return undefined;
    })
    .filter((id): id is string => Boolean(id));
}

async function probeCodex(home: string): Promise<CliProbeResult> {
  const binary = await whichBinary(["codex"]);
  const version = binary ? await tryVersion(binary, ["--version"]) : undefined;
  const files = await codexFiles({
    configPath: path.join(home, ".codex", "config.toml"),
    authPath: path.join(home, ".codex", "auth.json"),
    installed: Boolean(binary),
  });
  return cliResult({
    id: "codex",
    binary,
    version,
    auth: files.auth,
    configPaths: files.configPaths,
    models: files.models,
    extra: {
      ...(files.defaultModel ? { defaultModel: files.defaultModel } : {}),
      ...(files.defaultReasoning ? { defaultReasoning: files.defaultReasoning } : {}),
      ...(files.providers.length > 0 ? { providers: files.providers } : {}),
    },
  });
}

/** The shape every probe returns: binary, version and the probed files. */
export function cliResult(input: {
  id: string;
  binary: string | undefined;
  version: string | undefined;
  auth: CliAuthInfo;
  configPaths: string[];
  models: CliModelInfo[];
  extra?: Record<string, unknown>;
}): CliProbeResult {
  return {
    id: input.id,
    ...(input.binary ? { binary: input.binary } : {}),
    installed: Boolean(input.binary),
    ...(input.version ? { version: input.version } : {}),
    auth: input.auth,
    configPaths: input.configPaths,
    models: input.models,
    ...(input.extra ?? {}),
    runtimeSupported: true,
  } as CliProbeResult;
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
    defaultModel = grokDefaultModel(text);
    auth = apiKeyAuth(text);
    models.push(...grokModels(text));
  } else {
    auth = missingConfigAuth(binary, "grok", "~/.grok/config.toml");
    models.push(GROK_DEFAULT_MODEL);
  }

  return {
    id: "grok",
    ...(binary ? { binary } : {}),
    installed: Boolean(binary),
    ...(version ? { version } : {}),
    auth,
    configPaths,
    models,
    ...(defaultModel ? { defaultModel } : { defaultModel: "grok-4.6" }),
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
    const parsed = kimiConfig(await readFile(configPath, "utf8"));
    defaultModel = parsed.defaultModel;
    defaultReasoning = parsed.defaultReasoning;
    auth = parsed.auth;
    models.push(...parsed.models);
  } else {
    auth = missingConfigAuth(binary, "kimi", "~/.kimi-code/config.toml");
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
    const parsed = claudeSettings(await readFile(settingsPath, "utf8"));
    defaultModel = parsed.defaultModel;
    auth = parsed.auth;
    models.push(...parsed.models);
  } else {
    auth = missingConfigAuth(binary, "claude", "~/.claude/settings.json");
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
    const found = await whichOne(name);
    if (found) return found;
  }
  return undefined;
}

/** One `which`/`where` lookup; a failure just means "not this name". */
export async function whichOne(name: string): Promise<string | undefined> {
  try {
    const result = await runProcess({
      command: process.platform === "win32" ? "where" : "which",
      args: [name],
      cwd: homedir(),
      timeoutMs: 3_000,
    });
    const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
    return result.exitCode === 0 && line ? line.trim() : undefined;
  } catch {
    return undefined;
  }
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

export function matchTomlString(text: string, key: string, section?: string): string | null {
  const scoped = section ? sectionBody(text, section) : text;
  return stringValue(scoped, key);
}

/** The body of one `[section]`, or empty when the section is absent. */
function sectionBody(text: string, section: string): string {
  const sectionRe = new RegExp(`\\[${escapeRegExp(section)}\\]([^\\[]*)`, "i");
  return text.match(sectionRe)?.[1] ?? "";
}

/** A key's value, quoted or bare, on any line of the text. */
function stringValue(text: string, key: string): string | null {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, "mi");
  const match = text.match(re);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function matchTomlTables(
  text: string,
  prefix: string,
): Array<{ id: string; fields: Record<string, string> }> {
  return parseTableBlocks(text, prefix);
}

function parseTableBlocks(
  text: string,
  prefix: string,
): Array<{ id: string; fields: Record<string, string> }> {
  return tableSections(text, prefix).map((section) => ({
    id: section.id,
    fields: sectionFields(section.body),
  }));
}

function tableSections(text: string, prefix: string): Array<{ id: string; body: string }> {
  const re = new RegExp(
    `\\[${escapeRegExp(prefix)}\\.("([^"]+)"|([A-Za-z0-9_.-]+))\\]([^\\[]*)`,
    "gi",
  );
  return [...text.matchAll(re)].map((match) => ({
    id: match[2] ?? match[3] ?? "",
    body: match[4] ?? "",
  }));
}

/** Never surface credentials: a field whose name names one is dropped. */
const SECRET_FIELD = /key|token|secret|password/i;

function sectionFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]+))/);
    const name = match?.[1];
    if (!name || SECRET_FIELD.test(name)) continue;
    fields[name] = (match![2] ?? match![3] ?? match![4] ?? "").trim();
  }
  return fields;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
