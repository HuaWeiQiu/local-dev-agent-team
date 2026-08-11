import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open as openAsync,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import type { AgentTeamConfig } from "../src/config/schema.js";
import {
  computeCandidateDigest,
  type EvolutionProposal,
} from "../src/evolution/domain.js";
import {
  computePayloadDigest,
  DurableEvolutionCatalog,
  EVOLUTION_CATALOG_FILENAME,
  EVOLUTION_DURABLE_DOCUMENT_VERSION,
  EvolutionPersistenceConflictError,
  EvolutionPersistenceError,
  EvolutionPersistenceValidationError,
  type DurableEvolutionFileIo,
} from "../src/evolution/persistence.js";

const now = "2026-08-11T01:00:00.000Z";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withPromptFiles(config: AgentTeamConfig): AgentTeamConfig {
  return {
    ...config,
    roles: {
      ...config.roles,
      worker: {
        ...config.roles.worker,
        promptFile: "prompts/worker.md",
      },
      reviewer: {
        ...config.roles.reviewer!,
        promptFile: "prompts/reviewer.md",
      },
    },
  };
}

function createLoadedConfig(
  root: string,
  config: AgentTeamConfig = withPromptFiles(createDefaultConfig("evolution-persistence")),
): LoadedConfig {
  return {
    root,
    path: path.join(root, "agent-team.yaml"),
    config,
  };
}

function validPolicy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    capabilities: {
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    },
    allowedPromptPaths: ["prompts/worker.md", "prompts/reviewer.md"],
    ...overrides,
  };
}

function validStrategyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "strategy-blueprint",
    name: "serial-review",
    definition: {
      topology: { mode: "sequential" },
      maxParallel: 1,
      roleProfiles: {},
      approvalGates: ["final"],
    },
    ...overrides,
  };
}

function validPromptCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "role-prompt",
    path: "prompts/worker.md",
    contentDigest: "a".repeat(64),
    ...overrides,
  };
}

function humanDecision(overrides: Record<string, unknown> = {}) {
  return {
    actor: "operator",
    reason: "Promote after review",
    decidedAt: "2026-08-11T01:03:00.000Z",
    ...overrides,
  };
}

function boundEvidence(
  proposal: EvolutionProposal,
  items: Array<Record<string, unknown>> = [
    {
      kind: "deterministic",
      id: "unit-tests",
      status: "pass",
      summary: "Focused persistence tests passed",
    },
    {
      kind: "advisory",
      id: "reviewer",
      verdict: "approve",
      summary: "Approve after independent review",
    },
  ],
) {
  return {
    proposalId: proposal.id,
    candidateDigest: computeCandidateDigest(proposal.candidate),
    items,
  };
}

async function createTempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "agent-team-evolution-"));
}

async function openDurable(
  root: string,
  options: {
    config?: AgentTeamConfig;
    io?: Partial<DurableEvolutionFileIo>;
  } = {},
): Promise<DurableEvolutionCatalog> {
  return await DurableEvolutionCatalog.open(createLoadedConfig(root, options.config), {
    io: options.io,
  });
}

async function toEvaluated(
  durable: DurableEvolutionCatalog,
  proposalId: string,
  items?: Array<Record<string, unknown>>,
): Promise<EvolutionProposal> {
  const current = durable.getProposal(proposalId);
  if (!current) {
    throw new Error(`Proposal '${proposalId}' missing before evaluation`);
  }
  const createdMs = Date.parse(current.createdAt);
  const evaluatingAt = new Date(createdMs + 60_000).toISOString();
  const evaluatedAt = new Date(createdMs + 120_000).toISOString();
  await durable.beginEvaluation(proposalId, evaluatingAt);
  const evaluating = durable.getProposal(proposalId)!;
  return await durable.evaluate(proposalId, boundEvidence(evaluating, items), evaluatedAt);
}

function evolutionDir(root: string, stateDirectory = ".agent-team"): string {
  return path.join(root, stateDirectory, "evolution");
}

function catalogPath(root: string, stateDirectory = ".agent-team"): string {
  return path.join(evolutionDir(root, stateDirectory), EVOLUTION_CATALOG_FILENAME);
}

