import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LoadedConfig } from "../config/load.js";
import {
  configSchema,
  namedStrategySchema,
  type AgentTeamConfig,
  type NamedStrategy,
} from "../config/schema.js";
import { resolveStrategy, type ResolvedStrategy } from "./resolve.js";

export const strategyBlueprintNameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "Strategy name must be 1-64 letters, numbers, dots, underscores, or hyphens",
  );

const persistedBlueprintsSchema = z.object({
  version: z.literal(1),
  definitions: z.record(strategyBlueprintNameSchema, namedStrategySchema),
});

export interface CheckedStrategyBlueprint {
  name: string;
  definition: NamedStrategy;
  resolved: ResolvedStrategy;
}

export class StrategyBlueprintConflictError extends Error {}
export class StrategyBlueprintNotFoundError extends Error {}
export class StrategyBlueprintValidationError extends Error {}

export class StrategyBlueprintCatalog {
  readonly loaded: LoadedConfig;
  readonly filePath: string;
  private readonly baseDefinitions: Record<string, NamedStrategy>;
  private readonly baseNames: Set<string>;
  private readonly defaultName: string;
  private customDefinitions: Record<string, NamedStrategy> = {};
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(loaded: LoadedConfig) {
    const config = structuredClone(loaded.config);
    const baseline = config.strategies ?? legacyStrategies(config);
    this.baseDefinitions = structuredClone(baseline.definitions);
    this.baseNames = new Set(Object.keys(this.baseDefinitions));
    this.defaultName = baseline.default;
    this.loaded = {
      ...loaded,
      config: {
        ...config,
        strategies: {
          default: this.defaultName,
          definitions: { ...this.baseDefinitions },
        },
      },
    };
    this.filePath = path.resolve(
      loaded.root,
      loaded.config.project.stateDirectory,
      "strategy-blueprints.json",
    );
  }

  static async open(loaded: LoadedConfig): Promise<StrategyBlueprintCatalog> {
    const catalog = new StrategyBlueprintCatalog(loaded);
    await catalog.load();
    return catalog;
  }

  source(name: string): "config" | "custom" {
    return Object.hasOwn(this.customDefinitions, name) ? "custom" : "config";
  }

  customNames(): string[] {
    return Object.keys(this.customDefinitions).sort();
  }

  preflight(nameInput: string, definitionInput: unknown): CheckedStrategyBlueprint {
    const name = parseName(nameInput);
    const definitionResult = namedStrategySchema.safeParse(definitionInput);
    if (!definitionResult.success) {
      throw validationError(name, definitionResult.error.issues);
    }

    const candidate = structuredClone(this.loaded.config);
    candidate.strategies = {
      default: this.defaultName,
      definitions: {
        ...this.baseDefinitions,
        ...this.customDefinitions,
        [name]: definitionResult.data,
      },
    };
    const configResult = configSchema.safeParse(candidate);
    if (!configResult.success) {
      throw validationError(name, configResult.error.issues);
    }
    const definition = configResult.data.strategies!.definitions[name]!;
    return {
      name,
      definition,
      resolved: resolveStrategy(configResult.data, name),
    };
  }

  async save(nameInput: string, definitionInput: unknown): Promise<CheckedStrategyBlueprint> {
    return await this.enqueue(async () => {
      const name = parseName(nameInput);
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Configured strategy '${name}' is read-only; save the blueprint under a new name`,
        );
      }
      const checked = this.preflight(name, definitionInput);
      const next = { ...this.customDefinitions, [name]: checked.definition };
      await this.persist(next);
      this.customDefinitions = next;
      this.refreshEffectiveConfig();
      return checked;
    });
  }

  async delete(nameInput: string): Promise<void> {
    await this.enqueue(async () => {
      const name = parseName(nameInput);
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Configured strategy '${name}' cannot be deleted from the control plane`,
        );
      }
      if (!Object.hasOwn(this.customDefinitions, name)) {
        throw new StrategyBlueprintNotFoundError(`Strategy blueprint '${name}' was not found`);
      }
      const next = { ...this.customDefinitions };
      delete next[name];
      await this.persist(next);
      this.customDefinitions = next;
      this.refreshEffectiveConfig();
    });
  }

  private async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(contents) as unknown;
    } catch {
      throw new StrategyBlueprintValidationError(
        `Invalid strategy blueprint catalog at ${this.filePath}: expected JSON`,
      );
    }
    const parsed = persistedBlueprintsSchema.safeParse(document);
    if (!parsed.success) {
      throw new StrategyBlueprintValidationError(
        `Invalid strategy blueprint catalog at ${this.filePath}:\n${formatIssues(parsed.error.issues)}`,
      );
    }
    for (const name of Object.keys(parsed.data.definitions)) {
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Custom strategy '${name}' conflicts with a configured strategy`,
        );
      }
    }
    this.customDefinitions = parsed.data.definitions;
    const effective = configSchema.safeParse({
      ...this.loaded.config,
      strategies: {
        default: this.defaultName,
        definitions: { ...this.baseDefinitions, ...this.customDefinitions },
      },
    });
    if (!effective.success) {
      throw new StrategyBlueprintValidationError(
        `Invalid strategy blueprint catalog at ${this.filePath}:\n${formatIssues(effective.error.issues)}`,
      );
    }
    this.loaded.config = effective.data;
  }

  private refreshEffectiveConfig(): void {
    this.loaded.config.strategies = {
      default: this.defaultName,
      definitions: { ...this.baseDefinitions, ...this.customDefinitions },
    };
  }

  private async persist(definitions: Record<string, NamedStrategy>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, definitions }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function legacyStrategies(config: AgentTeamConfig): NonNullable<AgentTeamConfig["strategies"]> {
  return {
    default: "legacy",
    definitions: {
      legacy: {
        topology: { mode: "parallel-dag" },
        maxParallel: config.project.maxParallel,
        maxReworkAttempts: config.quality.maxReworkAttempts,
        executionTimeoutSeconds: 14_400,
        maxAgentInvocations: 64,
        maxProcessOutputBytes: 1_048_576,
        maxArtifactBytes: 1_073_741_824,
        roleProfiles: {},
        approvalGates: ["final"],
        approvalTimeoutSeconds: 86_400,
      },
    },
  };
}

function parseName(input: string): string {
  const result = strategyBlueprintNameSchema.safeParse(input);
  if (!result.success) {
    throw new StrategyBlueprintValidationError(result.error.issues[0]?.message ?? "Invalid strategy name");
  }
  return result.data;
}

function validationError(name: string, issues: z.core.$ZodIssue[]): StrategyBlueprintValidationError {
  return new StrategyBlueprintValidationError(
    `Invalid strategy blueprint '${name}':\n${formatIssues(issues)}`,
  );
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "strategy"}: ${issue.message}`)
    .join("\n");
}
