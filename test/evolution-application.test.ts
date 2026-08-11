import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import type { AgentTeamConfig, NamedStrategy } from "../src/config/schema.js";
import {
  EVOLUTION_APPLICATION_FILENAME,
  EVOLUTION_PROMPT_MATERIAL_MAX_BYTES,
  EvolutionApplicationCoordinator,
  type EvolutionApplicationFileIo,
} from "../src/evolution/application.js";
import { computeCandidateDigest, type EvolutionProposal } from "../src/evolution/domain.js";
import {
  computePayloadDigest,
  DurableEvolutionCatalog,
  type DurableEvolutionFileIo,
  EvolutionPersistenceValidationError,
} from "../src/evolution/persistence.js";
import {
  GitManager,
  GitManagerError,
  type ExactTrackedFileCommitAuthorization,
  type ExactTrackedFileCommitResult,
} from "../src/git/manager.js";
import { runProcess } from "../src/process/run.js";
import { StrategyBlueprintCatalog } from "../src/strategies/catalog.js";

const operator = "phase3-operator";
const promptPath = "prompts/worker.md";
const originalPrompt = Buffer.from("Original worker prompt\n", "utf8");

const strategyA: NamedStrategy = {
  topology: { mode: "sequential" },
  maxParallel: 1,
  roleProfiles: {},
  approvalGates: ["final"],
};

const strategyB: NamedStrategy = {
  topology: { mode: "parallel-dag" },
  maxParallel: 3,
  maxReworkAttempts: 1,
  roleProfiles: {},
  approvalGates: ["plan", "final"],
};

const manuallyManagedStrategy: NamedStrategy = {
  topology: { mode: "parallel-dag" },
  maxParallel: 4,
  maxReworkAttempts: 3,
  executionTimeoutSeconds: 3_600,
  maxAgentInvocations: 42,
  maxProcessOutputBytes: 65_536,
  maxArtifactBytes: 1_048_576,
  roleProfiles: { worker: "codex-worker" },
  approvalGates: ["plan", "final"],
  approvalTimeoutSeconds: 600,
};

type TestClock = {
  now: () => number;
  advance: (milliseconds: number) => void;
};

type Harness = {
  root: string;
  loaded: LoadedConfig;
  catalog: DurableEvolutionCatalog;
  strategies: StrategyBlueprintCatalog;
  git: GitManager;
  coordinator: EvolutionApplicationCoordinator;
  clock: TestClock;
};

class FailOnceExactCommitGitManager extends GitManager {
  failNextExactCommit = false;

  override async commitExactTrackedFile(
    authorization: ExactTrackedFileCommitAuthorization,
    message: string,
  ): Promise<ExactTrackedFileCommitResult> {
    if (this.failNextExactCommit) {
      this.failNextExactCommit = false;
      throw new GitManagerError(
        "GIT_OPERATION_FAILED",
        "injected crash before exact-path Git commit",
      );
    }
    return await super.commitExactTrackedFile(authorization, message);
  }
}

function createClock(): TestClock {
  let current = Date.parse("2026-08-11T01:00:00.000Z");
  return {
    now: () => current++,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

function createConfig(): AgentTeamConfig {
  const config = createDefaultConfig("evolution-application");
  return {
    ...config,
    roles: {
      ...config.roles,
      worker: {
        ...config.roles.worker,
        promptFile: promptPath,
      },
    },
  };
}

function createLoadedConfig(root: string): LoadedConfig {
  return {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createConfig(),
  };
}

function validPolicy() {
  return {
    version: 1,
    capabilities: {
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    },
    allowedPromptPaths: [promptPath],
  };
}

function strategyCandidate(name: string, definition: NamedStrategy) {
  return {
    kind: "strategy-blueprint",
    name,
    definition,
  };
}

function boundEvidence(proposal: EvolutionProposal) {
  return {
    proposalId: proposal.id,
    candidateDigest: computeCandidateDigest(proposal.candidate),
    items: [
      {
        kind: "deterministic",
        id: "phase3-focused-tests",
        status: "pass",
        summary: "Focused application checks passed",
      },
      {
        kind: "advisory",
        id: "human-review",
        verdict: "approve",
        summary: "Independent human review approved the candidate",
      },
    ],
  };
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Phase 3 Fixture"]);
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(path.join(root, promptPath), originalPrompt);
  await chmod(path.join(root, promptPath), 0o640);
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "phase 3 fixture\n", "utf8");
  await git(root, ["add", ".gitignore", "README.md", promptPath]);
  await git(root, ["commit", "-m", "initial fixture"]);
}

async function createHarness(options: {
  root?: string;
  io?: Partial<EvolutionApplicationFileIo>;
  catalogIo?: Partial<DurableEvolutionFileIo>;
  gitFactory?: (root: string) => GitManager;
  assertQuiescent?: () => void | Promise<void>;
  clock?: TestClock;
  previewTtlMs?: number;
} = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(path.join(tmpdir(), "agent-team-phase3-")));
  if (!options.root) {
    await initializeRepository(root);
  }
  const loaded = createLoadedConfig(root);
  const catalog = await DurableEvolutionCatalog.open(loaded, { io: options.catalogIo });
  const strategies = await StrategyBlueprintCatalog.open(loaded);
  const gitManager =
    options.gitFactory?.(root) ??
    new GitManager(root, path.join(root, ".agent-team", "worktrees"));
  const clock = options.clock ?? createClock();
  const coordinator = await EvolutionApplicationCoordinator.open({
    catalog,
    strategies,
    git: gitManager,
    loaded,
    assertQuiescent: options.assertQuiescent ?? (() => undefined),
    io: options.io,
    now: clock.now,
    previewTtlMs: options.previewTtlMs,
  });
  return {
    root,
    loaded,
    catalog,
    strategies,
    git: gitManager,
    coordinator,
    clock,
  };
}

async function proposeEvaluatedStrategy(
  harness: Harness,
  id: string,
  name: string,
  definition: NamedStrategy,
): Promise<EvolutionProposal> {
  await harness.coordinator.propose({
    id,
    policy: validPolicy(),
    candidate: strategyCandidate(name, definition),
  });
  await harness.coordinator.beginEvaluation(id);
  const evaluating = harness.coordinator.readProposal(id);
  if (!evaluating) throw new Error(`Proposal '${id}' disappeared before evaluation`);
  return (await harness.coordinator.evaluate(id, boundEvidence(evaluating))).proposal;
}

async function promoteStrategy(
  harness: Harness,
  proposalId: string,
  commandId: string,
  reason: string,
) {
  const preview = await harness.coordinator.previewPromotion({
    proposalId,
    operator,
  });
  const result = await harness.coordinator.promoteAndApply({
    commandId,
    proposalId,
    expectedRevision: preview.catalogRevision,
    token: preview.token,
    operator,
    reason,
  });
  return { preview, result };
}

async function rollbackStrategy(
  harness: Harness,
  proposalId: string,
  commandId: string,
  reason: string,
) {
  const preview = await harness.coordinator.previewRollback({ proposalId, operator });
  const result = await harness.coordinator.rollbackAppliedPromotion({
    commandId,
    proposalId,
    expectedRevision: preview.catalogRevision,
    token: preview.token,
    operator,
    reason,
  });
  return { preview, result };
}

async function proposeEvaluatedPrompt(
  harness: Harness,
  id: string,
  content: Uint8Array,
): Promise<EvolutionProposal> {
  const digest = sha256(content);
  await harness.coordinator.propose({
    id,
    policy: validPolicy(),
    candidate: {
      kind: "role-prompt",
      path: promptPath,
      contentDigest: digest,
    },
    promptContent: content,
  });
  await harness.coordinator.beginEvaluation(id);
  const evaluating = harness.coordinator.readProposal(id);
  if (!evaluating) throw new Error(`Proposal '${id}' disappeared before evaluation`);
  return (await harness.coordinator.evaluate(id, boundEvidence(evaluating))).proposal;
}

describe("EvolutionApplicationCoordinator server-owned preflight", () => {
  it("binds fixed strategy checks to the current candidate and replays evaluated state", async () => {
    const harness = await createHarness();
    await harness.coordinator.propose({
      id: "server-preflight-strategy",
      policy: { ...validPolicy(), allowedPromptPaths: [] },
      candidate: strategyCandidate("server-preflight", strategyA),
    });

    const evaluated = await harness.coordinator.evaluateServerPreflight(
      "server-preflight-strategy",
    );
    expect(evaluated.proposal).toMatchObject({
      status: "evaluated",
      evaluation: {
        source: "server-structural-preflight-v1",
        result: { passed: true, deterministicPassed: true },
        evidence: {
          proposalId: "server-preflight-strategy",
          candidateDigest: computeCandidateDigest(
            strategyCandidate("server-preflight", strategyA),
          ),
          items: [
            { id: "server-candidate-trust-v1", status: "pass" },
            { id: "server-strategy-preflight-v1", status: "pass" },
          ],
        },
      },
    });
    expect(
      evaluated.proposal.evaluation?.evidence.items.every((item) =>
        item.summary.includes("candidate was not executed"),
      ),
    ).toBe(true);

    const revision = harness.catalog.revision;
    const replay = await harness.coordinator.evaluateServerPreflight(
      "server-preflight-strategy",
    );
    expect(replay.committedRevision).toBe(revision);
    expect(harness.catalog.revision).toBe(revision);
  });

  it("rejects legacy external evidence instead of relabeling it as server preflight", async () => {
    const harness = await createHarness();
    await harness.coordinator.propose({
      id: "legacy-external-evaluation",
      policy: { ...validPolicy(), allowedPromptPaths: [] },
      candidate: strategyCandidate("legacy-external", strategyA),
    });
    await harness.coordinator.beginEvaluation("legacy-external-evaluation");
    const evaluating = harness.coordinator.readProposal("legacy-external-evaluation");
    if (!evaluating) throw new Error("Legacy proposal disappeared");
    const evaluated = await harness.coordinator.evaluate(
      evaluating.id,
      boundEvidence(evaluating),
    );

    expect(evaluated.proposal.evaluation?.source).toBe("external");
    await expect(
      harness.coordinator.evaluateServerPreflight(evaluating.id),
    ).rejects.toMatchObject({ code: "EVALUATION_SOURCE_UNTRUSTED" });
    await expect(
      harness.coordinator.assertServerPreflightEvaluation(evaluating.id),
    ).rejects.toMatchObject({ code: "EVALUATION_SOURCE_UNTRUSTED" });
  });

  it("records a deterministic failure for a configured read-only strategy", async () => {
    const harness = await createHarness();
    await harness.coordinator.propose({
      id: "server-preflight-configured",
      policy: { ...validPolicy(), allowedPromptPaths: [] },
      candidate: strategyCandidate("balanced", strategyA),
    });

    const result = await harness.coordinator.evaluateServerPreflight(
      "server-preflight-configured",
    );
    expect(result.proposal).toMatchObject({
      status: "evaluated",
      evaluation: {
        result: {
          passed: false,
          failedDeterministicIds: [
            "server-candidate-trust-v1",
            "server-strategy-preflight-v1",
          ],
        },
      },
    });
  });

  it("verifies prompt object integrity and the live Git-tracked target", async () => {
    const harness = await createHarness();
    const content = Buffer.from("Candidate prompt verified by server preflight\n", "utf8");
    await harness.coordinator.propose({
      id: "server-preflight-prompt",
      policy: validPolicy(),
      candidate: {
        kind: "role-prompt",
        path: promptPath,
        contentDigest: sha256(content),
      },
      promptContent: content,
    });

    const result = await harness.coordinator.evaluateServerPreflight(
      "server-preflight-prompt",
    );
    expect(result.proposal).toMatchObject({
      status: "evaluated",
      evaluation: {
        result: { passed: true },
        evidence: {
          items: [
            { id: "server-candidate-trust-v1", status: "pass" },
            { id: "server-prompt-object-integrity-v1", status: "pass" },
            { id: "server-prompt-target-trust-v1", status: "pass" },
          ],
        },
      },
    });
  });
});

