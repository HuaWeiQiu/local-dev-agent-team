import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { computeCandidateDigest, type EvolutionProposal } from "../src/evolution/domain.js";
import { DurableEvolutionCatalog } from "../src/evolution/persistence.js";
import { runProcess } from "../src/process/run.js";
import { startControlService, type RunningControlService } from "../src/server/start.js";
import { StrategyBlueprintCatalog } from "../src/strategies/catalog.js";
import { loadWorkspace } from "../src/workspace/load.js";
import {
  startWorkspaceControlService,
  type RunningWorkspaceService,
} from "../src/workspace/service.js";

const sessionToken = "e".repeat(64);
const strategyDefinition = {
  topology: { mode: "sequential" as const },
  maxParallel: 1,
  maxReworkAttempts: 2,
  roleProfiles: {},
  approvalGates: ["final" as const],
};

type EvolutionSnapshot = {
  catalogRevision: number;
  applicationRevision: number;
  recoveryRequired: boolean;
  promptRoles: Array<{ role: string; path: string }>;
  proposals: Array<{
    id: string;
    status: string;
    policy: unknown;
    candidate: unknown;
    evaluation?: unknown;
  }>;
};

type ProposalResponse = {
  proposal: EvolutionSnapshot["proposals"][number];
  committedRevision: number;
  deduplicated: boolean;
};

