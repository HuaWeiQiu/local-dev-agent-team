import type {
  ProjectScope,
  PublicConfig,
  EvidenceFilePreview,
  RunCleanupPreview,
  RunCleanupResult,
  RunEvidence,
  RunState,
  RunSummary,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
  WorkspaceInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  return await request<WorkspaceInfo>("/api/workspace");
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

export function eventStreamUrl(scope: ProjectScope, runId: string): string {
  return `${apiRoot(scope)}/events?runId=${encodeURIComponent(runId)}&after=0`;
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
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `请求失败 (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

function commandHeaders(): HeadersInit {
  return { "Idempotency-Key": crypto.randomUUID() };
}

function apiRoot(scope: ProjectScope): string {
  return scope.mode === "workspace"
    ? `/api/projects/${encodeURIComponent(scope.projectId)}`
    : "/api";
}