describe("EvolutionApplicationCoordinator strategy lifecycle", () => {
  it("proposes, evaluates, applies, replaces, and rolls back the full strategy chain", async () => {
    const harness = await createHarness();

    await proposeEvaluatedStrategy(harness, "strategy-v1", "serial-review", strategyA);
    const first = await promoteStrategy(
      harness,
      "strategy-v1",
      "promote-strategy-v1",
      "Apply reviewed strategy v1",
    );

    expect(first.result).toMatchObject({
      applicationStatus: "applied",
      deduplicated: false,
      proposal: { id: "strategy-v1", status: "promoted" },
    });
    expect(harness.strategies.customDefinition("serial-review")).toMatchObject(strategyA);
    expect(harness.coordinator.getApplication("strategy-v1")).toMatchObject({
      proposalId: "strategy-v1",
      beforeTargetDigest: null,
      previousApplication: null,
    });

    const deduplicated = await harness.coordinator.promoteAndApply({
      commandId: "promote-strategy-v1",
      proposalId: "strategy-v1",
      expectedRevision: first.preview.catalogRevision,
      token: first.preview.token,
      operator,
      reason: "Apply reviewed strategy v1",
    });
    expect(deduplicated.deduplicated).toBe(true);
    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "promote-strategy-v1",
        proposalId: "strategy-v1",
        expectedRevision: first.preview.catalogRevision,
        token: first.preview.token,
        operator,
        reason: "Reuse command with different intent",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });

    await proposeEvaluatedStrategy(harness, "strategy-v2", "serial-review", strategyB);
    await promoteStrategy(
      harness,
      "strategy-v2",
      "promote-strategy-v2",
      "Replace v1 with reviewed v2",
    );
    expect(harness.strategies.customDefinition("serial-review")).toMatchObject(strategyB);
    expect(harness.coordinator.getApplication("strategy-v1")).toBeUndefined();
    expect(harness.coordinator.getApplication("strategy-v2")).toMatchObject({
      proposalId: "strategy-v2",
      previousApplication: { proposalId: "strategy-v1" },
    });

    const rollbackV2 = await rollbackStrategy(
      harness,
      "strategy-v2",
      "rollback-strategy-v2",
      "Restore reviewed v1",
    );
    expect(rollbackV2.result).toMatchObject({
      applicationStatus: "rolled-back",
      proposal: { id: "strategy-v2", status: "rolled-back" },
    });
    expect(harness.strategies.customDefinition("serial-review")).toMatchObject(strategyA);
    expect(harness.coordinator.getApplication("strategy-v1")).toMatchObject({
      proposalId: "strategy-v1",
    });
    expect(harness.coordinator.getApplication("strategy-v2")).toBeUndefined();

    await rollbackStrategy(
      harness,
      "strategy-v1",
      "rollback-strategy-v1",
      "Remove the initial custom strategy",
    );
    expect(harness.strategies.customDefinition("serial-review")).toBeUndefined();
    expect(harness.coordinator.getApplication("strategy-v1")).toBeUndefined();
    expect(harness.catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: "serial-review",
    })).toBeNull();
    expect(harness.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
    });
    expect(harness.coordinator.getApplicationState().completed).toHaveLength(4);
  });

  it("restores the complete definition that existed before evolution replaced a manual custom strategy", async () => {
    const harness = await createHarness();
    await harness.strategies.save("manual-existing", manuallyManagedStrategy, {
      expectedBefore: null,
    });
    const manualBaseline = harness.strategies.customDefinition("manual-existing");
    expect(manualBaseline).toEqual(manuallyManagedStrategy);

    await proposeEvaluatedStrategy(
      harness,
      "replace-manual-existing",
      "manual-existing",
      strategyB,
    );
    await promoteStrategy(
      harness,
      "replace-manual-existing",
      "replace-manual-existing-command",
      "Temporarily replace a manually managed strategy",
    );
    expect(harness.strategies.customDefinition("manual-existing")).toEqual(strategyB);

    await rollbackStrategy(
      harness,
      "replace-manual-existing",
      "restore-manual-existing-command",
      "Restore every field from the manual definition",
    );
    expect(harness.strategies.customDefinition("manual-existing")).toEqual(manualBaseline);
    expect(harness.coordinator.getApplication("replace-manual-existing")).toBeUndefined();
  });

  it("never modifies a strategy defined in project configuration", async () => {
    const harness = await createHarness();
    const configuredBefore = structuredClone(
      harness.loaded.config.strategies!.definitions.balanced,
    );
    await proposeEvaluatedStrategy(harness, "replace-configured", "balanced", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "replace-configured",
      operator,
    });

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "replace-configured-command",
        proposalId: "replace-configured",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Configured definitions must stay read-only",
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(harness.strategies.source("balanced")).toBe("config");
    expect(harness.strategies.customDefinition("balanced")).toBeUndefined();
    expect(harness.loaded.config.strategies!.definitions.balanced).toEqual(configuredBefore);
    expect(harness.coordinator.readProposal("replace-configured")).toMatchObject({
      status: "evaluated",
    });
    expect(harness.catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: "balanced",
    })).toBeNull();
  });
});

describe("EvolutionApplicationCoordinator preview trust boundary", () => {
  it("isolates the public preview and rejects a tampered token without consuming the real token", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(harness, "preview-isolation", "isolated", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "preview-isolation",
      operator,
    });

    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.afterTarget)).toBe(true);
    expect(() => {
      (preview.afterTarget as { digest: string | null }).digest = "f".repeat(64);
    }).toThrow(TypeError);

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "tampered-token",
        proposalId: "preview-isolation",
        expectedRevision: preview.catalogRevision,
        token: `${preview.token}x`,
        operator,
        reason: "Token was altered",
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "valid-after-tamper",
        proposalId: "preview-isolation",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Apply the canonical preview",
      }),
    ).resolves.toMatchObject({ applicationStatus: "applied" });
    expect(harness.strategies.customDefinition("isolated")).toMatchObject(strategyA);
  });

  it("rejects expired previews", async () => {
    const clock = createClock();
    const harness = await createHarness({ clock, previewTtlMs: 25 });
    await proposeEvaluatedStrategy(harness, "expired-preview", "expires", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "expired-preview",
      operator,
    });
    clock.advance(100);

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "expired-preview-command",
        proposalId: "expired-preview",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "This approval arrived too late",
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(harness.strategies.customDefinition("expires")).toBeUndefined();
  });

  it("rejects target and catalog drift after preview", async () => {
    const targetHarness = await createHarness();
    await proposeEvaluatedStrategy(targetHarness, "target-drift", "drifting", strategyA);
    const targetPreview = await targetHarness.coordinator.previewPromotion({
      proposalId: "target-drift",
      operator,
    });
    await targetHarness.strategies.save("drifting", strategyB, { expectedBefore: null });

    await expect(
      targetHarness.coordinator.promoteAndApply({
        commandId: "target-drift-command",
        proposalId: "target-drift",
        expectedRevision: targetPreview.catalogRevision,
        token: targetPreview.token,
        operator,
        reason: "Must reject changed target",
      }),
    ).rejects.toMatchObject({ code: "TARGET_DRIFTED" });

    const catalogHarness = await createHarness();
    await proposeEvaluatedStrategy(catalogHarness, "catalog-drift", "catalog-drift", strategyA);
    const catalogPreview = await catalogHarness.coordinator.previewPromotion({
      proposalId: "catalog-drift",
      operator,
    });
    await catalogHarness.coordinator.propose({
      id: "unrelated-revision",
      policy: validPolicy(),
      candidate: strategyCandidate("unrelated", strategyB),
    });

    await expect(
      catalogHarness.coordinator.promoteAndApply({
        commandId: "catalog-drift-command",
        proposalId: "catalog-drift",
        expectedRevision: catalogPreview.catalogRevision,
        token: catalogPreview.token,
        operator,
        reason: "Must reject stale catalog revision",
      }),
    ).rejects.toMatchObject({ code: "STALE_CATALOG_REVISION" });
  });

  it("rejects replacement preview when the active applied target was manually changed", async () => {
    const harness = await createHarness();
    const targetName = "drifted-before-replacement-preview";
    await proposeEvaluatedStrategy(harness, "applied-a", targetName, strategyA);
    await promoteStrategy(
      harness,
      "applied-a",
      "apply-a-before-drift-command",
      "Apply strategy A before manual drift",
    );
    await proposeEvaluatedStrategy(harness, "evaluated-b", targetName, strategyB);

    const appliedDefinition = harness.strategies.customDefinition(targetName);
    if (!appliedDefinition) throw new Error("Applied strategy A is missing");
    await harness.strategies.save(targetName, manuallyManagedStrategy, {
      expectedBefore: appliedDefinition,
    });
    const revisionBeforePreview = harness.catalog.revision;
    const applicationBeforePreview = harness.coordinator.getApplicationState();
    const catalogBeforePreview = await harness.coordinator.readCatalogSnapshot();

    await expect(
      harness.coordinator.previewPromotion({
        proposalId: "evaluated-b",
        operator,
        expectedRevision: revisionBeforePreview,
      }),
    ).rejects.toMatchObject({ code: "TARGET_DRIFTED" });
    expect(harness.strategies.customDefinition(targetName)).toEqual(manuallyManagedStrategy);
    expect(harness.catalog.revision).toBe(revisionBeforePreview);
    expect(await harness.coordinator.readCatalogSnapshot()).toEqual(catalogBeforePreview);
    expect(harness.coordinator.readProposal("applied-a")).toMatchObject({
      status: "promoted",
    });
    expect(harness.coordinator.readProposal("evaluated-b")).toMatchObject({
      status: "evaluated",
    });
    expect(harness.coordinator.getApplicationState()).toEqual(applicationBeforePreview);
    expect(harness.coordinator.getApplication("applied-a")).toMatchObject({
      afterTarget: { strategyDefinition: strategyA },
    });
  });

  it("binds a preview to its operator without consuming it on an operator mismatch", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(
      harness,
      "operator-bound-preview",
      "operator-bound-preview",
      strategyA,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "operator-bound-preview",
      operator,
    });

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "wrong-preview-operator",
        proposalId: "operator-bound-preview",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator: "different-operator",
        reason: "A different operator cannot reuse approval",
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(harness.strategies.customDefinition("operator-bound-preview")).toBeUndefined();

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "correct-preview-operator",
        proposalId: "operator-bound-preview",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "The approving operator applies the preview",
      }),
    ).resolves.toMatchObject({ applicationStatus: "applied" });
  });

  it("leaves target, catalog, and journal untouched when quiescence is denied", async () => {
    const harness = await createHarness({
      assertQuiescent: () => {
        throw new Error("a workflow is still active");
      },
    });
    await proposeEvaluatedStrategy(
      harness,
      "quiescence-denied",
      "quiescence-denied",
      strategyB,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "quiescence-denied",
      operator,
    });
    const revisionBefore = harness.catalog.revision;

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "quiescence-denied-command",
        proposalId: "quiescence-denied",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Must not apply while a run is active",
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN_CONFLICT" });
    expect(harness.catalog.revision).toBe(revisionBefore);
    expect(harness.coordinator.readProposal("quiescence-denied")).toMatchObject({
      status: "evaluated",
    });
    expect(harness.catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: "quiescence-denied",
    })).toBeNull();
    expect(harness.strategies.customDefinition("quiescence-denied")).toBeUndefined();
    expect(harness.coordinator.getApplicationState()).toEqual({
      revision: 0,
      applications: [],
      pending: null,
      completed: [],
      recoveryRequired: false,
    });
  });
});

