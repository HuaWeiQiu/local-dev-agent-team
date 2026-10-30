import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { selectExperiences, type RepoTrace } from "../domain/repo-tree.js";
import { computeSuiteDigest, resolveEvaluationSuite } from "../evaluation/index.js";
import type { RunState } from "../state/types.js";
import { AttemptLog, signatureFromFeedback, type AttemptCard } from "./attempt-log.js";
import {
  ExperienceCatalog,
  type ExperienceEntry,
  type ExperienceStatus,
  type ExtractExperienceInput,
} from "./catalog.js";
import { extractCandidatesFromRun } from "./extract.js";
import {
  projectExperienceCatalogPath,
  sharedExperienceCatalogPath,
} from "./paths.js";
import { parseReasoningBank, toExperienceEntries } from "./reasoning-bank.js";
import { StrategyHintStore, type StrategyHint } from "./strategy-hints.js";

export interface ExperiencePlanningBundle {
  note: string;
  items: Array<{
    id: string;
    summary: string;
    conditions: string[];
    tags: string[];
    scope: "project" | "shared";
    hitCount: number;
    citations?: Array<{ nodeId: string; path: string }>;
  }>;
  strategyHints?: StrategyHint[];
  recentAttempts?: AttemptCard[];
}

export interface ExperienceSnapshot {
  project: string;
  projectPath: string;
  sharedPath: string;
  enabled: boolean;
  injectIntoPlanning: boolean;
  injectIntoRework: boolean;
  extractOnTerminal: boolean;
  requireSuiteForPromote: boolean;
  autoPromoteWithSuite: boolean;
  recordAttemptCards: boolean;
  writeStrategyHints: boolean;
  counts: {
    project: number;
    shared: number;
    verified: number;
    candidate: number;
  };
  entries: ExperienceEntry[];
}

export interface PromoteExperienceOptions {
  suiteDigest?: string;
  forceWithoutSuite?: boolean;
}

export class ExperienceService {
  constructor(
    private readonly project: ExperienceCatalog,
    private readonly shared: ExperienceCatalog,
    private readonly projectName: string,
    private readonly stateRoot: string,
    private readonly loaded: LoadedConfig,
    private readonly options: {
      enabled: boolean;
      injectIntoPlanning: boolean;
      injectIntoRework: boolean;
      extractOnTerminal: boolean;
      maxInjected: number;
      requireSuiteForPromote: boolean;
      autoPromoteWithSuite: boolean;
      recordAttemptCards: boolean;
      writeStrategyHints: boolean;
    },
  ) {}

  static forLoaded(loaded: LoadedConfig, env: NodeJS.ProcessEnv = process.env): ExperienceService {
    const stateRoot = path.resolve(loaded.root, loaded.config.project.stateDirectory);
    const experience = loaded.config.experience;
    const project = new ExperienceCatalog(projectExperienceCatalogPath(stateRoot));
    const shared = new ExperienceCatalog(
      sharedExperienceCatalogPath(env, experience.sharedDirectory),
    );
    return new ExperienceService(project, shared, loaded.config.project.name, stateRoot, loaded, {
      enabled: experience.enabled,
      injectIntoPlanning: experience.injectIntoPlanning,
      injectIntoRework: experience.injectIntoRework,
      extractOnTerminal: experience.extractOnTerminal,
      maxInjected: experience.maxInjected,
      requireSuiteForPromote: experience.requireSuiteForPromote,
      autoPromoteWithSuite: experience.autoPromoteWithSuite,
      recordAttemptCards: experience.recordAttemptCards,
      writeStrategyHints: experience.writeStrategyHints,
    });
  }