async function readCatalogDocument(root: string): Promise<Record<string, unknown>> {
  const text = await readFile(catalogPath(root), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function writeCatalogDocument(
  root: string,
  document: Record<string, unknown>,
): Promise<void> {
  if (document.payload && typeof document.payload === "object") {
    document.payloadDigest = computePayloadDigest(document.payload);
  }
  await writeFile(catalogPath(root), `${JSON.stringify(document)}\n`, "utf8");
}

function promotionRecordDigest(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortObjectKeys(record))).digest("hex");
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortObjectKeys(child)]),
    );
  }
  return value;
}

describe("DurableEvolutionCatalog open", () => {
  it("opens an empty durable catalog when the primary document is absent", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);

    expect(durable.revision).toBe(0);
    expect(durable.snapshot()).toMatchObject({
      version: 1,
      proposals: [],
      auditRecords: [],
      activeProposals: [],
    });
    const canonicalRoot = await realpath(root);
    expect(durable.evolutionDirectory).toBe(evolutionDir(canonicalRoot));
    expect(durable.filePath).toBe(catalogPath(canonicalRoot));

    // Empty open must not invent a primary document.
    await expect(stat(catalogPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe or non-repository-owned stateDirectory values", async () => {
    const root = await createTempRoot();
    const base = withPromptFiles(createDefaultConfig("evolution-persistence"));

    await expect(
      DurableEvolutionCatalog.open(
        createLoadedConfig(root, {
          ...base,
          project: { ...base.project, stateDirectory: "/tmp/escape" },
        }),
      ),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    await expect(
      DurableEvolutionCatalog.open(
        createLoadedConfig(root, {
          ...base,
          project: { ...base.project, stateDirectory: "../outside" },
        }),
      ),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    await expect(
      DurableEvolutionCatalog.open(
        createLoadedConfig(root, {
          ...base,
          project: { ...base.project, stateDirectory: "state/../other" },
        }),
      ),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("rejects an existing stateDirectory symlink even when it points inside or outside the repository", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await symlink(outside, path.join(root, ".agent-team"), "dir");

    await expect(openDurable(root)).rejects.toThrow(/symlink/i);

    await unlink(path.join(root, ".agent-team"));
    await mkdir(path.join(root, "real-state"));
    await symlink(path.join(root, "real-state"), path.join(root, ".agent-team"), "dir");
    await expect(openDurable(root)).rejects.toThrow(/symlink/i);
  });

  it("ignores or safely cleans orphan temporary files without treating a corrupt primary as empty", async () => {
    const root = await createTempRoot();
    const dir = evolutionDir(root);
    await mkdir(dir, { recursive: true });
    const orphan = path.join(dir, `${EVOLUTION_CATALOG_FILENAME}.1234.orphan.tmp`);
    await writeFile(orphan, "orphan", { flag: "wx", mode: 0o600 });
    await writeFile(catalogPath(root), "{not-json", "utf8");

    await expect(openDurable(root)).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    // Primary remains corrupt; open must not replace it with an empty catalog.
    const primary = await readFile(catalogPath(root), "utf8");
    expect(primary).toBe("{not-json");
  });
});

describe("DurableEvolutionCatalog lifecycle durability", () => {
  it("reopens proposed, evaluating, and evaluated intermediate states", async () => {
    const root = await createTempRoot();
    let durable = await openDurable(root);
    await durable.propose({
      id: "prop-intermediate",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });

    durable = await openDurable(root);
    expect(durable.getProposal("prop-intermediate")?.status).toBe("proposed");
    await durable.beginEvaluation("prop-intermediate", "2026-08-11T01:01:00.000Z");

    durable = await openDurable(root);
    expect(durable.getProposal("prop-intermediate")?.status).toBe("evaluating");
    const evaluating = durable.getProposal("prop-intermediate")!;
    await durable.evaluate(
      "prop-intermediate",
      boundEvidence(evaluating),
      "2026-08-11T01:02:00.000Z",
    );

    durable = await openDurable(root);
    expect(durable.getProposal("prop-intermediate")?.status).toBe("evaluated");
    expect(durable.revision).toBe(3);
  });

  it("persists every lifecycle operation and recovers active pointers across reopen", async () => {
    const root = await createTempRoot();
    const first = await openDurable(root);

    const proposed = await first.propose({
      id: "prop-a",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    expect(proposed.status).toBe("proposed");
    expect(first.revision).toBe(1);

    const evaluating = await first.beginEvaluation("prop-a", "2026-08-11T01:01:00.000Z");
    expect(evaluating.status).toBe("evaluating");
    expect(first.revision).toBe(2);

    const evaluated = await first.evaluate(
      "prop-a",
      boundEvidence(evaluating),
      "2026-08-11T01:02:00.000Z",
    );
    expect(evaluated.status).toBe("evaluated");
    expect(first.revision).toBe(3);

    const { proposal: promoted, record: promotion } = await first.promote(
      "prop-a",
      boundEvidence(evaluated),
      humanDecision(),
    );
    expect(promoted.status).toBe("promoted");
    expect(promotion.previousActiveProposalId).toBeNull();
    expect(first.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );
    expect(first.revision).toBe(4);

    // Replacement chain
    await first.propose({
      id: "prop-b",
      createdAt: "2026-08-11T02:00:00.000Z",
      policy: validPolicy(),
      candidate: validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          roleProfiles: { worker: "codex-worker" },
          approvalGates: ["final"],
        },
      }),
    });
    const evaluatedB = await toEvaluated(first, "prop-b");
    const { proposal: promotedB, record: promotionB } = await first.promote(
      "prop-b",
      boundEvidence(evaluatedB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    expect(promotedB.status).toBe("promoted");
    expect(promotionB.previousActiveProposalId).toBe("prop-a");
    expect(first.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-b",
    );

    const { proposal: rolledBack, record: rollback } = await first.rollback(
      "prop-b",
      humanDecision({
        reason: "Restore prior active strategy",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    expect(rolledBack.status).toBe("rolled-back");
    expect(rollback.restoredActiveProposalId).toBe("prop-a");
    expect(first.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );

    // Rejection path
    await first.propose({
      id: "prop-reject",
      createdAt: "2026-08-11T03:00:00.000Z",
      policy: validPolicy(),
      candidate: validPromptCandidate(),
    });
    const evaluatedReject = await toEvaluated(first, "prop-reject");
    const { proposal: rejected } = await first.reject(
      "prop-reject",
      humanDecision({
        reason: "Not ready",
        decidedAt: "2026-08-11T03:03:00.000Z",
      }),
    );
    expect(rejected.status).toBe("rejected");
    expect(evaluatedReject.status).toBe("evaluated");

    const revisionAfter = first.revision;
    const snapshotAfter = first.snapshot();
    const documentText = await readFile(catalogPath(root), "utf8");

    const reopened = await openDurable(root);
    expect(reopened.revision).toBe(revisionAfter);
    expect(reopened.snapshot()).toEqual(snapshotAfter);
    expect(reopened.getProposal("prop-a")?.status).toBe("promoted");
    expect(reopened.getProposal("prop-b")?.status).toBe("rolled-back");
    expect(reopened.getProposal("prop-reject")?.status).toBe("rejected");
    expect(reopened.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );
    expect(reopened.getActiveProposalId({ kind: "role-prompt", path: "prompts/worker.md" })).toBe(
      null,
    );

    // Document version / digest fields remain strict.
    const document = JSON.parse(documentText) as {
      version: number;
      revision: number;
      payloadDigest: string;
      payload: unknown;
    };
    expect(document.version).toBe(EVOLUTION_DURABLE_DOCUMENT_VERSION);
    expect(document.revision).toBe(revisionAfter);
    expect(document.payloadDigest).toBe(computePayloadDigest(document.payload));
  });

  it("preserves append-ordered audit history across reopen", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);

    await durable.propose({
      id: "prop-audit",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const evaluated = await toEvaluated(durable, "prop-audit");
    await durable.promote("prop-audit", boundEvidence(evaluated), humanDecision());
    await durable.rollback(
      "prop-audit",
      humanDecision({
        reason: "Undo",
        decidedAt: "2026-08-11T01:04:00.000Z",
      }),
    );

    const before = durable.snapshot().auditRecords.map((record) => ({
      kind: record.kind,
      proposalId: record.proposalId,
    }));
    expect(before.map((record) => record.kind)).toEqual(["promotion", "rollback"]);

    const reopened = await openDurable(root);
    const after = reopened.snapshot().auditRecords.map((record) => ({
      kind: record.kind,
      proposalId: record.proposalId,
    }));
    expect(after).toEqual(before);
  });
});

describe("DurableEvolutionCatalog trust and validation", () => {
  it("fails closed when trust is tightened after durable write", async () => {
    const root = await createTempRoot();
    const full = withPromptFiles(createDefaultConfig("evolution-persistence"));
    const durable = await openDurable(root, { config: full });

    await durable.propose({
      id: "prop-prompt",
      createdAt: now,
      policy: validPolicy(),
      candidate: validPromptCandidate({ path: "prompts/worker.md" }),
    });

    const tightened = withPromptFiles(createDefaultConfig("evolution-persistence"));
    // Drop worker promptFile so the stored role-prompt candidate is no longer trusted.
    tightened.roles = {
      ...tightened.roles,
      worker: {
        ...tightened.roles.worker,
        promptFile: undefined,
      },
    };

    await expect(openDurable(root, { config: tightened })).rejects.toBeInstanceOf(
      EvolutionPersistenceValidationError,
    );

    // Original trust still reopens successfully.
    const reopened = await openDurable(root, { config: full });
    expect(reopened.getProposal("prop-prompt")?.status).toBe("proposed");
  });

  it("fails closed when a stored strategy profile is removed from current role trust", async () => {
    const root = await createTempRoot();
    const full = withPromptFiles(createDefaultConfig("evolution-persistence"));
    const workerProfile = full.roles.worker.allowedProfiles[0]!;
    const durable = await openDurable(root, { config: full });
    await durable.propose({
      id: "prop-profile-trust",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          roleProfiles: { worker: workerProfile },
          approvalGates: ["final"],
        },
      }),
    });

    const tightened = structuredClone(full);
    tightened.roles.worker.allowedProfiles = ["no-longer-the-stored-profile"];
    await expect(openDurable(root, { config: tightened })).rejects.toThrow(/not allowed/i);
  });

  it("fails closed on malformed JSON, unsupported version, and digest mismatch", async () => {
    const root = await createTempRoot();
    const dir = evolutionDir(root);
    await mkdir(dir, { recursive: true });

    await writeFile(catalogPath(root), "{", "utf8");
    await expect(openDurable(root)).rejects.toThrow(/malformed JSON/);

    await writeFile(
      catalogPath(root),
      `${JSON.stringify({
        version: 999,
        revision: 1,
        payloadDigest: "a".repeat(64),
        payload: {
          proposals: [],
          auditRecords: [],
          activeProposals: [],
          promotionRecords: [],
        },
      })}\n`,
      "utf8",
    );
    await expect(openDurable(root)).rejects.toThrow(/unsupported version/);

    const payload = {
      proposals: [],
      auditRecords: [],
      activeProposals: [],
      promotionRecords: [],
    };
    await writeFile(
      catalogPath(root),
      `${JSON.stringify({
        version: EVOLUTION_DURABLE_DOCUMENT_VERSION,
        revision: 1,
        payloadDigest: "b".repeat(64),
        payload,
      })}\n`,
      "utf8",
    );
    await expect(openDurable(root)).rejects.toThrow(/payload digest mismatch/);
  });

  it("requires strict document, pointer, and target fields", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-strict",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const evaluated = await toEvaluated(durable, "prop-strict");
    await durable.promote("prop-strict", boundEvidence(evaluated), humanDecision());
    const original = await readCatalogDocument(root);

    const extraDocument = structuredClone(original);
    extraDocument.unexpected = true;
    await writeCatalogDocument(root, extraDocument);
    await expect(openDurable(root)).rejects.toThrow(/unexpected field/i);

    const extraPointer = structuredClone(original) as typeof original & {
      payload: { activeProposals: Array<Record<string, unknown>> };
    };
    extraPointer.payload.activeProposals[0]!.unexpected = true;
    await writeCatalogDocument(root, extraPointer);
    await expect(openDurable(root)).rejects.toThrow(/unexpected field/i);

    const extraTarget = structuredClone(original) as typeof extraPointer;
    const target = extraTarget.payload.activeProposals[0]!.target as Record<string, unknown>;
    target.unexpected = true;
    await writeCatalogDocument(root, extraTarget);
    await expect(openDurable(root)).rejects.toThrow(/unexpected field/i);
  });

  it("requires revision to exactly match reconstructible catalog mutations", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-revision",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const original = await readCatalogDocument(root);

    for (const invalidRevision of [0, 2, Number.MAX_SAFE_INTEGER + 1]) {
      const tampered = structuredClone(original);
      tampered.revision = invalidRevision;
      await writeCatalogDocument(root, tampered);
      await expect(openDurable(root)).rejects.toThrow(/revision/i);
    }
  });

  it("fails closed on forged allowlists, duplicate ids, and invalid active pointers", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-1",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const evaluated = await toEvaluated(durable, "prop-1");
    await durable.promote("prop-1", boundEvidence(evaluated), humanDecision());

    const document = await readCatalogDocument(root);
    const payload = document.payload as {
      proposals: Array<Record<string, unknown>>;
      auditRecords: unknown[];
      activeProposals: Array<Record<string, unknown>>;
      promotionRecords: unknown[];
    };

    // Forged policy allowlist path not present in trust.
    const forged = structuredClone(document) as typeof document & {
      payload: typeof payload;
      payloadDigest: string;
    };
    const proposal = structuredClone(payload.proposals[0]!) as Record<string, unknown>;
    const policy = proposal.policy as Record<string, unknown>;
    policy.allowedPromptPaths = ["prompts/worker.md", "prompts/forged.md"];
    forged.payload.proposals = [proposal, ...payload.proposals.slice(1)];
    forged.payloadDigest = computePayloadDigest(forged.payload);
    await writeFile(catalogPath(root), `${JSON.stringify(forged)}\n`, "utf8");
    await expect(openDurable(root)).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    // Duplicate proposal ids with matching digest.
    const duplicate = structuredClone(document) as typeof document & {
      payload: typeof payload;
      payloadDigest: string;
    };
    const first = structuredClone(payload.proposals[0]!) as Record<string, unknown>;
    const second = structuredClone(payload.proposals[0]!) as Record<string, unknown>;
    duplicate.payload.proposals = [first, second];
    duplicate.payloadDigest = computePayloadDigest(duplicate.payload);
    await writeFile(catalogPath(root), `${JSON.stringify(duplicate)}\n`, "utf8");
    await expect(openDurable(root)).rejects.toThrow(/duplicate proposal id/);

    // Invalid active pointer (missing proposal).
    const badActive = structuredClone(document) as typeof document & {
      payload: typeof payload;
      payloadDigest: string;
    };
    badActive.payload.activeProposals = [
      {
        target: { kind: "strategy-blueprint", name: "serial-review" },
        proposalId: "missing-proposal",
      },
    ];
    badActive.payloadDigest = computePayloadDigest(badActive.payload);
    await writeFile(catalogPath(root), `${JSON.stringify(badActive)}\n`, "utf8");
    await expect(openDurable(root)).rejects.toThrow(/active pointer references missing proposal/);
  });

  it("replays terminal audit history and rejects forged promotion, rollback, and rejection chains", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);

    await durable.propose({
      id: "prop-a",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const evaluatedA = await toEvaluated(durable, "prop-a");
    await durable.promote("prop-a", boundEvidence(evaluatedA), humanDecision());

    await durable.propose({
      id: "prop-prompt",
      createdAt: "2026-08-11T01:10:00.000Z",
      policy: validPolicy(),
      candidate: validPromptCandidate(),
    });
    const evaluatedPrompt = await toEvaluated(durable, "prop-prompt");
    await durable.promote(
      "prop-prompt",
      boundEvidence(evaluatedPrompt),
      humanDecision({ decidedAt: "2026-08-11T01:13:00.000Z" }),
    );

    await durable.propose({
      id: "prop-b",
      createdAt: "2026-08-11T02:00:00.000Z",
      policy: validPolicy(),
      candidate: validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          roleProfiles: {},
          approvalGates: ["plan", "final"],
        },
      }),
    });
    const evaluatedB = await toEvaluated(durable, "prop-b");
    await durable.promote(
      "prop-b",
      boundEvidence(evaluatedB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );

    type MutablePayload = {
      proposals: Array<Record<string, unknown>>;
      auditRecords: Array<Record<string, unknown>>;
      activeProposals: Array<Record<string, unknown>>;
      promotionRecords: Array<Record<string, unknown>>;
    };
    type MutableDocument = Record<string, unknown> & { payload: MutablePayload };
    const promotedDocument = (await readCatalogDocument(root)) as MutableDocument;

    const nonLatestActive = structuredClone(promotedDocument);
    const strategyPointer = nonLatestActive.payload.activeProposals.find(
      (pointer) => (pointer.target as Record<string, unknown>).kind === "strategy-blueprint",
    )!;
    strategyPointer.proposalId = "prop-a";
    await writeCatalogDocument(root, nonLatestActive);
    await expect(openDurable(root)).rejects.toThrow(/replayed/i);

    const crossTargetPrevious = structuredClone(promotedDocument);
    const storedPromotionB = crossTargetPrevious.payload.promotionRecords.find(
      (record) => record.proposalId === "prop-b",
    )!;
    const auditPromotionB = crossTargetPrevious.payload.auditRecords.find(
      (record) => record.kind === "promotion" && record.proposalId === "prop-b",
    )!;
    storedPromotionB.previousActiveProposalId = "prop-prompt";
    auditPromotionB.previousActiveProposalId = "prop-prompt";
    const proposalB = crossTargetPrevious.payload.proposals.find(
      (proposal) => proposal.id === "prop-b",
    )!;
    proposalB.promotionRecordDigest = promotionRecordDigest(storedPromotionB);
    await writeCatalogDocument(root, crossTargetPrevious);
    await expect(openDurable(root)).rejects.toThrow(/previousActiveProposalId|same target/i);

    await writeCatalogDocument(root, promotedDocument);
    await durable.rollback(
      "prop-b",
      humanDecision({
        reason: "Restore A",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    await durable.propose({
      id: "prop-reject",
      createdAt: "2026-08-11T03:00:00.000Z",
      policy: validPolicy(),
      candidate: validPromptCandidate({ path: "prompts/reviewer.md" }),
    });
    await toEvaluated(durable, "prop-reject");
    await durable.reject(
      "prop-reject",
      humanDecision({ reason: "Reject", decidedAt: "2026-08-11T03:03:00.000Z" }),
    );
    const terminalDocument = (await readCatalogDocument(root)) as MutableDocument;

    const missingRejection = structuredClone(terminalDocument);
    missingRejection.payload.auditRecords = missingRejection.payload.auditRecords.filter(
      (record) => !(record.kind === "rejection" && record.proposalId === "prop-reject"),
    );
    await writeCatalogDocument(root, missingRejection);
    await expect(openDurable(root)).rejects.toThrow(/cardinality/i);

    const duplicateRollback = structuredClone(terminalDocument);
    const rollback = duplicateRollback.payload.auditRecords.find(
      (record) => record.kind === "rollback" && record.proposalId === "prop-b",
    )!;
    duplicateRollback.payload.auditRecords.push(structuredClone(rollback));
    await writeCatalogDocument(root, duplicateRollback);
    await expect(openDurable(root)).rejects.toThrow(/duplicates rollback/i);

    const reversed = structuredClone(terminalDocument);
    reversed.payload.auditRecords.reverse();
    await writeCatalogDocument(root, reversed);
    await expect(openDurable(root)).rejects.toThrow(/before its promotion|inactive proposal/i);

    const mismatchedRejection = structuredClone(terminalDocument);
    const rejection = mismatchedRejection.payload.auditRecords.find(
      (record) => record.kind === "rejection" && record.proposalId === "prop-reject",
    )!;
    rejection.at = "2026-08-11T03:04:00.000Z";
    await writeCatalogDocument(root, mismatchedRejection);
    await expect(openDurable(root)).rejects.toThrow(/timestamp/i);
  });

  it("fails closed when the primary document is tampered without updating the digest", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-tamper",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });

    const document = await readCatalogDocument(root);
    const payload = document.payload as {
      proposals: Array<Record<string, unknown>>;
    };
    payload.proposals[0]!.id = "prop-tampered-id";
    // Intentionally leave payloadDigest unchanged.
    await writeFile(catalogPath(root), `${JSON.stringify(document)}\n`, "utf8");

    await expect(openDurable(root)).rejects.toThrow(/payload digest mismatch/);
  });
});

describe("DurableEvolutionCatalog concurrency and failure recovery", () => {
  it("serializes concurrent same-instance mutations without losing updates", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        durable.propose({
          id: `prop-concurrent-${index}`,
          createdAt: new Date(Date.parse(now) + index * 1000).toISOString(),
          policy: validPolicy(),
          candidate: validStrategyCandidate({
            name: `strategy-${index}`,
          }),
        }),
      ),
    );

    expect(results).toHaveLength(8);
    expect(durable.revision).toBe(8);
    for (let index = 0; index < 8; index += 1) {
      expect(durable.getProposal(`prop-concurrent-${index}`)?.status).toBe("proposed");
    }

    const reopened = await openDurable(root);
    expect(reopened.revision).toBe(8);
    expect(reopened.snapshot().proposals).toHaveLength(8);
  });

  it("rejects stale revision conflicts and leaves memory at the last committed revision", async () => {
    const root = await createTempRoot();
    const first = await openDurable(root);
    const stale = await openDurable(root);
    await first.propose({
      id: "prop-base",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    expect(first.revision).toBe(1);

    await expect(
      stale.propose({
        id: "prop-stale",
        createdAt: "2026-08-11T01:05:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "stale" }),
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceConflictError);

    expect(stale.revision).toBe(0);
    expect(stale.getProposal("prop-stale")).toBeUndefined();
    await expect(
      stale.propose({
        id: "prop-still-stale",
        createdAt: "2026-08-11T01:06:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "still-stale" }),
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceConflictError);

    const reopened = await openDurable(root);
    expect(reopened.revision).toBe(1);
    expect(reopened.getProposal("prop-base")?.status).toBe("proposed");
  });

  it("detects valid same-revision replacement and digest corruption before overwriting disk", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-base",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const original = await readCatalogDocument(root);
    const replacement = structuredClone(original) as typeof original & {
      payload: { proposals: Array<Record<string, unknown>> };
    };
    const candidate = replacement.payload.proposals[0]!.candidate as Record<string, unknown>;
    candidate.name = "same-revision-replacement";
    await writeCatalogDocument(root, replacement);

    await expect(
      durable.propose({
        id: "prop-overwrite",
        createdAt: "2026-08-11T01:05:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "overwrite" }),
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceConflictError);

    await writeCatalogDocument(root, original);
    const corrupted = structuredClone(original);
    corrupted.payloadDigest = "f".repeat(64);
    await writeFile(catalogPath(root), `${JSON.stringify(corrupted)}\n`, "utf8");
    await expect(
      durable.propose({
        id: "prop-corrupt-overwrite",
        createdAt: "2026-08-11T01:06:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "corrupt-overwrite" }),
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it.each(["open", "write", "file-sync", "rename"] as const)(
    "keeps memory and disk committed and leaves the queue usable when atomic stage %s fails",
    async (stage) => {
      const root = await createTempRoot();
      let failStage: typeof stage | undefined;
      const durable = await openDurable(root, {
        io: {
          beforeAtomicStage: async (current) => {
            if (current === failStage) throw new Error(`injected ${stage} failure`);
          },
        },
      });
      await durable.propose({
        id: "prop-ok",
        createdAt: now,
        policy: validPolicy(),
        candidate: validStrategyCandidate(),
      });
      const diskBefore = await readFile(catalogPath(root), "utf8");

      failStage = stage;
      await expect(
        durable.propose({
          id: "prop-fail",
          createdAt: "2026-08-11T01:10:00.000Z",
          policy: validPolicy(),
          candidate: validStrategyCandidate({ name: "fail" }),
        }),
      ).rejects.toBeInstanceOf(EvolutionPersistenceError);
      failStage = undefined;

      expect(durable.revision).toBe(1);
      expect(durable.getProposal("prop-fail")).toBeUndefined();
      expect(await readFile(catalogPath(root), "utf8")).toBe(diskBefore);
      await durable.propose({
        id: "prop-recover",
        createdAt: "2026-08-11T01:11:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "recover" }),
      });
      expect(durable.revision).toBe(2);
    },
  );

  it("fails closed after a post-rename directory fsync error and requires reopen", async () => {
    const root = await createTempRoot();
    let failDirectorySync = false;
    const durable = await openDurable(root, {
      io: {
        beforeAtomicStage: async (stage) => {
          if (failDirectorySync && stage === "directory-sync") {
            throw new Error("injected directory fsync failure");
          }
        },
      },
    });
    await durable.propose({
      id: "prop-ok",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    failDirectorySync = true;
    await expect(
      durable.propose({
        id: "prop-indeterminate",
        createdAt: "2026-08-11T01:10:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "indeterminate" }),
      }),
    ).rejects.toThrow(/reopen/i);
    expect(durable.revision).toBe(1);
    await expect(
      durable.propose({
        id: "prop-after-indeterminate",
        createdAt: "2026-08-11T01:11:00.000Z",
        policy: validPolicy(),
        candidate: validStrategyCandidate({ name: "after-indeterminate" }),
      }),
    ).rejects.toThrow(/reopen/i);

    const reopened = await openDurable(root);
    expect(reopened.revision).toBe(2);
    expect(reopened.getProposal("prop-indeterminate")?.status).toBe("proposed");
  });

  it("writes the primary document with mode 0600 where the platform supports it", async () => {
    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-mode",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });

    const info = await stat(catalogPath(root));
    if (process.platform === "win32") {
      expect(info.isFile()).toBe(true);
      return;
    }
    expect(info.mode & 0o777).toBe(0o600);
  });
});

describe("DurableEvolutionCatalog does not mutate repository fixtures", () => {
  it("leaves prompt and strategy fixture bytes unchanged after durable mutations", async () => {
    const promptPath = path.join(repoRoot, "prompts", "worker.md");
    const strategyPath = path.join(repoRoot, "docs", "strategy-blueprints.md");
    const promptBefore = await readFile(promptPath);
    const strategyBefore = await readFile(strategyPath);
    const promptDigestBefore = createHash("sha256").update(promptBefore).digest("hex");
    const strategyDigestBefore = createHash("sha256").update(strategyBefore).digest("hex");

    const root = await createTempRoot();
    const durable = await openDurable(root);
    await durable.propose({
      id: "prop-fixture-strategy",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate(),
    });
    const evaluatedStrategy = await toEvaluated(durable, "prop-fixture-strategy");
    await durable.promote(
      "prop-fixture-strategy",
      boundEvidence(evaluatedStrategy),
      humanDecision(),
    );

    await durable.propose({
      id: "prop-fixture-prompt",
      createdAt: "2026-08-11T02:00:00.000Z",
      policy: validPolicy(),
      candidate: validPromptCandidate({
        contentDigest: createHash("sha256").update(promptBefore).digest("hex"),
      }),
    });
    const evaluatedPrompt = await toEvaluated(durable, "prop-fixture-prompt");
    await durable.promote(
      "prop-fixture-prompt",
      boundEvidence(evaluatedPrompt),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );

    const promptAfter = await readFile(promptPath);
    const strategyAfter = await readFile(strategyPath);
    expect(Buffer.compare(promptBefore, promptAfter)).toBe(0);
    expect(Buffer.compare(strategyBefore, strategyAfter)).toBe(0);
    expect(createHash("sha256").update(promptAfter).digest("hex")).toBe(promptDigestBefore);
    expect(createHash("sha256").update(strategyAfter).digest("hex")).toBe(strategyDigestBefore);
  });
});

// Retain named imports used only for type-level / platform coverage clarity.
void fsConstants;
void chmod;
void openAsync;
void readdir;
void rename;
void rm;
void unlink;