describe("EvolutionApplicationCoordinator durable state", () => {
  it("strictly rejects unknown nested fields even when the payload digest is recomputed", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(harness, "strict-state", "strict-state", strategyA);
    await promoteStrategy(
      harness,
      "strict-state",
      "strict-state-command",
      "Generate a valid application document",
    );

    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const validApplicationState = await readFile(applicationPath, "utf8");
    const document = JSON.parse(validApplicationState) as {
      payload: {
        completed: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    document.payload.completed[0]!.unexpectedAuthority = "forged";
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = createLoadedConfig(harness.root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const gitManager = new GitManager(
      harness.root,
      path.join(harness.root, ".agent-team", "worktrees"),
    );
    await expect(
      EvolutionApplicationCoordinator.open({
        catalog,
        strategies,
        git: gitManager,
        loaded,
        assertQuiescent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    await writeFile(applicationPath, validApplicationState, "utf8");
    const repaired = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: gitManager,
      loaded,
      assertQuiescent: () => undefined,
    });
    expect(repaired.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [{ commandId: "strict-state-command", status: "applied" }],
    });
  });

  it("rejects recomputed application and command results that contradict durable witnesses", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(
      harness,
      "semantic-state",
      "semantic-state",
      strategyA,
    );
    await promoteStrategy(
      harness,
      "semantic-state",
      "semantic-state-command",
      "Generate semantic application witnesses",
    );
    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const validApplicationState = await readFile(applicationPath, "utf8");
    const expectRejectedReopen = async (): Promise<void> => {
      const loaded = createLoadedConfig(harness.root);
      await expect(EvolutionApplicationCoordinator.open({
        catalog: await DurableEvolutionCatalog.open(loaded),
        strategies: await StrategyBlueprintCatalog.open(loaded),
        git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
        loaded,
        assertQuiescent: () => undefined,
      })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
    };

    const applicationDocument = JSON.parse(validApplicationState) as {
      payload: {
        applications: Array<{
          beforeTarget: unknown;
          beforeTargetDigest: string | null;
        }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const forgedBeforeDigest = canonicalDigest(strategyB);
    applicationDocument.payload.applications[0]!.beforeTarget = {
      kind: "strategy-blueprint",
      identity: "semantic-state",
      digest: forgedBeforeDigest,
      present: true,
      strategyDefinition: strategyB,
    };
    applicationDocument.payload.applications[0]!.beforeTargetDigest = forgedBeforeDigest;
    applicationDocument.payloadDigest = computePayloadDigest(applicationDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(applicationDocument)}\n`, "utf8");
    await expectRejectedReopen();

    const commandDocument = JSON.parse(validApplicationState) as {
      payload: {
        completed: Array<{
          status: string;
          beforeTargetDigest: string | null;
          afterTargetDigest: string | null;
          catalogRevisionBefore: number;
          catalogRevisionAfter: number;
        }>;
        commands: Array<{
          expectedRevision: number;
          result: {
            proposal: { status: string };
            applicationStatus: string;
            beforeTargetDigest: string | null;
            afterTargetDigest: string | null;
            committedCatalogRevision: number;
          };
        }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const completed = commandDocument.payload.completed[0]!;
    const command = commandDocument.payload.commands[0]!;
    completed.status = "aborted";
    completed.afterTargetDigest = completed.beforeTargetDigest;
    completed.catalogRevisionAfter = completed.catalogRevisionBefore;
    command.result.proposal.status = "evaluated";
    command.result.applicationStatus = "aborted";
    command.result.afterTargetDigest = command.result.beforeTargetDigest;
    command.result.committedCatalogRevision = command.expectedRevision;
    commandDocument.payloadDigest = computePayloadDigest(commandDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(commandDocument)}\n`, "utf8");
    await expectRejectedReopen();

    const proposalDocument = JSON.parse(validApplicationState) as {
      payload: {
        commands: Array<{ result: { proposal: { createdAt: string } } }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    proposalDocument.payload.commands[0]!.result.proposal.createdAt =
      "2020-01-01T00:00:00.000Z";
    proposalDocument.payloadDigest = computePayloadDigest(proposalDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(proposalDocument)}\n`, "utf8");
    await expectRejectedReopen();

    const decisionDocument = JSON.parse(validApplicationState) as {
      payload: {
        applications: Array<{
          operator: string;
          reason: string;
          appliedAt: string;
        }>;
        completed: Array<{
          operator: string;
          reason: string;
          humanDecision: { actor: string; reason: string; decidedAt: string };
        }>;
        commands: Array<{
          operation: string;
          proposalId: string;
          expectedRevision: number;
          previewTokenDigest: string;
          operator: string;
          reason: string;
          materialDigest: string | null;
          requestDigest: string;
        }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const forgedActor = "forged-operator";
    const forgedReason = "Forged decision with internally consistent witnesses";
    const forgedDecidedAt = "2026-08-11T01:30:00.000Z";
    const application = decisionDocument.payload.applications[0]!;
    const decisionCompletion = decisionDocument.payload.completed[0]!;
    const decisionCommand = decisionDocument.payload.commands[0]!;
    application.operator = forgedActor;
    application.reason = forgedReason;
    application.appliedAt = forgedDecidedAt;
    decisionCompletion.operator = forgedActor;
    decisionCompletion.reason = forgedReason;
    decisionCompletion.humanDecision = {
      actor: forgedActor,
      reason: forgedReason,
      decidedAt: forgedDecidedAt,
    };
    decisionCommand.operator = forgedActor;
    decisionCommand.reason = forgedReason;
    decisionCommand.requestDigest = canonicalDigest({
      operation: decisionCommand.operation,
      proposalId: decisionCommand.proposalId,
      expectedRevision: decisionCommand.expectedRevision,
      tokenDigest: decisionCommand.previewTokenDigest,
      operator: forgedActor,
      reason: forgedReason,
      materialDigest: decisionCommand.materialDigest,
    });
    decisionDocument.payloadDigest = computePayloadDigest(decisionDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(decisionDocument)}\n`, "utf8");
    await expectRejectedReopen();
  });

  it("rejects rewriting a historically audited promotion as aborted after rollback", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(
      harness,
      "historical-audit-binding",
      "historical-audit-binding",
      strategyA,
    );
    await promoteStrategy(
      harness,
      "historical-audit-binding",
      "historical-audit-promote-command",
      "Create the catalog promotion audit witness",
    );
    await rollbackStrategy(
      harness,
      "historical-audit-binding",
      "historical-audit-rollback-command",
      "Remove the active application while retaining its history",
    );
    expect(harness.coordinator.getApplication("historical-audit-binding")).toBeUndefined();

    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const document = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: {
        completed: Array<{
          commandId: string;
          status: string;
          beforeTargetDigest: string | null;
          afterTargetDigest: string | null;
          catalogRevisionBefore: number;
          catalogRevisionAfter: number;
          humanDecision: { decidedAt: string };
        }>;
        commands: Array<{
          commandId: string;
          expectedRevision: number;
          result: {
            proposal: { status: string };
            applicationStatus: string;
            beforeTargetDigest: string | null;
            afterTargetDigest: string | null;
            committedCatalogRevision: number;
          };
        }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const completed = document.payload.completed.find(
      (record) => record.commandId === "historical-audit-promote-command",
    );
    const command = document.payload.commands.find(
      (record) => record.commandId === "historical-audit-promote-command",
    );
    if (!completed || !command) throw new Error("Historical promotion witnesses missing");
    completed.status = "aborted";
    completed.afterTargetDigest = completed.beforeTargetDigest;
    completed.catalogRevisionAfter = completed.catalogRevisionBefore;
    completed.humanDecision.decidedAt = "2020-01-01T00:00:00.000Z";
    command.result.proposal.status = "evaluated";
    command.result.applicationStatus = "aborted";
    command.result.afterTargetDigest = command.result.beforeTargetDigest;
    command.result.committedCatalogRevision = command.expectedRevision;
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = createLoadedConfig(harness.root);
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("rejects an orphan synthetic completion with no application or pending owner", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(
      harness,
      "orphan-completion",
      "orphan-completion",
      strategyA,
    );
    await promoteStrategy(
      harness,
      "orphan-completion",
      "orphan-completion-command",
      "Create a valid completion to clone",
    );
    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const document = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: {
        completed: Array<{
          commandId: string;
          operation: string;
          status: string;
          catalogRevisionBefore: number;
          catalogRevisionAfter: number;
        }>;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const orphan = structuredClone(document.payload.completed[0]!);
    orphan.commandId = `legacy:${"a".repeat(64)}`;
    orphan.operation = "reconcile-promoted";
    orphan.status = "adopted";
    orphan.catalogRevisionBefore = orphan.catalogRevisionAfter;
    document.payload.completed.push(orphan);
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = createLoadedConfig(harness.root);
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("reopens an aborted command followed by a successful retry with the same decision tuple", async () => {
    const fixedTime = Date.parse("2026-08-11T02:00:00.000Z");
    const fixedClock: TestClock = {
      now: () => fixedTime,
      advance: () => undefined,
    };
    let crashAfterPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        crashAfterPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        crashAfterPendingRename = false;
        throw new Error("preserve same-decision aborted pending command");
      }
    };
    const harness = await createHarness({ io: { rename: crashRename }, clock: fixedClock });
    await proposeEvaluatedStrategy(
      harness,
      "same-decision-retry",
      "same-decision-retry",
      strategyA,
    );
    const reason = "Retry the same reviewed decision";
    const firstPreview = await harness.coordinator.previewPromotion({
      proposalId: "same-decision-retry",
      operator,
    });
    crashAfterPendingRename = true;
    await expect(harness.coordinator.promoteAndApply({
      commandId: "same-decision-aborted-command",
      proposalId: "same-decision-retry",
      expectedRevision: firstPreview.catalogRevision,
      token: firstPreview.token,
      operator,
      reason,
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const recovered = await createHarness({ root: harness.root, clock: fixedClock });
    expect(recovered.coordinator.getApplicationState()).toMatchObject({
      completed: [{ commandId: "same-decision-aborted-command", status: "aborted" }],
    });
    const retryPreview = await recovered.coordinator.previewPromotion({
      proposalId: "same-decision-retry",
      operator,
    });
    await recovered.coordinator.promoteAndApply({
      commandId: "same-decision-success-command",
      proposalId: "same-decision-retry",
      expectedRevision: retryPreview.catalogRevision,
      token: retryPreview.token,
      operator,
      reason,
    });

    const reopened = await createHarness({ root: harness.root, clock: fixedClock });
    expect(reopened.coordinator.getApplication("same-decision-retry")).toMatchObject({
      status: "applied",
    });
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      completed: [
        { commandId: "same-decision-aborted-command", status: "aborted" },
        { commandId: "same-decision-success-command", status: "applied" },
      ],
    });
  });

  it("does not poison the queue after an atomic persistence failure and can resume after reopen", async () => {
    let failNextRename = false;
    const injectedRename: typeof rename = async (oldPath, newPath) => {
      if (
        failNextRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        failNextRename = false;
        throw new Error("injected application-state rename failure");
      }
      await rename(oldPath, newPath);
    };
    const io: Partial<EvolutionApplicationFileIo> = {
      rename: injectedRename,
    };
    const harness = await createHarness({ io });
    await proposeEvaluatedStrategy(harness, "retry-after-io", "retry-after-io", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "retry-after-io",
      operator,
    });
    failNextRename = true;

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "failed-persist",
        proposalId: "retry-after-io",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Inject persistence failure",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.catalog.getProposal("retry-after-io")).toMatchObject({ status: "evaluated" });
    expect(harness.strategies.customDefinition("retry-after-io")).toBeUndefined();
    await expect(
      harness.coordinator.propose({
        id: "queued-after-failure",
        policy: validPolicy(),
        candidate: strategyCandidate("queued-after-failure", strategyA),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const reopened = await createHarness({ root: harness.root });
    const retriedPreview = await reopened.coordinator.previewPromotion({
      proposalId: "retry-after-io",
      operator,
    });
    await expect(
      reopened.coordinator.promoteAndApply({
        commandId: "retry-after-reopen",
        proposalId: "retry-after-io",
        expectedRevision: retriedPreview.catalogRevision,
        token: retriedPreview.token,
        operator,
        reason: "Retry from a trusted reopen",
      }),
    ).resolves.toMatchObject({ applicationStatus: "applied" });
  });

  it("returns deeply frozen application and state snapshots that cannot mutate internal records", async () => {
    const harness = await createHarness();
    await proposeEvaluatedStrategy(harness, "immutable-reads", "immutable-reads", strategyB);
    await promoteStrategy(
      harness,
      "immutable-reads",
      "immutable-reads-command",
      "Create application proof for isolation checks",
    );

    const application = harness.coordinator.getApplication("immutable-reads");
    if (!application) throw new Error("Application proof missing");
    const state = harness.coordinator.getApplicationState();
    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.afterTarget)).toBe(true);
    expect(Object.isFrozen(application.afterTarget.strategyDefinition)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.applications)).toBe(true);
    expect(Object.isFrozen(state.completed[0])).toBe(true);

    expect(() => {
      (application as { reason: string }).reason = "forged application reason";
    }).toThrow(TypeError);
    expect(() => {
      (application.afterTarget.strategyDefinition as { maxParallel?: number }).maxParallel = 32;
    }).toThrow(TypeError);
    expect(() => {
      (state.applications as unknown[]).pop();
    }).toThrow(TypeError);
    expect(() => {
      (state.completed[0] as { status: string }).status = "aborted";
    }).toThrow(TypeError);

    expect(harness.coordinator.getApplication("immutable-reads")).toMatchObject({
      reason: "Create application proof for isolation checks",
      afterTarget: { strategyDefinition: strategyB },
    });
    expect(harness.coordinator.getApplicationState()).toMatchObject({
      applications: [{ proposalId: "immutable-reads" }],
      completed: [{ commandId: "immutable-reads-command", status: "applied" }],
    });
  });

  it("publishes application state only after rename while queued control reads observe the final revision", async () => {
    let blockNextApplicationRename = false;
    let signalRenameReached!: () => void;
    let releaseRename!: () => void;
    const renameReached = new Promise<void>((resolve) => {
      signalRenameReached = resolve;
    });
    const renameReleased = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const delayedRename: typeof rename = async (oldPath, newPath) => {
      if (
        blockNextApplicationRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        blockNextApplicationRename = false;
        signalRenameReached();
        await renameReleased;
      }
      await rename(oldPath, newPath);
    };
    const harness = await createHarness({ io: { rename: delayedRename } });
    await proposeEvaluatedStrategy(harness, "published-after-rename", "published-after-rename", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "published-after-rename",
      operator,
    });
    blockNextApplicationRename = true;

    const promotion = harness.coordinator.promoteAndApply({
      commandId: "published-after-rename-command",
      proposalId: "published-after-rename",
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Delay pending journal visibility",
    });
    await renameReached;

    expect(harness.coordinator.getApplicationState()).toEqual({
      revision: 0,
      applications: [],
      pending: null,
      completed: [],
      recoveryRequired: false,
    });
    let controlReadResolved = false;
    const queuedControlRead = harness.coordinator.readControlSnapshot().then((snapshot) => {
      controlReadResolved = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(controlReadResolved).toBe(false);

    releaseRename();
    const [result, control] = await Promise.all([promotion, queuedControlRead]);
    expect(result).toMatchObject({
      applicationStatus: "applied",
      committedCatalogRevision: preview.catalogRevision + 1,
    });
    expect(control).toMatchObject({
      catalogRevision: preview.catalogRevision + 1,
      application: {
        revision: 2,
        pending: null,
        recoveryRequired: false,
        applications: [{ proposalId: "published-after-rename" }],
        completed: [{ commandId: "published-after-rename-command", status: "applied" }],
      },
    });
  });
});

describe("EvolutionApplicationCoordinator reconciliation boundaries", () => {
  it("refuses rollback of an adopted root legacy state without predecessor material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-adopt-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const gitManager = new GitManager(root, path.join(root, ".agent-team", "worktrees"));
    const clock = createClock();
    const proposalId = "legacy-adopted-strategy";
    const strategyName = "legacy-adopted-strategy";

    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate(strategyName, strategyB),
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy proposal disappeared before evaluation");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy Phase 2 promotion",
      decidedAt: new Date(clock.now()).toISOString(),
    });
    await strategies.save(strategyName, strategyB, { expectedBefore: null });

    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: gitManager,
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    const catalogRevision = catalog.revision;
    const adopted = await coordinator.reconcilePromoted({
      commandId: "adopt-legacy-strategy-command",
      proposalId,
      expectedRevision: catalogRevision,
      operator,
      reason: "Adopt target already matching the legacy promotion",
      mode: "adopt",
    });
    expect(adopted).toMatchObject({
      applicationStatus: "adopted",
      committedCatalogRevision: catalogRevision,
    });
    expect(coordinator.getApplication(proposalId)).toMatchObject({
      rollbackSafe: false,
      previousApplication: null,
    });
    await expect(
      coordinator.reconcilePromoted({
        commandId: "adopt-legacy-strategy-command",
        proposalId,
        expectedRevision: catalogRevision,
        operator,
        reason: "Adopt target already matching the legacy promotion",
        mode: "adopt",
        promptContent: Buffer.from("content is forbidden on an adopt retry\n", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    await expect(coordinator.previewRollback({
      proposalId,
      operator,
      expectedRevision: catalogRevision,
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(catalog.revision).toBe(catalogRevision);
    expect(catalog.getProposal(proposalId)).toMatchObject({ status: "promoted" });
    expect(catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: strategyName,
    })).toBe(proposalId);
    expect(strategies.customDefinition(strategyName)).toEqual(strategyB);

    const applicationPath = path.join(
      root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const validApplicationState = await readFile(applicationPath, "utf8");
    const materialDocument = JSON.parse(validApplicationState) as {
      payload: {
        applications: Array<Record<string, unknown>>;
        commands: Array<{
          operation: string;
          proposalId: string;
          expectedRevision: number;
          operator: string;
          reason: string;
          previewTokenDigest: string;
          materialDigest: string | null;
          requestDigest: string;
        }>;
      };
      payloadDigest: string;
    };
    const forgedMaterial = materialDocument.payload.commands[0]!;
    forgedMaterial.materialDigest = "a".repeat(64);
    forgedMaterial.requestDigest = canonicalDigest({
      operation: forgedMaterial.operation,
      proposalId: forgedMaterial.proposalId,
      expectedRevision: forgedMaterial.expectedRevision,
      operator: forgedMaterial.operator,
      reason: forgedMaterial.reason,
      mode: "adopt",
      materialDigest: forgedMaterial.materialDigest,
    });
    materialDocument.payloadDigest = computePayloadDigest(materialDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(materialDocument)}\n`, "utf8");
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    const modeDocument = JSON.parse(validApplicationState) as typeof materialDocument;
    const forgedMode = modeDocument.payload.commands[0]!;
    forgedMode.previewTokenDigest = "reconcile:apply";
    forgedMode.requestDigest = canonicalDigest({
      operation: forgedMode.operation,
      proposalId: forgedMode.proposalId,
      expectedRevision: forgedMode.expectedRevision,
      operator: forgedMode.operator,
      reason: forgedMode.reason,
      mode: "apply",
      materialDigest: forgedMode.materialDigest,
    });
    modeDocument.payloadDigest = computePayloadDigest(modeDocument.payload);
    await writeFile(applicationPath, `${JSON.stringify(modeDocument)}\n`, "utf8");
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);

    await writeFile(applicationPath, validApplicationState, "utf8");
    const document = JSON.parse(validApplicationState) as {
      payload: { applications: Array<Record<string, unknown>> };
      payloadDigest: string;
    };
    document.payload.applications[0]!.rollbackSafe = true;
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");
    const reopenedCatalog = await DurableEvolutionCatalog.open(loaded);
    const reopenedStrategies = await StrategyBlueprintCatalog.open(loaded);
    await expect(EvolutionApplicationCoordinator.open({
      catalog: reopenedCatalog,
      strategies: reopenedStrategies,
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("rolls back legacy apply reconciliation to the actual pre-apply target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-legacy-apply-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const gitManager = new GitManager(root, path.join(root, ".agent-team", "worktrees"));
    const clock = createClock();
    const proposalId = "legacy-applied-strategy";
    const strategyName = "legacy-applied-strategy";

    await strategies.save(strategyName, manuallyManagedStrategy, { expectedBefore: null });
    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate(strategyName, strategyB),
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy apply proposal disappeared before evaluation");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy promotion without application proof",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: gitManager,
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    const catalogRevision = catalog.revision;
    const applied = await coordinator.reconcilePromoted({
      commandId: "apply-legacy-strategy-command",
      proposalId,
      expectedRevision: catalogRevision,
      operator,
      reason: "Apply the already-promoted legacy strategy",
      mode: "apply",
    });
    expect(applied).toMatchObject({
      applicationStatus: "applied",
      committedCatalogRevision: catalogRevision,
    });
    expect(strategies.customDefinition(strategyName)).toEqual(strategyB);
    expect(coordinator.getApplication(proposalId)).toMatchObject({
      status: "applied",
      rollbackSafe: true,
      beforeTarget: { strategyDefinition: manuallyManagedStrategy },
    });
    const preview = await coordinator.previewRollback({
      proposalId,
      operator,
      expectedRevision: catalogRevision,
    });
    await expect(coordinator.rollbackAppliedPromotion({
      commandId: "rollback-applied-legacy-strategy-command",
      proposalId,
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Restore the manually managed strategy",
    })).resolves.toMatchObject({
      applicationStatus: "rolled-back",
      proposal: { status: "rolled-back" },
    });
    expect(catalog.revision).toBe(catalogRevision + 1);
    expect(catalog.getProposal(proposalId)).toMatchObject({ status: "rolled-back" });
    expect(catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: strategyName,
    })).toBeNull();
    expect(strategies.customDefinition(strategyName)).toEqual(manuallyManagedStrategy);
    expect(coordinator.getApplication(proposalId)).toBeUndefined();
  });

  it("preserves an existing application predecessor through legacy adopt and rollback", async () => {
    const harness = await createHarness();
    const strategyName = "legacy-adopt-chain";
    await proposeEvaluatedStrategy(harness, "legacy-chain-a", strategyName, strategyA);
    await promoteStrategy(
      harness,
      "legacy-chain-a",
      "promote-legacy-chain-a",
      "Establish the verified predecessor",
    );

    const legacyCatalog = await DurableEvolutionCatalog.open(harness.loaded);
    await legacyCatalog.propose({
      id: "legacy-chain-b",
      createdAt: new Date(harness.clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate(strategyName, strategyB),
    });
    await legacyCatalog.beginEvaluation(
      "legacy-chain-b",
      new Date(harness.clock.now()).toISOString(),
    );
    const evaluating = legacyCatalog.getProposal("legacy-chain-b");
    if (!evaluating) throw new Error("Legacy replacement disappeared before evaluation");
    const evidence = boundEvidence(evaluating);
    await legacyCatalog.evaluate(
      "legacy-chain-b",
      evidence,
      new Date(harness.clock.now()).toISOString(),
    );
    await legacyCatalog.promote("legacy-chain-b", evidence, {
      actor: operator,
      reason: "Legacy replacement outside the application coordinator",
      decidedAt: new Date(harness.clock.now()).toISOString(),
    });
    const legacyStrategies = await StrategyBlueprintCatalog.open(harness.loaded);
    await legacyStrategies.save(strategyName, strategyB, { expectedBefore: strategyA });

    const reopenedCatalog = await DurableEvolutionCatalog.open(harness.loaded);
    const reopenedStrategies = await StrategyBlueprintCatalog.open(harness.loaded);
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog: reopenedCatalog,
      strategies: reopenedStrategies,
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded: harness.loaded,
      assertQuiescent: () => undefined,
      now: harness.clock.now,
    });
    const adopted = await coordinator.reconcilePromoted({
      commandId: "adopt-legacy-chain-b",
      proposalId: "legacy-chain-b",
      expectedRevision: reopenedCatalog.revision,
      operator,
      reason: "Attach the verified predecessor chain",
      mode: "adopt",
    });
    expect(adopted).toMatchObject({ applicationStatus: "adopted" });
    expect(coordinator.getApplication("legacy-chain-b")).toMatchObject({
      rollbackSafe: true,
      previousApplication: {
        proposalId: "legacy-chain-a",
        afterTarget: { strategyDefinition: strategyA },
      },
    });

    const preview = await coordinator.previewRollback({
      proposalId: "legacy-chain-b",
      operator,
      expectedRevision: reopenedCatalog.revision,
    });
    await coordinator.rollbackAppliedPromotion({
      commandId: "rollback-legacy-chain-b",
      proposalId: "legacy-chain-b",
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Restore the verified predecessor",
    });

    expect(reopenedCatalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: strategyName,
    })).toBe("legacy-chain-a");
    expect(reopenedStrategies.customDefinition(strategyName)).toEqual(strategyA);
    expect(coordinator.getApplication("legacy-chain-b")).toBeUndefined();
    expect(coordinator.getApplication("legacy-chain-a")).toMatchObject({
      proposalId: "legacy-chain-a",
      rollbackSafe: true,
    });
  });

  it("rejects legacy reconciliation before it would persist an over-deep history", async () => {
    const harness = await createHarness();
    const strategyName = "bounded-legacy-chain";
    for (let index = 0; index < 100; index += 1) {
      const proposalId = `bounded-chain-${index}`;
      const definition = index % 2 === 0 ? strategyA : strategyB;
      await proposeEvaluatedStrategy(harness, proposalId, strategyName, definition);
      await promoteStrategy(
        harness,
        proposalId,
        `bounded-chain-command-${index}`,
        `Extend bounded application history at step ${index}`,
      );
    }

    const legacyCatalog = await DurableEvolutionCatalog.open(harness.loaded);
    const legacyId = "bounded-chain-legacy-overflow";
    await legacyCatalog.propose({
      id: legacyId,
      createdAt: new Date(harness.clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate(strategyName, strategyA),
    });
    await legacyCatalog.beginEvaluation(legacyId, new Date(harness.clock.now()).toISOString());
    const evaluating = legacyCatalog.getProposal(legacyId);
    if (!evaluating) throw new Error("Legacy overflow proposal disappeared");
    const evidence = boundEvidence(evaluating);
    await legacyCatalog.evaluate(legacyId, evidence, new Date(harness.clock.now()).toISOString());
    await legacyCatalog.promote(legacyId, evidence, {
      actor: operator,
      reason: "Legacy promotion beyond the supported application history",
      decidedAt: new Date(harness.clock.now()).toISOString(),
    });
    const legacyStrategies = await StrategyBlueprintCatalog.open(harness.loaded);
    await legacyStrategies.save(strategyName, strategyA, { expectedBefore: strategyB });

    const reopenedCatalog = await DurableEvolutionCatalog.open(harness.loaded);
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog: reopenedCatalog,
      strategies: await StrategyBlueprintCatalog.open(harness.loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded: harness.loaded,
      assertQuiescent: () => undefined,
      now: harness.clock.now,
    });
    const applicationRevision = coordinator.getApplicationState().revision;
    await expect(coordinator.reconcilePromoted({
      commandId: "bounded-chain-reconcile-overflow",
      proposalId: legacyId,
      expectedRevision: reopenedCatalog.revision,
      operator,
      reason: "This must fail before persisting an unreadable chain",
      mode: "adopt",
    })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(coordinator.getApplicationState()).toMatchObject({
      revision: applicationRevision,
      pending: null,
      recoveryRequired: false,
      applications: [{ proposalId: "bounded-chain-99" }],
    });
    await coordinator.close();

    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const validDocument = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: { applications: Array<Record<string, unknown>> };
      payloadDigest: string;
    };
    const top = validDocument.payload.applications[0]!;
    let tail = top;
    let count = 1;
    while (tail.previousApplication) {
      tail = tail.previousApplication as Record<string, unknown>;
      count += 1;
    }
    expect(count).toBe(100);
    tail.previousApplication = { ...tail, previousApplication: null };
    await writeFile(applicationPath, `${JSON.stringify(validDocument)}\n`, "utf8");
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(harness.loaded),
      strategies: await StrategyBlueprintCatalog.open(harness.loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded: harness.loaded,
      assertQuiescent: () => undefined,
    })).rejects.toThrow("application history is too deep");

    let overDeepJson = "null";
    for (let index = 0; index < 10_000; index += 1) {
      overDeepJson = `{"previousApplication":${overDeepJson}}`;
    }
    validDocument.payload.applications = [];
    const shallowJson = JSON.stringify(validDocument);
    const deepJson = shallowJson.replace(
      '"applications":[]',
      `"applications":[${overDeepJson}]`,
    );
    expect(deepJson).not.toBe(shallowJson);
    await writeFile(applicationPath, `${deepJson}\n`, "utf8");
    const deepFailure = await EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(harness.loaded),
      strategies: await StrategyBlueprintCatalog.open(harness.loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded: harness.loaded,
      assertQuiescent: () => undefined,
    }).catch((error: unknown) => error);
    expect(deepFailure).toBeInstanceOf(EvolutionPersistenceValidationError);
    expect(deepFailure).not.toBeInstanceOf(RangeError);
  }, 90_000);

  it("does not persist drifted live prompt bytes when legacy adopt fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-prompt-drift-adopt-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const clock = createClock();
    const proposalId = "legacy-drifted-prompt";
    const candidate = Buffer.from("Candidate does not match live prompt\n", "utf8");
    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: {
        kind: "role-prompt",
        path: promptPath,
        contentDigest: sha256(candidate),
      },
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy drifted prompt disappeared");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy prompt promotion with a drifted live target",
      decidedAt: new Date(clock.now()).toISOString(),
    });
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    const beforeObjects = await readdir(coordinator.objectsDirectory);
    await expect(coordinator.reconcilePromoted({
      commandId: "legacy-drifted-prompt-adopt",
      proposalId,
      expectedRevision: catalog.revision,
      operator,
      reason: "Reject drift without retaining unrelated live bytes",
      mode: "adopt",
    })).rejects.toMatchObject({ code: "TARGET_DRIFTED" });
    expect(await readdir(coordinator.objectsDirectory)).toEqual(beforeObjects);
  });

  it("rejects a forged adopt-mode pending reconciliation", async () => {
    let failPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        failPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        failPendingRename = false;
        throw new Error("preserve reconcile pending journal");
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-reconcile-pending-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const clock = createClock();
    const proposalId = "legacy-pending-apply";
    await strategies.save(proposalId, manuallyManagedStrategy, { expectedBefore: null });
    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate(proposalId, strategyB),
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy pending proposal disappeared");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy pending promotion",
      decidedAt: new Date(clock.now()).toISOString(),
    });
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
      io: { rename: crashRename },
      now: clock.now,
    });
    failPendingRename = true;
    await expect(coordinator.reconcilePromoted({
      commandId: "legacy-pending-apply-command",
      proposalId,
      expectedRevision: catalog.revision,
      operator,
      reason: "Leave a real apply pending journal",
      mode: "apply",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const applicationPath = path.join(
      root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const document = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: {
        pending: {
          operation: string;
          proposalId: string;
          catalogRevisionBefore: number;
          operator: string;
          reason: string;
          previewTokenDigest: string;
          materialDigest: string | null;
          requestDigest: string;
        };
      };
      payloadDigest: string;
    };
    const pending = document.payload.pending;
    expect(pending.previewTokenDigest).toBe("reconcile:apply");
    pending.previewTokenDigest = "reconcile:adopt";
    pending.requestDigest = canonicalDigest({
      operation: pending.operation,
      proposalId: pending.proposalId,
      expectedRevision: pending.catalogRevisionBefore,
      operator: pending.operator,
      reason: pending.reason,
      mode: "adopt",
      materialDigest: pending.materialDigest,
    });
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("removes an unowned synthetic predecessor when legacy reconcile apply aborts", async () => {
    let crashAfterPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        crashAfterPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        crashAfterPendingRename = false;
        throw new Error("preserve legacy reconcile pending before target apply");
      }
    };
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-reconcile-abort-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const clock = createClock();
    const targetName = "legacy-aborted-synthetic";
    await strategies.save(targetName, strategyA, { expectedBefore: null });

    for (const [proposalId, definition] of [
      ["legacy-aborted-v1", strategyA],
      ["legacy-aborted-v2", strategyB],
    ] as const) {
      await catalog.propose({
        id: proposalId,
        createdAt: new Date(clock.now()).toISOString(),
        policy: validPolicy(),
        candidate: strategyCandidate(targetName, definition),
      });
      await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
      const evaluating = catalog.getProposal(proposalId);
      if (!evaluating) throw new Error(`Legacy proposal '${proposalId}' disappeared`);
      const evidence = boundEvidence(evaluating);
      await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
      await catalog.promote(proposalId, evidence, {
        actor: operator,
        reason: `Legacy promotion for ${proposalId}`,
        decidedAt: new Date(clock.now()).toISOString(),
      });
    }

    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
      io: { rename: crashRename },
      now: clock.now,
    });
    crashAfterPendingRename = true;
    await expect(coordinator.reconcilePromoted({
      commandId: "legacy-aborted-reconcile-command",
      proposalId: "legacy-aborted-v2",
      expectedRevision: catalog.revision,
      operator,
      reason: "Abort before replacing the verified legacy predecessor",
      mode: "apply",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const recovered = await createHarness({ root, clock });
    expect(recovered.strategies.customDefinition(targetName)).toEqual(strategyA);
    expect(recovered.coordinator.getApplicationState()).toMatchObject({
      applications: [],
      pending: null,
      recoveryRequired: false,
      completed: [
        { commandId: "legacy-aborted-reconcile-command", status: "aborted" },
      ],
    });
    const reopenedAgain = await createHarness({ root, clock });
    expect(reopenedAgain.coordinator.getApplicationState()).toMatchObject({
      applications: [],
      pending: null,
      recoveryRequired: false,
      completed: [
        { commandId: "legacy-aborted-reconcile-command", status: "aborted" },
      ],
    });
  });

  it("preserves UTF-8 BOM bytes while adopting and reopening a legacy prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-prompt-bom-"));
    await initializeRepository(root);
    const bomPrompt = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Legacy prompt with BOM\n", "utf8"),
    ]);
    await writeFile(path.join(root, promptPath), bomPrompt);
    await git(root, ["add", promptPath]);
    await git(root, ["commit", "-m", "add legacy BOM prompt"]);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const clock = createClock();
    const proposalId = "legacy-bom-prompt";
    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: {
        kind: "role-prompt",
        path: promptPath,
        contentDigest: sha256(bomPrompt),
      },
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy BOM proposal disappeared");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy BOM prompt promotion",
      decidedAt: new Date(clock.now()).toISOString(),
    });
    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    await coordinator.reconcilePromoted({
      commandId: "legacy-bom-adopt",
      proposalId,
      expectedRevision: catalog.revision,
      operator,
      reason: "Adopt exact BOM-preserving live bytes",
      mode: "adopt",
    });
    await coordinator.close();

    const reopenedCatalog = await DurableEvolutionCatalog.open(loaded);
    const reopened = await EvolutionApplicationCoordinator.open({
      catalog: reopenedCatalog,
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    expect(reopened.getApplication(proposalId)).toMatchObject({
      beforeTargetDigest: sha256(bomPrompt),
      afterTargetDigest: sha256(bomPrompt),
      rollbackSafe: false,
    });
    await expect(readFile(path.join(root, promptPath))).resolves.toEqual(bomPrompt);
  });

  it("binds legacy prompt material content and presence to reconcile command idempotency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-phase3-prompt-reconcile-"));
    await initializeRepository(root);
    const loaded = createLoadedConfig(root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const gitManager = new GitManager(root, path.join(root, ".agent-team", "worktrees"));
    const clock = createClock();
    const proposalId = "legacy-prompt-material-binding";
    const candidateContent = Buffer.from("Legacy prompt material applied by reconcile\n", "utf8");

    await catalog.propose({
      id: proposalId,
      createdAt: new Date(clock.now()).toISOString(),
      policy: validPolicy(),
      candidate: {
        kind: "role-prompt",
        path: promptPath,
        contentDigest: sha256(candidateContent),
      },
    });
    await catalog.beginEvaluation(proposalId, new Date(clock.now()).toISOString());
    const evaluating = catalog.getProposal(proposalId);
    if (!evaluating) throw new Error("Legacy prompt proposal disappeared before evaluation");
    const evidence = boundEvidence(evaluating);
    await catalog.evaluate(proposalId, evidence, new Date(clock.now()).toISOString());
    await catalog.promote(proposalId, evidence, {
      actor: operator,
      reason: "Legacy prompt promotion without stored material",
      decidedAt: new Date(clock.now()).toISOString(),
    });

    const coordinator = await EvolutionApplicationCoordinator.open({
      catalog,
      strategies,
      git: gitManager,
      loaded,
      assertQuiescent: () => undefined,
      now: clock.now,
    });
    const catalogRevision = catalog.revision;
    const commandId = "legacy-prompt-material-command";
    const reason = "Apply explicitly supplied legacy prompt material";
    const first = await coordinator.reconcilePromoted({
      commandId,
      proposalId,
      expectedRevision: catalogRevision,
      operator,
      reason,
      mode: "apply",
      promptContent: candidateContent,
    });
    expect(first).toMatchObject({
      applicationStatus: "applied",
      deduplicated: false,
      committedCatalogRevision: catalogRevision,
    });
    const stateAfterFirst = coordinator.getApplicationState();
    const headAfterFirst = await gitText(root, ["rev-parse", "HEAD"]);

    await expect(
      coordinator.reconcilePromoted({
        commandId,
        proposalId,
        expectedRevision: catalogRevision,
        operator,
        reason,
        mode: "apply",
        promptContent: Buffer.from(candidateContent),
      }),
    ).resolves.toMatchObject({
      applicationStatus: "applied",
      deduplicated: true,
    });
    await expect(
      coordinator.reconcilePromoted({
        commandId,
        proposalId,
        expectedRevision: catalogRevision,
        operator,
        reason,
        mode: "apply",
        promptContent: Buffer.from("different material under the same command id\n", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    await expect(
      coordinator.reconcilePromoted({
        commandId,
        proposalId,
        expectedRevision: catalogRevision,
        operator,
        reason,
        mode: "apply",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });

    expect(await readFile(path.join(root, promptPath))).toEqual(candidateContent);
    expect(await gitText(root, ["rev-parse", "HEAD"])).toBe(headAfterFirst);
    expect(catalog.revision).toBe(catalogRevision);
    expect(coordinator.getApplicationState()).toEqual(stateAfterFirst);
  });
});

describe("EvolutionApplicationCoordinator journal crash recovery", () => {
  it("finalizes old target plus old catalog as an aborted command", async () => {
    let crashAfterPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        crashAfterPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        crashAfterPendingRename = false;
        throw new Error("simulated crash after pending journal rename");
      }
    };
    const harness = await createHarness({ io: { rename: crashRename } });
    await proposeEvaluatedStrategy(harness, "recover-old-old", "recover-old-old", strategyA);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "recover-old-old",
      operator,
    });
    crashAfterPendingRename = true;

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "recover-old-old-command",
        proposalId: "recover-old-old",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Crash before touching the strategy target",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.catalog.getProposal("recover-old-old")).toMatchObject({ status: "evaluated" });
    expect(harness.strategies.customDefinition("recover-old-old")).toBeUndefined();

    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    expect(reopened.coordinator.readProposal("recover-old-old")).toMatchObject({
      status: "evaluated",
    });
    expect(reopened.strategies.customDefinition("recover-old-old")).toBeUndefined();
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [
        {
          commandId: "recover-old-old-command",
          operation: "promote-and-apply",
          status: "aborted",
        },
      ],
    });
  });

  it("finishes the catalog transition for a strategy target that is new while catalog is old", async () => {
    let failNextCatalogWrite = false;
    const catalogIo: Partial<DurableEvolutionFileIo> = {
      beforeAtomicStage: async (stage) => {
        if (failNextCatalogWrite && stage === "write") {
          failNextCatalogWrite = false;
          throw new Error("simulated crash before catalog write");
        }
      },
    };
    const harness = await createHarness({ catalogIo });
    await proposeEvaluatedStrategy(
      harness,
      "recover-new-old",
      "recover-new-old",
      strategyA,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "recover-new-old",
      operator,
    });
    failNextCatalogWrite = true;

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "recover-new-old-command",
        proposalId: "recover-new-old",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Crash after strategy apply and before catalog commit",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.strategies.customDefinition("recover-new-old")).toMatchObject(strategyA);
    expect(harness.catalog.getProposal("recover-new-old")).toMatchObject({ status: "evaluated" });
    expect(harness.coordinator.getApplicationState()).toMatchObject({
      pending: { commandId: "recover-new-old-command" },
      recoveryRequired: false,
    });

    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    expect(reopened.coordinator.readProposal("recover-new-old")).toMatchObject({
      status: "promoted",
    });
    expect(reopened.strategies.customDefinition("recover-new-old")).toMatchObject(strategyA);
    expect(reopened.coordinator.getApplication("recover-new-old")).toMatchObject({
      proposalId: "recover-new-old",
      status: "applied",
    });
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [{ commandId: "recover-new-old-command", status: "applied" }],
    });
  });

  it("finalizes proof when target and catalog are new but the final journal write was lost", async () => {
    let applicationRenameCount = 0;
    const failFinalRename: typeof rename = async (oldPath, newPath) => {
      if (path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME) {
        applicationRenameCount += 1;
        if (applicationRenameCount === 2) {
          throw new Error("simulated crash before final application journal rename");
        }
      }
      await rename(oldPath, newPath);
    };
    const harness = await createHarness({ io: { rename: failFinalRename } });
    await proposeEvaluatedStrategy(harness, "recover-new-new", "recover-new-new", strategyB);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "recover-new-new",
      operator,
    });

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "recover-new-new-command",
        proposalId: "recover-new-new",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Crash after catalog commit and before final proof",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.catalog.getProposal("recover-new-new")).toMatchObject({ status: "promoted" });
    expect(harness.strategies.customDefinition("recover-new-new")).toMatchObject(strategyB);

    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    expect(reopened.coordinator.getApplication("recover-new-new")).toMatchObject({
      proposalId: "recover-new-new",
      status: "applied",
    });
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [{ commandId: "recover-new-new-command", status: "applied" }],
    });
  });

  it("finalizes rollback when the catalog committed but the final journal write was lost", async () => {
    let failRollbackFinal = false;
    let rollbackApplicationRenameCount = 0;
    const failFinalRollbackRename: typeof rename = async (oldPath, newPath) => {
      if (
        failRollbackFinal &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        rollbackApplicationRenameCount += 1;
        if (rollbackApplicationRenameCount === 2) {
          failRollbackFinal = false;
          throw new Error("simulated crash before final rollback journal rename");
        }
      }
      await rename(oldPath, newPath);
    };
    const harness = await createHarness({ io: { rename: failFinalRollbackRename } });
    const targetName = "recover-rollback-new-new";
    await proposeEvaluatedStrategy(harness, "recover-rollback-v1", targetName, strategyA);
    await promoteStrategy(
      harness,
      "recover-rollback-v1",
      "recover-rollback-v1-command",
      "Establish the rollback predecessor",
    );
    await proposeEvaluatedStrategy(harness, "recover-rollback-v2", targetName, strategyB);
    await promoteStrategy(
      harness,
      "recover-rollback-v2",
      "recover-rollback-v2-command",
      "Apply the target that will be interrupted during rollback",
    );
    const preview = await harness.coordinator.previewRollback({
      proposalId: "recover-rollback-v2",
      operator,
    });
    failRollbackFinal = true;

    await expect(harness.coordinator.rollbackAppliedPromotion({
      commandId: "recover-rollback-final-command",
      proposalId: "recover-rollback-v2",
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Crash after rollback audit and before final proof",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.catalog.getProposal("recover-rollback-v2")).toMatchObject({
      status: "rolled-back",
    });
    expect(harness.catalog.getActiveProposalId({
      kind: "strategy-blueprint",
      name: targetName,
    })).toBe("recover-rollback-v1");
    expect(harness.strategies.customDefinition(targetName)).toEqual(strategyA);

    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    expect(reopened.coordinator.getApplication("recover-rollback-v2")).toBeUndefined();
    expect(reopened.coordinator.getApplication("recover-rollback-v1")).toMatchObject({
      proposalId: "recover-rollback-v1",
      status: "applied",
    });
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [
        { commandId: "recover-rollback-v1-command", status: "applied" },
        { commandId: "recover-rollback-v2-command", status: "applied" },
        { commandId: "recover-rollback-final-command", status: "rolled-back" },
      ],
    });
  });

  it("rejects a pending journal whose predecessor keeps its id but changes complete application content", async () => {
    let crashAfterPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        crashAfterPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        crashAfterPendingRename = false;
        throw new Error("preserve pending replacement journal for tampering");
      }
    };
    const harness = await createHarness({ io: { rename: crashRename } });
    const targetName = "tampered-pending-predecessor";
    await proposeEvaluatedStrategy(
      harness,
      "tampered-predecessor-v1",
      targetName,
      strategyA,
    );
    await promoteStrategy(
      harness,
      "tampered-predecessor-v1",
      "tampered-predecessor-v1-command",
      "Establish the authentic predecessor",
    );
    await proposeEvaluatedStrategy(
      harness,
      "tampered-predecessor-v2",
      targetName,
      strategyB,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "tampered-predecessor-v2",
      operator,
    });
    crashAfterPendingRename = true;
    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "tampered-predecessor-v2-command",
        proposalId: "tampered-predecessor-v2",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Leave a replacement pending before target apply",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.strategies.customDefinition(targetName)).toEqual(strategyA);
    expect(harness.catalog.getProposal("tampered-predecessor-v2")).toMatchObject({
      status: "evaluated",
    });

    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const document = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: {
        pending: {
          previousApplication: { proposalId: string; reason: string } | null;
        } | null;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const predecessor = document.payload.pending?.previousApplication;
    expect(predecessor?.proposalId).toBe("tampered-predecessor-v1");
    if (!predecessor) throw new Error("Pending predecessor proof missing");
    predecessor.reason = "forged predecessor content with authentic proposal id";
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = createLoadedConfig(harness.root);
    const catalog = await DurableEvolutionCatalog.open(loaded);
    const strategies = await StrategyBlueprintCatalog.open(loaded);
    const gitManager = new GitManager(
      harness.root,
      path.join(harness.root, ".agent-team", "worktrees"),
    );
    await expect(
      EvolutionApplicationCoordinator.open({
        catalog,
        strategies,
        git: gitManager,
        loaded,
        assertQuiescent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
  });

  it("rejects a pending promotion whose recomputed target plan describes the old live strategy as new", async () => {
    let crashAfterPendingRename = false;
    const crashRename: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (
        crashAfterPendingRename &&
        path.basename(newPath.toString()) === EVOLUTION_APPLICATION_FILENAME
      ) {
        crashAfterPendingRename = false;
        throw new Error("preserve pending target plan for tampering");
      }
    };
    const harness = await createHarness({ io: { rename: crashRename } });
    const targetName = "tampered-pending-target-plan";
    await harness.strategies.save(targetName, strategyA, { expectedBefore: null });
    await proposeEvaluatedStrategy(
      harness,
      "tampered-pending-target-plan-proposal",
      targetName,
      strategyB,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "tampered-pending-target-plan-proposal",
      operator,
    });
    crashAfterPendingRename = true;
    await expect(harness.coordinator.promoteAndApply({
      commandId: "tampered-pending-target-plan-command",
      proposalId: "tampered-pending-target-plan-proposal",
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Leave the authentic old target pending before apply",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.strategies.customDefinition(targetName)).toEqual(strategyA);
    expect(harness.catalog.getProposal("tampered-pending-target-plan-proposal")).toMatchObject({
      status: "evaluated",
    });

    const applicationPath = path.join(
      harness.root,
      ".agent-team",
      "evolution",
      EVOLUTION_APPLICATION_FILENAME,
    );
    const document = JSON.parse(await readFile(applicationPath, "utf8")) as {
      payload: {
        pending: {
          beforeTarget: Record<string, unknown>;
          afterTarget: Record<string, unknown>;
        } | null;
      } & Record<string, unknown>;
      payloadDigest: string;
    };
    const pending = document.payload.pending;
    if (!pending) throw new Error("Pending target plan missing");
    const authenticOldTarget = pending.beforeTarget;
    pending.afterTarget = authenticOldTarget;
    pending.beforeTarget = {
      kind: "strategy-blueprint",
      identity: targetName,
      digest: canonicalDigest(manuallyManagedStrategy),
      present: true,
      strategyDefinition: manuallyManagedStrategy,
    };
    document.payloadDigest = computePayloadDigest(document.payload);
    await writeFile(applicationPath, `${JSON.stringify(document)}\n`, "utf8");

    const loaded = createLoadedConfig(harness.root);
    await expect(EvolutionApplicationCoordinator.open({
      catalog: await DurableEvolutionCatalog.open(loaded),
      strategies: await StrategyBlueprintCatalog.open(loaded),
      git: new GitManager(harness.root, path.join(harness.root, ".agent-team", "worktrees")),
      loaded,
      assertQuiescent: () => undefined,
    })).rejects.toBeInstanceOf(EvolutionPersistenceValidationError);
    expect(harness.catalog.getProposal("tampered-pending-target-plan-proposal")).toMatchObject({
      status: "evaluated",
    });
    expect(harness.strategies.customDefinition(targetName)).toEqual(strategyA);
  });

  it("does not treat an unrelated catalog plus-one revision as the pending promotion", async () => {
    let failNextCatalogWrite = false;
    const harness = await createHarness({
      catalogIo: {
        beforeAtomicStage: async (stage) => {
          if (failNextCatalogWrite && stage === "write") {
            failNextCatalogWrite = false;
            throw new Error("leave target new and catalog old");
          }
        },
      },
    });
    await proposeEvaluatedStrategy(
      harness,
      "reject-unrelated-plus-one",
      "reject-unrelated-plus-one",
      strategyA,
    );
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "reject-unrelated-plus-one",
      operator,
    });
    failNextCatalogWrite = true;
    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "reject-unrelated-plus-one-command",
        proposalId: "reject-unrelated-plus-one",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Leave a pending promotion",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const externalCatalog = await DurableEvolutionCatalog.open(
      createLoadedConfig(harness.root),
    );
    await externalCatalog.propose({
      id: "unrelated-plus-one",
      createdAt: new Date(harness.clock.now() + 60_000).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate("unrelated-plus-one", strategyB),
    });
    expect(externalCatalog.revision).toBe(preview.catalogRevision + 1);

    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    expect(reopened.coordinator.readProposal("reject-unrelated-plus-one")).toMatchObject({
      status: "evaluated",
    });
    expect(reopened.coordinator.getApplication("reject-unrelated-plus-one")).toBeUndefined();
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: { commandId: "reject-unrelated-plus-one-command" },
      recoveryRequired: true,
      completed: [],
    });
    await expect(
      reopened.coordinator.propose({
        id: "must-remain-blocked",
        policy: validPolicy(),
        candidate: strategyCandidate("must-remain-blocked", strategyA),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("deduplicates an earlier completed command exactly while another command is pending recovery", async () => {
    let failNextCatalogWrite = false;
    const harness = await createHarness({
      catalogIo: {
        beforeAtomicStage: async (stage) => {
          if (failNextCatalogWrite && stage === "write") {
            failNextCatalogWrite = false;
            throw new Error("leave second command pending");
          }
        },
      },
    });
    await proposeEvaluatedStrategy(
      harness,
      "completed-before-recovery",
      "completed-before-recovery",
      strategyA,
    );
    const completedReason = "Commit the first command before recovery begins";
    const completed = await promoteStrategy(
      harness,
      "completed-before-recovery",
      "completed-before-recovery-command",
      completedReason,
    );

    await proposeEvaluatedStrategy(
      harness,
      "pending-after-completed",
      "pending-after-completed",
      strategyB,
    );
    const pendingPreview = await harness.coordinator.previewPromotion({
      proposalId: "pending-after-completed",
      operator,
    });
    failNextCatalogWrite = true;
    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "pending-after-completed-command",
        proposalId: "pending-after-completed",
        expectedRevision: pendingPreview.catalogRevision,
        token: pendingPreview.token,
        operator,
        reason: "Leave this second command in recovery",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const externalCatalog = await DurableEvolutionCatalog.open(
      createLoadedConfig(harness.root),
    );
    await externalCatalog.propose({
      id: "unrelated-during-completed-dedupe",
      createdAt: new Date(harness.clock.now() + 60_000).toISOString(),
      policy: validPolicy(),
      candidate: strategyCandidate("unrelated-during-completed-dedupe", strategyA),
    });
    const reopened = await createHarness({ root: harness.root, clock: harness.clock });
    const recoveryState = reopened.coordinator.getApplicationState();
    expect(recoveryState).toMatchObject({
      pending: { commandId: "pending-after-completed-command" },
      recoveryRequired: true,
      completed: [{ commandId: "completed-before-recovery-command", status: "applied" }],
    });

    const deduplicated = await reopened.coordinator.promoteAndApply({
      commandId: "completed-before-recovery-command",
      proposalId: "completed-before-recovery",
      expectedRevision: completed.preview.catalogRevision,
      token: completed.preview.token,
      operator,
      reason: completedReason,
    });
    expect(deduplicated).toMatchObject({
      deduplicated: true,
      committedCatalogRevision: completed.result.committedCatalogRevision,
      applicationStatus: "applied",
      proposal: { id: "completed-before-recovery", status: "promoted" },
    });
    await expect(
      reopened.coordinator.promoteAndApply({
        commandId: "completed-before-recovery-command",
        proposalId: "completed-before-recovery",
        expectedRevision: completed.preview.catalogRevision,
        token: `${completed.preview.token}-different`,
        operator,
        reason: completedReason,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    expect(reopened.coordinator.getApplicationState()).toEqual(recoveryState);
  });

  it("restores prompt bytes when target is new but HEAD never advanced from the authorized base", async () => {
    let failingGit!: FailOnceExactCommitGitManager;
    const harness = await createHarness({
      gitFactory: (root) => {
        failingGit = new FailOnceExactCommitGitManager(
          root,
          path.join(root, ".agent-team", "worktrees"),
        );
        return failingGit;
      },
    });
    const promptAbsolutePath = path.join(harness.root, promptPath);
    await chmod(promptAbsolutePath, 0o666);
    expect((await stat(promptAbsolutePath)).mode & 0o777).toBe(0o666);
    const content = Buffer.from("Prompt written before a simulated Git crash\n", "utf8");
    await proposeEvaluatedPrompt(harness, "recover-prompt-head-base", content);
    const baseHead = await gitText(harness.root, ["rev-parse", "HEAD"]);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "recover-prompt-head-base",
      operator,
    });
    failingGit.failNextExactCommit = true;

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "recover-prompt-head-base-command",
        proposalId: "recover-prompt-head-base",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Crash between prompt rename and exact Git commit",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(promptAbsolutePath)).toEqual(content);
    expect((await stat(promptAbsolutePath)).mode & 0o777).toBe(0o666);
    expect(await gitText(harness.root, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(harness.catalog.getProposal("recover-prompt-head-base")).toMatchObject({
      status: "evaluated",
    });

    const chmodCalls: Array<{ filePath: string; mode: string | number }> = [];
    const trackedChmod: typeof chmod = async (filePath, mode) => {
      chmodCalls.push({ filePath: filePath.toString(), mode });
      await chmod(filePath, mode);
    };
    const reopened = await createHarness({
      root: harness.root,
      clock: harness.clock,
      io: { chmod: trackedChmod },
    });
    expect(await readFile(promptAbsolutePath)).toEqual(originalPrompt);
    expect((await stat(promptAbsolutePath)).mode & 0o777).toBe(0o666);
    expect(chmodCalls).toContainEqual({
      filePath: expect.stringMatching(/\/prompts\/\.worker\.md\.[^.]+\.[^.]+\.recovery\.tmp$/),
      mode: 0o666,
    });
    expect(await gitText(harness.root, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(await reopened.git.isClean(harness.root)).toBe(true);
    expect(reopened.coordinator.readProposal("recover-prompt-head-base")).toMatchObject({
      status: "evaluated",
    });
    expect(reopened.coordinator.getApplication("recover-prompt-head-base")).toBeUndefined();
    expect(reopened.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
      completed: [
        {
          commandId: "recover-prompt-head-base-command",
          status: "aborted",
        },
      ],
    });
  });

  it("prevents a retained catalog handle from mutating after the coordinator claims it", async () => {
    const harness = await createHarness();
    await expect(
      harness.catalog.propose({
        id: "bypass-coordinator",
        createdAt: new Date(harness.clock.now()).toISOString(),
        policy: validPolicy(),
        candidate: strategyCandidate("bypass-coordinator", strategyA),
      }),
    ).rejects.toThrow(/owned by its application coordinator/);
    expect(harness.catalog.revision).toBe(0);
    expect(harness.catalog.getProposal("bypass-coordinator")).toBeUndefined();

    await expect(
      harness.coordinator.propose({
        id: "coordinator-owned",
        policy: validPolicy(),
        candidate: strategyCandidate("coordinator-owned", strategyA),
      }),
    ).resolves.toMatchObject({
      committedRevision: 1,
      proposal: { id: "coordinator-owned", status: "proposed" },
    });
  });
});

describe("EvolutionApplicationCoordinator role-prompt application", () => {
  it("rejects mismatched, invalid UTF-8, and oversized prompt objects before catalog proposal", async () => {
    const harness = await createHarness();
    const validBytes = Buffer.from("candidate\n", "utf8");
    await expect(
      harness.coordinator.propose({
        id: "digest-mismatch",
        policy: validPolicy(),
        candidate: {
          kind: "role-prompt",
          path: promptPath,
          contentDigest: "a".repeat(64),
        },
        promptContent: validBytes,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_MISSING" });

    const invalidUtf8 = Uint8Array.from([0xff]);
    await expect(
      harness.coordinator.propose({
        id: "invalid-utf8",
        policy: validPolicy(),
        candidate: {
          kind: "role-prompt",
          path: promptPath,
          contentDigest: sha256(invalidUtf8),
        },
        promptContent: invalidUtf8,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_MISSING" });

    const oversized = Buffer.alloc(EVOLUTION_PROMPT_MATERIAL_MAX_BYTES + 1, "a");
    await expect(
      harness.coordinator.propose({
        id: "oversized-prompt",
        policy: validPolicy(),
        candidate: {
          kind: "role-prompt",
          path: promptPath,
          contentDigest: sha256(oversized),
        },
        promptContent: oversized,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_MISSING" });

    expect(harness.coordinator.readProposal("digest-mismatch")).toBeUndefined();
    expect(harness.coordinator.readProposal("invalid-utf8")).toBeUndefined();
    expect(harness.coordinator.readProposal("oversized-prompt")).toBeUndefined();
  });

  it("fails closed when an immutable prompt object is corrupted before apply", async () => {
    const harness = await createHarness();
    const content = Buffer.from("Reviewed prompt whose object is later corrupted\n", "utf8");
    await proposeEvaluatedPrompt(harness, "corrupted-object", content);
    const digest = sha256(content);
    await writeFile(path.join(harness.coordinator.objectsDirectory, digest), "corrupt\n", "utf8");
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "corrupted-object",
      operator,
    });

    await expect(
      harness.coordinator.promoteAndApply({
        commandId: "corrupted-object-command",
        proposalId: "corrupted-object",
        expectedRevision: preview.catalogRevision,
        token: preview.token,
        operator,
        reason: "Corrupted objects must never apply",
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_MISSING" });
    expect(await readFile(path.join(harness.root, promptPath))).toEqual(originalPrompt);
    expect(harness.coordinator.readProposal("corrupted-object")).toMatchObject({
      status: "evaluated",
    });
    expect(harness.coordinator.getApplicationState()).toMatchObject({
      pending: null,
      recoveryRequired: false,
    });
  });

  it("uses real exact-path Git commits and preserves prompt permissions across apply and rollback", async () => {
    const harness = await createHarness();
    const content = Buffer.from("Reviewed and approved worker prompt\n", "utf8");
    await proposeEvaluatedPrompt(harness, "prompt-v1", content);
    const headBefore = await gitText(harness.root, ["rev-parse", "HEAD"]);
    const preview = await harness.coordinator.previewPromotion({
      proposalId: "prompt-v1",
      operator,
    });
    const applied = await harness.coordinator.promoteAndApply({
      commandId: "apply-prompt-v1",
      proposalId: "prompt-v1",
      expectedRevision: preview.catalogRevision,
      token: preview.token,
      operator,
      reason: "Apply reviewed prompt",
    });

    const headAfterApply = await gitText(harness.root, ["rev-parse", "HEAD"]);
    expect(headAfterApply).not.toBe(headBefore);
    expect(await readFile(path.join(harness.root, promptPath))).toEqual(content);
    expect((await stat(path.join(harness.root, promptPath))).mode & 0o777).toBe(0o640);
    expect(await changedPaths(harness.root, `${headBefore}..${headAfterApply}`)).toEqual([
      promptPath,
    ]);
    expect(await harness.git.isClean(harness.root)).toBe(true);
    expect(applied).toMatchObject({
      applicationStatus: "applied",
      proposal: { status: "promoted" },
    });

    const rollbackPreview = await harness.coordinator.previewRollback({
      proposalId: "prompt-v1",
      operator,
    });
    const rolledBack = await harness.coordinator.rollbackAppliedPromotion({
      commandId: "rollback-prompt-v1",
      proposalId: "prompt-v1",
      expectedRevision: rollbackPreview.catalogRevision,
      token: rollbackPreview.token,
      operator,
      reason: "Restore the prior prompt",
    });
    const headAfterRollback = await gitText(harness.root, ["rev-parse", "HEAD"]);

    expect(headAfterRollback).not.toBe(headAfterApply);
    expect(await readFile(path.join(harness.root, promptPath))).toEqual(originalPrompt);
    expect((await stat(path.join(harness.root, promptPath))).mode & 0o777).toBe(0o640);
    expect(await changedPaths(harness.root, `${headAfterApply}..${headAfterRollback}`)).toEqual([
      promptPath,
    ]);
    expect(await harness.git.isClean(harness.root)).toBe(true);
    expect(rolledBack).toMatchObject({
      applicationStatus: "rolled-back",
      proposal: { status: "rolled-back" },
    });
  });
});

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalDigest(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

async function changedPaths(root: string, range: string): Promise<string[]> {
  const output = await gitText(root, ["diff", "--name-only", "-z", range]);
  return output.split("\0").filter(Boolean);
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await git(root, args)).stdout.trim();
}

async function git(root: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result;
}