  async snapshot(status?: ExperienceStatus): Promise<ExperienceSnapshot> {
    const projectEntries = await this.project.list(status);
    const sharedEntries = (await this.shared.list(status)).map((entry) => ({
      ...entry,
      scope: "shared" as const,
    }));
    const entries = [...projectEntries, ...sharedEntries].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const allProject = status ? projectEntries : await this.project.list();
    const allShared = status ? sharedEntries : await this.shared.list();
    const combined = [...allProject, ...allShared];
    return {
      project: this.projectName,
      projectPath: this.project.path,
      sharedPath: this.shared.path,
      enabled: this.options.enabled,
      injectIntoPlanning: this.options.injectIntoPlanning,
      injectIntoRework: this.options.injectIntoRework,
      extractOnTerminal: this.options.extractOnTerminal,
      requireSuiteForPromote: this.options.requireSuiteForPromote,
      autoPromoteWithSuite: this.options.autoPromoteWithSuite,
      recordAttemptCards: this.options.recordAttemptCards,
      writeStrategyHints: this.options.writeStrategyHints,
      counts: {
        project: allProject.length,
        shared: allShared.length,
        verified: combined.filter((entry) => entry.status === "verified").length,
        candidate: combined.filter((entry) => entry.status === "candidate").length,
      },
      entries,
    };
  }

  async extractFromRun(state: RunState): Promise<{
    created: ExperienceEntry[];
    autoPromoted: ExperienceEntry[];
  }> {
    if (!this.options.enabled || !this.options.extractOnTerminal) {
      return { created: [], autoPromoted: [] };
    }
    const suiteDigest = await this.activeSuiteDigest();
    const inputs = withSuiteDigest(extractCandidatesFromRun(state, this.projectName), state, suiteDigest);
    const created = await this.persistCandidates(inputs);
    const autoPromoted = await this.autoPromoteWithSuite(state, created, suiteDigest);
    return { created, autoPromoted };
  }

  private async activeSuiteDigest(): Promise<string | undefined> {
    const suite = await resolveEvaluationSuite(this.loaded.config, this.loaded.root);
    return suite ? computeSuiteDigest(suite) : undefined;
  }

  /** Store candidates, skipping anything this run already produced. */
  private async persistCandidates(inputs: ExtractExperienceInput[]): Promise<ExperienceEntry[]> {
    const existing = await this.project.list();
    const created: ExperienceEntry[] = [];
    for (const input of inputs) {
      const duplicate = existing.some(
        (entry) =>
          entry.sourceRunId === input.sourceRunId &&
          entry.summary === input.summary.trim(),
      );
      if (duplicate) continue;
      const entry = await this.project.extract({
        ...input,
        sourceProjectId: this.projectName,
        scope: "project",
      });
      existing.push(entry);
      created.push(entry);
    }
    return created;
  }

  /**
   * Promote low-sensitivity success candidates when a suite digest is bound.
   * Only `completed` runs qualify: a run parked at `ready-to-merge` has not been
   * published, so its pattern is evidence but not suite-verified.
   */
  private async autoPromoteWithSuite(
    state: RunState,
    created: ExperienceEntry[],
    suiteDigest: string | undefined,
  ): Promise<ExperienceEntry[]> {
    if (!this.options.autoPromoteWithSuite || !suiteDigest) return [];
    if (state.status !== "completed" || created.length === 0) return [];

    const promoted: ExperienceEntry[] = [];
    for (const entry of created) {
      const result = await this.promoteSuccess(entry, suiteDigest);
      if (result) promoted.push(result);
    }
    return promoted;
  }

  /** Promote one candidate; a rejection or a failed write leaves it as a candidate. */
  private async promoteSuccess(
    entry: ExperienceEntry,
    suiteDigest: string,
  ): Promise<ExperienceEntry | undefined> {
    if (!isPromotableSuccess(entry)) return undefined;
    try {
      const result = await this.project.promote(
        entry.id,
        "system:auto-promote-suite",
        "评测套件 digest 已绑定，自动晋升低敏成功经验",
        { suiteDigest },
      );
      if (this.options.writeStrategyHints) {
        await new StrategyHintStore(
          StrategyHintStore.pathFor(this.stateRoot),
        ).maybeRecordFromExperience(result);
      }
      return result;
    } catch {
      return undefined;
    }
  }