const roots: string[] = [];
const services: Array<RunningControlService | RunningWorkspaceService> = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(async (service) => await service.close()));
  await Promise.allSettled(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("evolution HTTP control surface", () => {
  it("requires a local session and exact Origin, then exposes an empty snapshot", async () => {
    const service = await startFixtureService("security");

    const unauthenticatedGet = await fetch(`${service.url}/api/evolution`);
    expect(unauthenticatedGet.status).toBe(401);

    const unauthenticatedMutation = await fetch(`${service.url}/api/evolution/proposals/strategy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "evolution-no-session",
        origin: service.url,
      },
      body: JSON.stringify({ name: "candidate", definition: strategyDefinition }),
    });
    expect(unauthenticatedMutation.status).toBe(401);

    const cookie = await bootstrapSession(service.url);
    const snapshotResponse = await fetch(`${service.url}/api/evolution`, {
      headers: { cookie },
    });
    expect(snapshotResponse.status).toBe(200);
    await expect(expectJson<EvolutionSnapshot>(snapshotResponse)).resolves.toMatchObject({
      catalogRevision: 0,
      applicationRevision: 0,
      recoveryRequired: false,
      promptRoles: [{ role: "worker", path: "prompts/worker.md" }],
      proposals: [],
    });

    const missingOrigin = await fetch(`${service.url}/api/evolution/proposals/strategy`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": "evolution-no-origin",
      },
      body: JSON.stringify({ name: "candidate", definition: strategyDefinition }),
    });
    expect(missingOrigin.status).toBe(403);
    await expect(expectJson<{ code: string }>(missingOrigin)).resolves.toMatchObject({
      code: "ORIGIN_DENIED",
    });
  });

  it("binds strategy proposals to a server ID and policy and enforces idempotency", async () => {
    const service = await startFixtureService("idempotency");
    const cookie = await bootstrapSession(service.url);
    const idempotencyKey = "strategy-proposal-v1";
    const request = {
      name: "candidate",
      definition: strategyDefinition,
    };

    const created = await postStrategy(service.url, cookie, idempotencyKey, request);
    expect(created.status).toBe(201);
    const createdBody = await expectJson<ProposalResponse>(created);
    const expectedId = `evo-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 48)}`;
    expect(createdBody).toMatchObject({
      committedRevision: 1,
      deduplicated: false,
      proposal: {
        id: expectedId,
        status: "proposed",
        policy: {
          version: 1,
          capabilities: {
            automaticExecution: false,
            automaticPromotion: false,
            networkPublication: false,
            secretStorage: false,
          },
          allowedPromptPaths: [],
        },
        candidate: {
          kind: "strategy-blueprint",
          name: "candidate",
          definition: strategyDefinition,
        },
      },
    });

    const replay = await postStrategy(service.url, cookie, idempotencyKey, request);
    expect(replay.status).toBe(200);
    await expect(expectJson<ProposalResponse>(replay)).resolves.toMatchObject({
      proposal: { id: expectedId },
      committedRevision: 1,
      deduplicated: true,
    });

    const conflict = await postStrategy(service.url, cookie, idempotencyKey, {
      ...request,
      name: "different-candidate",
    });
    expect(conflict.status).toBe(409);
    await expect(expectJson<{ code: string }>(conflict)).resolves.toMatchObject({
      code: "COMMAND_CONFLICT",
    });

    const rejectedRunInjection = await postEvolutionAction(
      service.url,
      cookie,
      expectedId,
      "evaluate",
      { runIds: ["unrelated-green-run"] },
    );
    expect(rejectedRunInjection.status).toBe(400);
    await expect(expectJson<{ code: string }>(rejectedRunInjection)).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const evaluated = await postEvolutionAction(
      service.url,
      cookie,
      expectedId,
      "evaluate",
      {},
    );
    expect(evaluated.status).toBe(200);
    await expect(expectJson<{ proposal: EvolutionSnapshot["proposals"][number] }>(evaluated))
      .resolves.toMatchObject({
        proposal: {
          id: expectedId,
          status: "evaluated",
          evaluation: {
            result: { passed: true },
            evidence: {
              items: [
                { id: "server-candidate-trust-v1", status: "pass" },
                { id: "server-strategy-preflight-v1", status: "pass" },
              ],
            },
          },
        },
      });

    const promotionPreviewResponse = await postEvolutionAction(
      service.url,
      cookie,
      expectedId,
      "promote/preview",
      { expectedRevision: 3 },
    );
    expect(promotionPreviewResponse.status).toBe(200);
    const promotionPreview = await expectJson<{
      evidenceScope: string;
      preview: { token: string; catalogRevision: number };
    }>(promotionPreviewResponse);
    expect(promotionPreview).toMatchObject({
      evidenceScope: "server-structural-preflight-not-candidate-execution",
      preview: { catalogRevision: 3 },
    });
    const confirmBody = {
      expectedRevision: promotionPreview.preview.catalogRevision,
      token: promotionPreview.preview.token,
      reason: "Apply the exact reviewed strategy candidate",
    };
    const confirms = await Promise.all([
      postEvolutionAction(
        service.url,
        cookie,
        expectedId,
        "promote/confirm",
        confirmBody,
        "promote-candidate-v1",
      ),
      postEvolutionAction(
        service.url,
        cookie,
        expectedId,
        "promote/confirm",
        confirmBody,
        "promote-candidate-v1",
      ),
    ]);
    expect(confirms.map((response) => response.status)).toEqual([200, 200]);
    const confirmResults = await Promise.all(
      confirms.map(async (response) => await expectJson<{ deduplicated: boolean }>(response)),
    );
    expect(confirmResults.map((result) => result.deduplicated).sort()).toEqual([false, true]);

    const removedBeginRoute = await postEvolutionAction(
      service.url,
      cookie,
      expectedId,
      "begin-evaluation",
      {},
    );
    expect(removedBeginRoute.status).toBe(404);

    const snapshot = await fetch(`${service.url}/api/evolution`, { headers: { cookie } });
    expect(snapshot.status).toBe(200);
    await expect(expectJson<EvolutionSnapshot>(snapshot)).resolves.toMatchObject({
      catalogRevision: 4,
      proposals: [{ id: expectedId, status: "promoted" }],
    });
  });

  it("rejects caller-supplied identity and policy fields without creating a proposal", async () => {
    const service = await startFixtureService("strict-request");
    const cookie = await bootstrapSession(service.url);
    const response = await postStrategy(service.url, cookie, "strict-injection", {
      name: "candidate",
      definition: strategyDefinition,
      id: "caller-selected-id",
      policy: { allowedPromptPaths: ["README.md"] },
    });

    expect(response.status).toBe(400);
    await expect(expectJson<{ code: string }>(response)).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const snapshot = await fetch(`${service.url}/api/evolution`, { headers: { cookie } });
    await expect(expectJson<EvolutionSnapshot>(snapshot)).resolves.toMatchObject({
      catalogRevision: 0,
      proposals: [],
    });
  });

  it("validates prompt ingress and completes preview, apply, rollback, and reject", async () => {
    const root = await createTemporaryRoot("prompt-lifecycle");
    await createGitProject(root, "prompt-lifecycle");
    const service = await startControlService(await loadConfig(root), { port: 0, sessionToken });
    services.push(service);
    const cookie = await bootstrapSession(service.url);

    const malformed = await postPrompt(service.url, cookie, "prompt-malformed", {
      role: "worker",
      encoding: "base64",
      content: "not-canonical-base64",
    });
    expect(malformed.status).toBe(422);
    const invalidUtf8 = await postPrompt(service.url, cookie, "prompt-invalid-utf8", {
      role: "worker",
      encoding: "base64",
      content: "/w==",
    });
    expect(invalidUtf8.status).toBe(422);
    const oversized = await postPrompt(service.url, cookie, "prompt-too-large", {
      role: "worker",
      encoding: "base64",
      content: Buffer.alloc(256 * 1024 + 1, "a").toString("base64"),
    });
    expect(oversized.status).toBe(413);
    const unknownRole = await postPrompt(service.url, cookie, "prompt-unknown-role", {
      role: "unknown",
      encoding: "base64",
      content: Buffer.from("Valid UTF-8\n").toString("base64"),
    });
    expect(unknownRole.status).toBe(400);
    await expect(expectJson<{ code: string }>(unknownRole)).resolves.toMatchObject({
      code: "PROMPT_ROLE_NOT_FOUND",
    });

    const candidate = "A concise worker prompt managed by evolution.\n";
    const created = await postPrompt(service.url, cookie, "prompt-lifecycle-v1", {
      role: "worker",
      encoding: "base64",
      content: Buffer.from(candidate).toString("base64"),
    });
    expect(created.status).toBe(201);
    const proposal = (await expectJson<ProposalResponse>(created)).proposal;
    const evaluated = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "evaluate",
      {},
    );
    expect(evaluated.status).toBe(200);
    const promotePreviewResponse = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "promote/preview",
      { expectedRevision: 3 },
    );
    expect(promotePreviewResponse.status).toBe(200);
    expect(promotePreviewResponse.headers.get("cache-control")).toBe("no-store");
    const promotePreview = await expectJson<{
      preview: { token: string; catalogRevision: number };
      description: { before: { content: string }; after: { content: string } };
    }>(promotePreviewResponse);
    expect(promotePreview.description).toMatchObject({
      before: { content: "Original worker prompt\n" },
      after: { content: candidate },
    });
    const promoted = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "promote/confirm",
      {
        expectedRevision: promotePreview.preview.catalogRevision,
        token: promotePreview.preview.token,
        reason: "Apply the exact prompt shown in the preview",
      },
      "prompt-promote-command",
    );
    expect(promoted.status).toBe(200);
    await expect(readFile(path.join(root, "prompts", "worker.md"), "utf8")).resolves.toBe(candidate);

    const rollbackPreviewResponse = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "rollback/preview",
      { expectedRevision: 4 },
    );
    expect(rollbackPreviewResponse.status).toBe(200);
    const rollbackPreview = await expectJson<{
      preview: { token: string; catalogRevision: number };
      description: { before: { content: string }; after: { content: string } };
    }>(rollbackPreviewResponse);
    expect(rollbackPreview.description).toMatchObject({
      before: { content: candidate },
      after: { content: "Original worker prompt\n" },
    });
    const rolledBack = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "rollback/confirm",
      {
        expectedRevision: rollbackPreview.preview.catalogRevision,
        token: rollbackPreview.preview.token,
        reason: "Restore the exact original prompt shown in the preview",
      },
      "prompt-rollback-command",
    );
    expect(rolledBack.status).toBe(200);
    await expect(readFile(path.join(root, "prompts", "worker.md"), "utf8"))
      .resolves.toBe("Original worker prompt\n");

    const rejectable = await postStrategy(
      service.url,
      cookie,
      "rejectable-strategy",
      { name: "rejectable-strategy", definition: strategyDefinition },
    );
    const rejectableId = (await expectJson<ProposalResponse>(rejectable)).proposal.id;
    expect((await postEvolutionAction(
      service.url,
      cookie,
      rejectableId,
      "evaluate",
      {},
    )).status).toBe(200);
    const rejected = await postEvolutionAction(
      service.url,
      cookie,
      rejectableId,
      "reject",
      { reason: "Do not ship this reviewed candidate" },
    );
    expect(rejected.status).toBe(200);
    await expect(expectJson<{ proposal: { status: string } }>(rejected)).resolves.toMatchObject({
      proposal: { status: "rejected" },
    });
  });

  it("keeps evolution proposals scoped to their workspace project", async () => {
    const workspaceRoot = await createTemporaryRoot("workspace");
    await createGitProject(path.join(workspaceRoot, "alpha"), "alpha");
    await createGitProject(path.join(workspaceRoot, "beta"), "beta");
    await writeFile(
      path.join(workspaceRoot, "agent-team.workspace.yaml"),
      stringifyYaml({
        version: 1,
        projects: [
          { id: "alpha", config: "./alpha/agent-team.yaml" },
          { id: "beta", config: "./beta/agent-team.yaml" },
        ],
      }),
      "utf8",
    );
    const workspace = await loadWorkspace(workspaceRoot);
    const service = await startWorkspaceControlService(workspace, {
      port: 0,
      sessionToken,
    });
    services.push(service);
    const cookie = await bootstrapSession(service.url);

    const created = await postStrategy(
      `${service.url}/api/projects/alpha`,
      cookie,
      "workspace-alpha-proposal",
      { name: "alpha-candidate", definition: strategyDefinition },
      "",
    );
    expect(created.status).toBe(201);

    const [alpha, beta] = await Promise.all([
      fetch(`${service.url}/api/projects/alpha/evolution`, { headers: { cookie } }),
      fetch(`${service.url}/api/projects/beta/evolution`, { headers: { cookie } }),
    ]);
    await expect(expectJson<EvolutionSnapshot>(alpha)).resolves.toMatchObject({
      catalogRevision: 1,
      proposals: [{ candidate: { name: "alpha-candidate" } }],
    });
    await expect(expectJson<EvolutionSnapshot>(beta)).resolves.toMatchObject({
      catalogRevision: 0,
      proposals: [],
    });
  });

  it("drains in-flight evolution operations and seals retained service references", async () => {
    const service = await startFixtureService("shutdown-drain");
    const coordinator = service.evolution.coordinator;
    const originalRead = coordinator.readControlSnapshot.bind(coordinator);
    let signalReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    coordinator.readControlSnapshot = async () => {
      signalReadStarted();
      await readReleased;
      return await originalRead();
    };

    const snapshot = service.evolution.snapshot();
    await readStarted;
    let closeFinished = false;
    const close = service.evolution.close().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);

    releaseRead();
    await expect(snapshot).resolves.toMatchObject({ catalogRevision: 0 });
    await close;
    expect(closeFinished).toBe(true);
    await expect(service.evolution.snapshot()).rejects.toMatchObject({
      code: "SERVICE_CLOSED",
    });
  });

  it("returns a stable conflict code for runs blocked by a target mutation", async () => {
    const service = await startFixtureService("run-mutation-conflict");
    const cookie = await bootstrapSession(service.url);
    const release = service.supervisor.beginEvolutionMutation();
    try {
      const start = await fetch(`${service.url}/api/runs`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Must wait", profileOverrides: {} }),
      });
      expect(start.status).toBe(409);
      await expect(expectJson<{ code: string }>(start)).resolves.toMatchObject({
        code: "ACTIVE_RUN_CONFLICT",
      });

      const retry = await fetch(`${service.url}/api/runs/missing/actions/retry`, {
        method: "POST",
        headers: { cookie },
      });
      expect(retry.status).toBe(409);
      await expect(expectJson<{ code: string }>(retry)).resolves.toMatchObject({
        code: "ACTIVE_RUN_CONFLICT",
      });
    } finally {
      release();
    }
  });

  it("rejects legacy external evaluations at the server-owned preflight boundary", async () => {
    const root = await createTemporaryRoot("legacy-evaluation-source");
    await createGitProject(root, "legacy-evaluation-source");
    const loaded = await loadConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const proposal = await createExternalEvaluatedProposal(catalog, "legacy-evaluated");
    expect(proposal.evaluation?.source).toBe("external");

    const service = await startControlService(loaded, { port: 0, sessionToken });
    services.push(service);
    const cookie = await bootstrapSession(service.url);
    const evaluate = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "evaluate",
      {},
    );
    expect(evaluate.status).toBe(409);
    await expect(expectJson<{ code: string }>(evaluate)).resolves.toMatchObject({
      code: "EVALUATION_SOURCE_UNTRUSTED",
    });

    const preview = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "promote/preview",
      { expectedRevision: catalog.revision },
    );
    expect(preview.status).toBe(409);
    await expect(expectJson<{ code: string }>(preview)).resolves.toMatchObject({
      code: "EVALUATION_SOURCE_UNTRUSTED",
    });
  });

  it("recovers an upgraded promoted strategy through the protected reconcile API", async () => {
    const root = await createTemporaryRoot("legacy-reconcile");
    await createGitProject(root, "legacy-reconcile");
    const loaded = await loadConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const proposal = await createExternalEvaluatedProposal(catalog, "legacy-promoted");
    const evidence = proposal.evaluation!.evidence;
    await catalog.promote(proposal.id, evidence, {
      actor: "legacy-operator",
      reason: "Legacy promotion before application proofs existed",
      decidedAt: "2026-08-11T01:03:00.000Z",
    });
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    await strategies.save("legacy-promoted", strategyDefinition);

    const service = await startControlService(loaded, { port: 0, sessionToken });
    services.push(service);
    const cookie = await bootstrapSession(service.url);
    const body = {
      expectedRevision: catalog.revision,
      reason: "Adopt the exact live target after reviewing the legacy promotion",
    };
    const browserApply = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "reconcile",
      { ...body, mode: "apply", promptMaterial: { encoding: "base64", content: "" } },
      "legacy-browser-apply",
    );
    expect(browserApply.status).toBe(400);
    await expect(expectJson<{ code: string }>(browserApply)).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const reconciled = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "reconcile",
      body,
      "legacy-reconcile-command",
    );
    expect(reconciled.status).toBe(200);
    await expect(expectJson<{ applicationStatus: string; deduplicated: boolean }>(reconciled))
      .resolves.toMatchObject({ applicationStatus: "adopted", deduplicated: false });

    const replay = await postEvolutionAction(
      service.url,
      cookie,
      proposal.id,
      "reconcile",
      body,
      "legacy-reconcile-command",
    );
    expect(replay.status).toBe(200);
    await expect(expectJson<{ deduplicated: boolean }>(replay)).resolves.toMatchObject({
      deduplicated: true,
    });
  });
});

async function createExternalEvaluatedProposal(
  catalog: DurableEvolutionCatalog,
  id: string,
): Promise<EvolutionProposal> {
  await catalog.propose({
    id,
    createdAt: "2026-08-11T01:00:00.000Z",
    policy: {
      version: 1,
      capabilities: {
        automaticExecution: false,
        automaticPromotion: false,
        networkPublication: false,
        secretStorage: false,
      },
      allowedPromptPaths: [],
    },
    candidate: { kind: "strategy-blueprint", name: id, definition: strategyDefinition },
  });
  await catalog.beginEvaluation(id, "2026-08-11T01:01:00.000Z");
  const evaluating = catalog.getProposal(id);
  if (!evaluating) throw new Error(`Proposal '${id}' disappeared`);
  return (
    await catalog.evaluate(
      id,
      {
        proposalId: id,
        candidateDigest: computeCandidateDigest(evaluating.candidate),
        items: [
          {
            kind: "deterministic",
            id: "legacy-external-check",
            status: "pass",
            summary: "Legacy external evidence passed",
          },
        ],
      },
      "2026-08-11T01:02:00.000Z",
    )
  ).proposal;
}

async function startFixtureService(name: string): Promise<RunningControlService> {
  const root = await createTemporaryRoot(name);
  await createGitProject(root, name);
  const loaded = await loadConfig(root);
  const service = await startControlService(loaded, { port: 0, sessionToken });
  services.push(service);
  return service;
}

async function createTemporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agent-team-evolution-http-${name}-`));
  roots.push(root);
  return root;
}

async function createGitProject(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, "prompts"), { recursive: true });
  const config = createDefaultConfig(name);
  config.roles.worker!.promptFile = "prompts/worker.md";
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config), "utf8");
  await writeFile(path.join(root, "prompts", "worker.md"), "Original worker prompt\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n", "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Evolution HTTP Fixture"]);
  await git(root, ["add", "agent-team.yaml", "prompts/worker.md", ".gitignore"]);
  await git(root, ["commit", "-m", "initial fixture"]);
}

async function bootstrapSession(url: string): Promise<string> {
  const response = await fetch(`${url}/__agent_team/session?token=${sessionToken}`, {
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function postStrategy(
  apiBase: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
  apiPrefix = "/api",
): Promise<Response> {
  const origin = apiPrefix ? apiBase : new URL(apiBase).origin;
  return await fetch(`${apiBase}${apiPrefix}/evolution/proposals/strategy`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function postPrompt(
  apiBase: string,
  cookie: string,
  idempotencyKey: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${apiBase}/api/evolution/proposals/prompt`, {
    method: "POST",
    headers: {
      cookie,
      origin: new URL(apiBase).origin,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function postEvolutionAction(
  baseUrl: string,
  cookie: string,
  proposalId: string,
  action: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return await fetch(
    `${baseUrl}/api/evolution/proposals/${encodeURIComponent(proposalId)}/actions/${action}`,
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: new URL(baseUrl).origin,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function expectJson<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

async function git(root: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}
