import type {
  AutomaticEvolutionSnapshot,
  ExperienceEntry,
  ExperiencePlanningBundle,
  ExperienceSnapshot,
  ExperienceStatus,
  ProjectScope,
  PublicConfig,
  DesktopSettingsResponse,
  DesktopSettingsView,
  EvidenceFilePreview,
  EvolutionPreviewResponse,
  EvolutionProposal,
  EvolutionSnapshot,
  RoleBindingInput,
  RunCleanupPreview,
  RunCleanupResult,
  RunEvidence,
  RunState,
  RunSummary,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
  UsageReport,
  WorkspaceInfo,
  CliInventory,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | undefined = undefined,
  ) {
    super(message);
  }
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  return await request<WorkspaceInfo>("/api/workspace");
}

export async function getDesktopSettings(): Promise<DesktopSettingsResponse> {
  return await request<DesktopSettingsResponse>("/api/desktop/settings");
}

export async function scanCliInventory(): Promise<{
  inventory: CliInventory;
  fromCache: boolean;
  reason?: string;
}> {
  return await request<{ inventory: CliInventory; fromCache: boolean; reason?: string }>(
    "/api/desktop/cli-inventory/scan",
    { method: "POST", body: "{}" },
  );
}

/** Soft read: server auto-rescans when config mtime fingerprint changes. */
export async function getCliInventory(options: { refresh?: boolean } = {}): Promise<{
  inventory: CliInventory;
  fromCache: boolean;
  reason?: string;
}> {
  const query = options.refresh ? "?refresh=1" : "";
  return await request<{ inventory: CliInventory; fromCache: boolean; reason?: string }>(
    `/api/desktop/cli-inventory${query}`,
  );
}

export async function saveDesktopSettings(input: {
  defaults: { roles: Record<string, RoleBindingInput> };
  ui: DesktopSettingsView["ui"];
}): Promise<{ settings: unknown }> {
  return await request<{ settings: unknown }>("/api/desktop/settings", {
    method: "PUT",
    body: JSON.stringify({
      defaults: input.defaults,
      ui: {
        showCliPickerInRunLauncher: input.ui.showCliPickerInRunLauncher,
        autoDetectCliConfig: input.ui.autoDetectCliConfig ?? true,
        autoDetectOnFocus: input.ui.autoDetectOnFocus ?? true,
      },
    }),
  });
}

export async function getConfig(scope: ProjectScope): Promise<PublicConfig> {
  return await request<PublicConfig>(`${apiRoot(scope)}/config`);
}

export async function getRuns(scope: ProjectScope): Promise<RunSummary[]> {
  return (await request<{ runs: RunSummary[] }>(`${apiRoot(scope)}/runs`)).runs;
}

export async function getRun(scope: ProjectScope, runId: string): Promise<RunState> {
  return (
    await request<{ run: RunState }>(
      `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}`,
    )
  ).run;
}

export async function getRunEvidence(scope: ProjectScope, runId: string): Promise<RunEvidence> {
  return (
    await request<{ evidence: RunEvidence }>(
      `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/evidence`,
    )
  ).evidence;
}

export async function getEvidenceFile(
  scope: ProjectScope,
  runId: string,
  artifactPath: string,
): Promise<EvidenceFilePreview> {
  return (
    await request<{ file: EvidenceFilePreview }>(
      `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/evidence/file?path=${encodeURIComponent(artifactPath)}`,
    )
  ).file;
}

export async function previewRunCleanup(
  scope: ProjectScope,
  olderThanDays: number,
): Promise<RunCleanupPreview> {
  return await request<RunCleanupPreview>(`${apiRoot(scope)}/runs/cleanup/preview`, {
    method: "POST",
    body: JSON.stringify({ olderThanDays }),
  });
}