  /**
   * Import curated `agent-memory/reasoning-bank.md` entries as candidates.
   *
   * This is where the second memory path finally lands in the same store the
   * orchestrator retrieves from. Candidates are never injected: an operator (or
   * the evaluation-digest path) still has to promote them.
   */
  async importReasoningBank(
    options: {
      filePath?: string;
      actor?: string;
      reason?: string;
      dryRun?: boolean;
    } = {},
  ): Promise<{
    filePath: string;
    parsed: number;
    imported: number;
    added: ExperienceEntry[];
    unchanged: ExperienceEntry[];
  }> {
    const filePath = path.resolve(
      options.filePath ?? path.join(this.loaded.root, "agent-memory", "reasoning-bank.md"),
    );
    const markdown = await readFile(filePath, "utf8");
    const sourcePath = path.relative(this.loaded.root, filePath) || filePath;
    const now = new Date().toISOString();
    const parsed = parseReasoningBank(markdown);
    const items = toExperienceEntries(parsed, {
      project: this.projectName,
      sourcePath,
      now,
    });
    const { added, unchanged } = await this.project.importCandidates(
      items,
      importMeta(options, items.length, sourcePath),
    );
    return {
      filePath,
      parsed: parsed.length,
      imported: items.length,
      added,
      unchanged,
    };
  }

  async recordAttempt(input: {
    runId: string;
    taskId: string;
    taskTitle: string;
    attempt: number;
    feedback: string;
  }): Promise<AttemptCard | undefined> {
    if (!this.options.enabled || !this.options.recordAttemptCards) return undefined;
    if (!input.feedback.trim()) return undefined;
    const card: AttemptCard = {
      runId: input.runId,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      attempt: input.attempt,
      feedback: input.feedback.replace(/\s+/g, " ").trim().slice(0, 500),
      signature: signatureFromFeedback(input.feedback),
      at: new Date().toISOString(),
    };
    await new AttemptLog(AttemptLog.pathFor(this.stateRoot)).append(card);
    return card;
  }

  async promote(
    experienceId: string,
    actor: string,
    reason: string,
    options: PromoteExperienceOptions = {},
  ): Promise<ExperienceEntry> {
    if (this.options.requireSuiteForPromote) {
      const hasSuite = Boolean(options.suiteDigest);
      if (!hasSuite && !options.forceWithoutSuite) {
        throw new Error(
          "晋升需要评测 suiteDigest，或显式 forceWithoutSuite（experience.requireSuiteForPromote=true）",
        );
      }
    }
    const promoted = await this.project.promote(experienceId, actor, reason, {
      ...(options.suiteDigest ? { suiteDigest: options.suiteDigest } : {}),
    });
    if (this.options.writeStrategyHints) {
      await new StrategyHintStore(StrategyHintStore.pathFor(this.stateRoot)).maybeRecordFromExperience(
        promoted,
      );
    }
    return promoted;
  }

  async reject(experienceId: string, actor: string, reason: string): Promise<ExperienceEntry> {
    if (await this.shared.has(experienceId)) {
      return this.shared.reject(experienceId, actor, reason);
    }
    return this.project.reject(experienceId, actor, reason);
  }

  async retire(experienceId: string, actor: string, reason: string): Promise<ExperienceEntry> {
    if (await this.shared.has(experienceId)) {
      return this.shared.retire(experienceId, actor, reason);
    }
    return this.project.retire(experienceId, actor, reason);
  }

  async share(experienceId: string, actor: string, reason: string): Promise<ExperienceEntry> {
    const entry = (await this.project.list()).find((item) => item.id === experienceId);
    if (!entry) {
      throw new Error(`Unknown project experience id '${experienceId}'`);
    }
    if (entry.status !== "verified") {
      throw new Error("Only verified experiences can be shared across projects");
    }
    if (entry.sensitivity !== "low") {
      throw new Error("Only low-sensitivity experiences can enter the shared catalog");
    }
    if (entry.portability !== "cross-project") {
      throw new Error("Experience is marked project-bound and cannot be shared");
    }
    return this.shared.importVerified({
      ...entry,
      project: this.projectName,
      sourceProjectId: this.projectName,
      scope: "shared",
      portability: "cross-project",
      actor,
      reason,
    });
  }