export async function cleanupRuns(
  scope: ProjectScope,
  token: string,
): Promise<RunCleanupResult> {
  return await request<RunCleanupResult>(`${apiRoot(scope)}/runs/cleanup`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function startRun(scope: ProjectScope, input: StartRunInput): Promise<string> {
  const response = await request<{ runId: string }>(`${apiRoot(scope)}/runs`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify(input),
  });
  return response.runId;
}

export async function preflightStrategyBlueprint(
  scope: ProjectScope,
  name: string,
  definition: StrategyBlueprintDefinition,
): Promise<StrategyBlueprintResult> {
  return await request<StrategyBlueprintResult>(`${apiRoot(scope)}/strategies/preflight`, {
    method: "POST",
    body: JSON.stringify({ name, definition }),
  });
}

export async function saveStrategyBlueprint(
  scope: ProjectScope,
  name: string,
  definition: StrategyBlueprintDefinition,
): Promise<StrategyBlueprintResult> {
  return await request<StrategyBlueprintResult>(
    `${apiRoot(scope)}/strategies/${encodeURIComponent(name)}`,
    { method: "PUT", body: JSON.stringify({ definition }) },
  );
}

export async function deleteStrategyBlueprint(
  scope: ProjectScope,
  name: string,
): Promise<void> {
  await request(`${apiRoot(scope)}/strategies/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function cancelRun(scope: ProjectScope, runId: string): Promise<void> {
  await request(`${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/actions/cancel`, {
    method: "POST",
  });
}

export async function retryRun(scope: ProjectScope, runId: string): Promise<string> {
  const response = await request<{ runId: string }>(
    `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/actions/retry`,
    { method: "POST", headers: commandHeaders() },
  );
  return response.runId;
}

export async function deleteRun(
  scope: ProjectScope,
  runId: string,
): Promise<RunCleanupResult> {
  return await request<RunCleanupResult>(
    `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/actions/delete`,
    { method: "POST" },
  );
}

export async function respondApproval(
  scope: ProjectScope,
  runId: string,
  input: {
    requestId: string;
    decision: "approved" | "rejected";
    actor: string;
    reason: string;
  },
): Promise<void> {
  await request(`${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/actions/respond-approval`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resumeRun(
  scope: ProjectScope,
  runId: string,
  input: { actor: string; reason: string },
): Promise<void> {
  await request(`${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/actions/resume`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * SSE 事件流地址。不带 after 参数：首次连接服务端从 0 重放；
 * EventSource 自动重连时浏览器会带 Last-Event-ID，服务端据此续传，
 * 避免每次重连都全量重放。runId 缺省时订阅项目级全量事件流。
 */
export function eventStreamUrl(scope: ProjectScope, runId?: string): string {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return `${apiRoot(scope)}/events${query}`;
}

export async function getUsage(scope: ProjectScope): Promise<UsageReport> {
  return await request<UsageReport>(`${apiRoot(scope)}/usage`);
}

export async function getEvolution(scope: ProjectScope): Promise<EvolutionSnapshot> {
  return await request<EvolutionSnapshot>(`${apiRoot(scope)}/evolution`, { cache: "no-store" });
}

export async function getExperience(
  scope: ProjectScope,
  status?: ExperienceStatus,
): Promise<ExperienceSnapshot> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await request<ExperienceSnapshot>(`${apiRoot(scope)}/experience${query}`, {
    cache: "no-store",
  });
}

export async function retrieveExperience(
  scope: ProjectScope,
  query = "",
  options: { preview?: boolean } = {},
): Promise<ExperiencePlanningBundle> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  // preview 只读预览：不计 hitCount、不写审计
  if (options.preview) params.set("preview", "1");
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return await request<ExperiencePlanningBundle>(`${apiRoot(scope)}/experience/retrieve${suffix}`, {
    cache: "no-store",
  });
}

export async function promoteExperience(
  scope: ProjectScope,
  experienceId: string,
  reason: string,
  options: {
    actor?: string;
    suiteDigest?: string;
    forceWithoutSuite?: boolean;
  } = {},
): Promise<ExperienceEntry> {
  return await request<ExperienceEntry>(
    `${apiRoot(scope)}/experience/${encodeURIComponent(experienceId)}/actions/promote`,
    {
      method: "POST",
      body: JSON.stringify({
        reason,
        ...(options.actor ? { actor: options.actor } : {}),
        ...(options.suiteDigest ? { suiteDigest: options.suiteDigest } : {}),
        ...(options.forceWithoutSuite ? { forceWithoutSuite: true } : {}),
      }),
    },
  );
}

export async function rejectExperience(
  scope: ProjectScope,
  experienceId: string,
  reason: string,
  actor?: string,
): Promise<ExperienceEntry> {
  return await request<ExperienceEntry>(
    `${apiRoot(scope)}/experience/${encodeURIComponent(experienceId)}/actions/reject`,
    {
      method: "POST",
      body: JSON.stringify({ reason, ...(actor ? { actor } : {}) }),
    },
  );
}

export async function retireExperience(
  scope: ProjectScope,
  experienceId: string,
  reason: string,
  actor?: string,
): Promise<ExperienceEntry> {
  return await request<ExperienceEntry>(
    `${apiRoot(scope)}/experience/${encodeURIComponent(experienceId)}/actions/retire`,
    {
      method: "POST",
      body: JSON.stringify({ reason, ...(actor ? { actor } : {}) }),
    },
  );
}

export async function shareExperience(
  scope: ProjectScope,
  experienceId: string,
  reason: string,
  actor?: string,
): Promise<ExperienceEntry> {
  return await request<ExperienceEntry>(
    `${apiRoot(scope)}/experience/${encodeURIComponent(experienceId)}/actions/share`,
    {
      method: "POST",
      body: JSON.stringify({ reason, ...(actor ? { actor } : {}) }),
    },
  );
}

export async function startAutomaticEvolution(
  scope: ProjectScope,
  maxCycles: number,
  commandId: string,
): Promise<AutomaticEvolutionSnapshot> {
  return await request<AutomaticEvolutionSnapshot>(`${apiRoot(scope)}/evolution/automation/start`, {
    method: "POST",
    cache: "no-store",
    headers: commandHeaders(commandId),
    body: JSON.stringify({ maxCycles }),
  });
}

export async function stopAutomaticEvolution(
  scope: ProjectScope,
): Promise<AutomaticEvolutionSnapshot> {
  return await request<AutomaticEvolutionSnapshot>(`${apiRoot(scope)}/evolution/automation/stop`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({}),
  });
}

export async function proposeEvolutionStrategy(
  scope: ProjectScope,
  input: { name: string; definition: StrategyBlueprintDefinition },
  commandId: string,
): Promise<{ proposal: EvolutionProposal }> {
  return await request<{ proposal: EvolutionProposal }>(`${apiRoot(scope)}/evolution/proposals/strategy`, {
    method: "POST",
    cache: "no-store",
    headers: commandHeaders(commandId),
    body: JSON.stringify(input),
  });
}

export async function proposeEvolutionPrompt(
  scope: ProjectScope,
  input: { role: string; encoding: "base64"; content: string },
  commandId: string,
): Promise<{ proposal: EvolutionProposal }> {
  return await request<{ proposal: EvolutionProposal }>(`${apiRoot(scope)}/evolution/proposals/prompt`, {
    method: "POST",
    cache: "no-store",
    headers: commandHeaders(commandId),
    body: JSON.stringify(input),
  });
}

export async function evaluateEvolutionProposal(
  scope: ProjectScope,
  proposalId: string,
): Promise<void> {
  await evolutionAction(scope, proposalId, "evaluate", {});
}

export async function rejectEvolutionProposal(
  scope: ProjectScope,
  proposalId: string,
  reason: string,
): Promise<void> {
  await evolutionAction(scope, proposalId, "reject", { reason });
}

export async function previewEvolutionPromotion(
  scope: ProjectScope,
  proposalId: string,
  expectedRevision: number,
): Promise<EvolutionPreviewResponse> {
  return await evolutionAction<EvolutionPreviewResponse>(
    scope,
    proposalId,
    "promote/preview",
    { expectedRevision },
  );
}

export async function confirmEvolutionPromotion(
  scope: ProjectScope,
  proposalId: string,
  input: { expectedRevision: number; token: string; reason: string },
  commandId: string,
): Promise<void> {
  await evolutionAction(scope, proposalId, "promote/confirm", input, commandId);
}

export async function previewEvolutionRollback(
  scope: ProjectScope,
  proposalId: string,
  expectedRevision: number,
): Promise<EvolutionPreviewResponse> {
  return await evolutionAction<EvolutionPreviewResponse>(
    scope,
    proposalId,
    "rollback/preview",
    { expectedRevision },
  );
}

export async function confirmEvolutionRollback(
  scope: ProjectScope,
  proposalId: string,
  input: { expectedRevision: number; token: string; reason: string },
  commandId: string,
): Promise<void> {
  await evolutionAction(scope, proposalId, "rollback/confirm", input, commandId);
}

export async function reconcileEvolutionProposal(
  scope: ProjectScope,
  proposalId: string,
  input: { expectedRevision: number; reason: string },
  commandId: string,
): Promise<void> {
  await evolutionAction(scope, proposalId, "reconcile", input, commandId);
}

export function runExportUrl(scope: ProjectScope, runId: string): string {
  return `${apiRoot(scope)}/runs/${encodeURIComponent(runId)}/export`;
}

/** 拉取某运行的 NDJSON 事件导出并触发浏览器下载（同源 fetch + blob，兼容 CSP）。 */
export async function downloadRunEvents(scope: ProjectScope, runId: string): Promise<void> {
  const response = await fetch(runExportUrl(scope, runId));
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      code?: unknown;
    };
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `请求失败 (${response.status})`,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${runId}.ndjson`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      code?: unknown;
    };
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `请求失败 (${response.status})`,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return (await response.json()) as T;
}

function commandHeaders(commandId: string = crypto.randomUUID()): HeadersInit {
  return { "Idempotency-Key": commandId };
}

async function evolutionAction<T = unknown>(
  scope: ProjectScope,
  proposalId: string,
  action: string,
  body: unknown,
  commandId?: string,
): Promise<T> {
  return await request<T>(
    `${apiRoot(scope)}/evolution/proposals/${encodeURIComponent(proposalId)}/actions/${action}`,
    {
      method: "POST",
      cache: "no-store",
      ...(commandId ? { headers: commandHeaders(commandId) } : {}),
      body: JSON.stringify(body),
    },
  );
}

function apiRoot(scope: ProjectScope): string {
  return scope.mode === "workspace"
    ? `/api/projects/${encodeURIComponent(scope.projectId)}`
    : "/api";
}