  async retrieveForPlanning(
    goal: string,
    options: { preview?: boolean; trace?: RepoTrace } = {},
  ): Promise<ExperiencePlanningBundle | undefined> {
    if (!this.options.enabled || !this.options.injectIntoPlanning) return undefined;
    const bundle = await this.retrieveVerifiedBundle(
      goal,
      "planning",
      this.options.maxInjected,
      options.preview === true,
      options.trace,
    );
    const hints = await this.strategyHints();
    return planningBundle(bundle, hints);
  }

  private async strategyHints(): Promise<StrategyHint[]> {
    if (!this.options.writeStrategyHints) return [];
    const store = new StrategyHintStore(StrategyHintStore.pathFor(this.stateRoot));
    return (await store.list()).slice(0, 8);
  }

  async recordSuccess(experienceIds: string[]): Promise<number> {
    if (!this.options.enabled || experienceIds.length === 0) return 0;
    const projectHits = await this.project.recordSuccess(experienceIds);
    const sharedHits = await this.shared.recordSuccess(experienceIds);
    return projectHits + sharedHits;
  }

  async retrieveForRework(input: {
    feedback: string;
    taskTitle?: string;
    taskId?: string;
    limit?: number;
    trace?: RepoTrace;
  }): Promise<ExperiencePlanningBundle | undefined> {
    if (!this.options.enabled || !this.options.injectIntoRework) return undefined;
    const limit = Math.min(input.limit ?? 5, this.options.maxInjected || 5);
    const bundle = await this.retrieveVerifiedBundle(
      reworkQuery(input),
      "rework",
      limit,
      false,
      input.trace,
    );
    const recentAttempts = await this.recentAttempts(input);
    return reworkBundle(bundle, recentAttempts);
  }

  private async recentAttempts(input: {
    feedback: string;
    taskId?: string;
  }): Promise<AttemptCard[]> {
    if (!this.options.recordAttemptCards) return [];
    const log = new AttemptLog(AttemptLog.pathFor(this.stateRoot));
    return log.recentMatching({
      feedback: input.feedback,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      limit: 5,
    });
  }

  private async retrieveVerifiedBundle(
    query: string,
    purpose: "planning" | "rework",
    limit: number,
    preview = false,
    trace?: RepoTrace,
  ): Promise<ExperiencePlanningBundle | undefined> {
    if (limit <= 0) return undefined;
    const actor = purpose === "rework" ? "system:rework" : "system:planning";
    const reason =
      purpose === "rework"
        ? "Inject verified experiences into worker rework context"
        : "Inject verified experiences into planning context";

    const cited = await this.retrieveCited(trace, limit, preview, actor, reason);
    if (cited) return cited;

    const shared = await this.shared.retrieveVerified({
      actor,
      reason,
      query,
      limit,
      recordHit: !preview,
    });
    const remaining = Math.max(0, limit - shared.length);
    const project =
      remaining > 0
        ? await this.project.retrieveVerified({
            actor,
            reason,
            query,
            limit: remaining,
            recordHit: !preview,
          })
        : [];

    const items = [
      ...shared.map((entry) => toPlanningItem(entry, "shared")),
      ...project.map((entry) => toPlanningItem(entry, "project")),
    ];
    if (items.length === 0) return undefined;
    return {
      note: "仅已验证经验。条件匹配时优先参考；不得当作密钥、客户代码或隐藏答案。",
      items,
    };
  }

  /** Path citations outrank token overlap. No citation keeps the existing token retrieval. */
  private async retrieveCited(
    trace: RepoTrace | undefined,
    limit: number,
    preview: boolean,
    actor: string,
    reason: string,
  ): Promise<ExperiencePlanningBundle | undefined> {
    if (!trace?.matched) return undefined;
    const shared = (await this.shared.list("verified")).map((entry) => ({ ...entry, scope: "shared" as const }));
    const project = (await this.project.list("verified")).map((entry) => ({ ...entry, scope: "project" as const }));
    const ranked = selectExperiences([...shared, ...project], trace, limit);
    if (ranked.length === 0) return undefined;
    if (!preview) {
      await this.shared.recordRetrieval(
        ranked.filter((item) => item.entry.scope === "shared").map((item) => item.entry.id),
        actor,
        reason,
      );
      await this.project.recordRetrieval(
        ranked.filter((item) => item.entry.scope === "project").map((item) => item.entry.id),
        actor,
        reason,
      );
    }
    return {
      note: "仅已验证经验，并按本次目标命中的仓库路径排序。条件匹配时优先参考；不得当作密钥、客户代码或隐藏答案。",
      items: ranked.map((item) =>
        toPlanningItem(
          preview ? item.entry : { ...item.entry, hitCount: item.entry.hitCount + 1 },
          item.entry.scope,
          item.citations,
        ),
      ),
    };
  }
}

function toPlanningItem(
  entry: ExperienceEntry,
  scope: "project" | "shared",
  citations?: Array<{ nodeId: string; path: string }>,
): ExperiencePlanningBundle["items"][number] {
  return {
    id: entry.id,
    summary: entry.summary,
    conditions: entry.conditions,
    tags: entry.tags,
    scope,
    hitCount: entry.hitCount,
    ...(citations && citations.length > 0 ? { citations } : {}),
  };
}

/** Bind the evaluation-suite digest to candidates only where it is evidence. */
function withSuiteDigest(
  inputs: ExtractExperienceInput[],
  state: RunState,
  suiteDigest: string | undefined,
): ExtractExperienceInput[] {
  if (!suiteDigest) return inputs;
  const bound = state.status === "completed" || state.purpose === "evolution-evaluation";
  return bound ? inputs.map((input) => ({ ...input, suiteDigest })) : inputs;
}

function isPromotableSuccess(entry: ExperienceEntry): boolean {
  if (entry.sensitivity !== "low") return false;
  return entry.tags.some((tag) => tag === "成功" || tag === "评测");
}

/** Rework retrieval query: the failure signal first, capped for the catalog search. */
function reworkQuery(input: { feedback: string; taskTitle?: string; taskId?: string }): string {
  return [input.feedback, input.taskTitle, input.taskId, "失败", "返工"]
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

/** Planning bundle assembled from verified experience and strategy hints. */
function planningBundle(
  bundle: ExperiencePlanningBundle | undefined,
  hints: StrategyHint[],
): ExperiencePlanningBundle | undefined {
  if (!bundle && hints.length === 0) return undefined;
  return {
    note: bundle?.note ?? "策略提示来自已验证经验。",
    items: bundle?.items ?? [],
    ...(hints.length > 0 ? { strategyHints: hints } : {}),
  };
}

/** Rework bundle assembled from verified experience and recent attempt cards. */
function reworkBundle(
  bundle: ExperiencePlanningBundle | undefined,
  recentAttempts: AttemptCard[],
): ExperiencePlanningBundle | undefined {
  if (!bundle && recentAttempts.length === 0) return undefined;
  return {
    note: "返工参考：已验证经验 + 近期同类 attempt。优先修同类问题。",
    items: bundle?.items ?? [],
    ...(recentAttempts.length > 0 ? { recentAttempts } : {}),
  };
}

/** Audit metadata for a reasoning-bank import. */
function importMeta(
  options: { actor?: string; reason?: string; dryRun?: boolean },
  count: number,
  sourcePath: string,
): { actor: string; reason: string; dryRun?: boolean } {
  const noun = count === 1 ? "entry" : "entries";
  return {
    actor: options.actor ?? "operator",
    reason: options.reason ?? `Imported ${count} curated ${noun} from ${sourcePath}`,
    ...(options.dryRun ? { dryRun: true } : {}),
  };
}
