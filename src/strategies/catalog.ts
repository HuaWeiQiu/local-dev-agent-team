import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open as openAsync,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LoadedConfig } from "../config/load.js";
import {
  configSchema,
  namedStrategySchema,
  type AgentTeamConfig,
  type NamedStrategy,
} from "../config/schema.js";
import {
  legacyApprovalTimeoutSeconds,
  legacyExecutionTimeoutSeconds,
  legacyMaxAgentInvocations,
  legacyMaxArtifactBytes,
  legacyMaxProcessOutputBytes,
} from "./defaults.js";
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

/** Stable structured codes for future HTTP mapping. */
export type StrategyBlueprintErrorCode =
  | "STRATEGY_BLUEPRINT_CONFLICT"
  | "STRATEGY_BLUEPRINT_NOT_FOUND"
  | "STRATEGY_BLUEPRINT_VALIDATION"
  | "STRATEGY_BLUEPRINT_DRIFT"
  | "STRATEGY_BLUEPRINT_UNSAFE_PATH"
  | "STRATEGY_BLUEPRINT_INDETERMINATE";

export class StrategyBlueprintError extends Error {
  readonly code: StrategyBlueprintErrorCode;

  constructor(code: StrategyBlueprintErrorCode, message: string) {
    super(message);
    this.name = "StrategyBlueprintError";
    this.code = code;
  }
}

export class StrategyBlueprintConflictError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_CONFLICT", message);
    this.name = "StrategyBlueprintConflictError";
  }
}

export class StrategyBlueprintNotFoundError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_NOT_FOUND", message);
    this.name = "StrategyBlueprintNotFoundError";
  }
}

export class StrategyBlueprintValidationError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_VALIDATION", message);
    this.name = "StrategyBlueprintValidationError";
  }
}

export class StrategyBlueprintDriftError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_DRIFT", message);
    this.name = "StrategyBlueprintDriftError";
  }
}

export class StrategyBlueprintUnsafePathError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_UNSAFE_PATH", message);
    this.name = "StrategyBlueprintUnsafePathError";
  }
}

export class StrategyBlueprintIndeterminateError extends StrategyBlueprintError {
  constructor(message: string) {
    super("STRATEGY_BLUEPRINT_INDETERMINATE", message);
    this.name = "StrategyBlueprintIndeterminateError";
  }
}

/**
 * Optional expected-before snapshot for conditional mutations.
 * - `null`: custom definition must currently be absent
 * - definition: custom definition must deep-equal this value
 * - omitted: unconditional mutation (legacy control-plane behavior)
 */
export type StrategyBlueprintExpectedBefore = NamedStrategy | null;

export type StrategyBlueprintFileIo = {
  mkdir: typeof mkdir;
  lstat: typeof lstat;
  readdir: typeof readdir;
  readFile: typeof readFile;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  unlink: typeof unlink;
  open: typeof openAsync;
  syncDirectory: (directoryPath: string) => Promise<void>;
  /** Narrow fault-injection hook used by catalog tests; production leaves it unset. */
  beforeAtomicStage?: (
    stage: "open" | "write" | "file-sync" | "rename" | "directory-sync",
  ) => Promise<void>;
};

const defaultFileIo: StrategyBlueprintFileIo = {
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  open: openAsync,
  syncDirectory: defaultSyncDirectory,
};

export class StrategyBlueprintCatalog {
  readonly loaded: LoadedConfig;
  readonly filePath: string;
  readonly stateDirectory: string;
  readonly root: string;
  private readonly baseDefinitions: Record<string, NamedStrategy>;
  private readonly baseNames: Set<string>;
  private readonly defaultName: string;
  private readonly io: StrategyBlueprintFileIo;
  private customDefinitions: Record<string, NamedStrategy> = {};
  private persistedContents: string | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private indeterminate = false;

  private constructor(
    loaded: LoadedConfig,
    options: {
      root: string;
      stateDirectory: string;
      filePath: string;
      io: StrategyBlueprintFileIo;
    },
  ) {
    const config = structuredClone(loaded.config);
    const baseline = config.strategies ?? legacyStrategies(config);
    this.baseDefinitions = structuredClone(baseline.definitions);
    this.baseNames = new Set(Object.keys(this.baseDefinitions));
    this.defaultName = baseline.default;
    this.root = options.root;
    this.stateDirectory = options.stateDirectory;
    this.filePath = options.filePath;
    this.io = options.io;
    this.loaded = {
      ...loaded,
      root: options.root,
      config: {
        ...config,
        strategies: {
          default: this.defaultName,
          definitions: { ...this.baseDefinitions },
        },
      },
    };
  }

  static async open(
    loaded: LoadedConfig,
    options: { io?: Partial<StrategyBlueprintFileIo> } = {},
  ): Promise<StrategyBlueprintCatalog> {
    if (!loaded || typeof loaded !== "object") {
      throw new StrategyBlueprintValidationError("LoadedConfig is required");
    }
    if (typeof loaded.root !== "string" || !loaded.root.trim()) {
      throw new StrategyBlueprintValidationError("LoadedConfig.root is required");
    }
    if (!loaded.config || typeof loaded.config !== "object") {
      throw new StrategyBlueprintValidationError("LoadedConfig.config is required");
    }

    const io: StrategyBlueprintFileIo = { ...defaultFileIo, ...options.io };
    let root: string;
    try {
      root = await io.realpath(path.resolve(loaded.root));
      const rootInfo = await io.lstat(root);
      if (!rootInfo.isDirectory()) {
        throw new StrategyBlueprintUnsafePathError(
          `LoadedConfig.root must resolve to a directory: ${root}`,
        );
      }
    } catch (error) {
      if (error instanceof StrategyBlueprintError) throw error;
      throw new StrategyBlueprintUnsafePathError(
        `Unable to resolve repository root '${loaded.root}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const stateDirectoryRelative = loaded.config.project?.stateDirectory;
    if (typeof stateDirectoryRelative !== "string" || !stateDirectoryRelative.trim()) {
      throw new StrategyBlueprintValidationError(
        "project.stateDirectory must be a non-empty repository-relative path",
      );
    }

    const stateDirectory = resolveRepositoryOwnedDirectory(
      root,
      stateDirectoryRelative,
      "project.stateDirectory",
    );
    const filePath = path.join(stateDirectory, "strategy-blueprints.json");

    await createRepositoryOwnedDirectory(io, root, stateDirectory);
    await assertRepositoryOwnedStorage(io, root, stateDirectory, filePath);
    await cleanOrphanTemporaryFiles(io, stateDirectory, filePath);

    const catalog = new StrategyBlueprintCatalog(loaded, {
      root,
      stateDirectory,
      filePath,
      io,
    });
    await catalog.load();
    return catalog;
  }

  source(name: string): "config" | "custom" {
    return Object.hasOwn(this.customDefinitions, name) ? "custom" : "config";
  }

  customNames(): string[] {
    return Object.keys(this.customDefinitions).sort();
  }

  /**
   * Return a deeply frozen clone of a custom definition, or `undefined` when
   * the name is not a custom blueprint. Configured strategies are never returned.
   */
  customDefinition(nameInput: string): NamedStrategy | undefined {
    const name = parseName(nameInput);
    if (!Object.hasOwn(this.customDefinitions, name)) {
      return undefined;
    }
    return deepFreeze(structuredClone(this.customDefinitions[name]!));
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
      definition: deepFreeze(structuredClone(definition)),
      resolved: resolveStrategy(configResult.data, name),
    };
  }

  async save(
    nameInput: string,
    definitionInput: unknown,
    options: { expectedBefore?: StrategyBlueprintExpectedBefore } = {},
  ): Promise<CheckedStrategyBlueprint> {
    return await this.enqueue(async () => {
      this.assertMutable();
      const name = parseName(nameInput);
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Configured strategy '${name}' is read-only; save the blueprint under a new name`,
        );
      }
      this.assertExpectedBefore(name, options.expectedBefore);
      const checked = this.preflight(name, definitionInput);
      const next = { ...this.customDefinitions, [name]: structuredClone(checked.definition) };
      await this.persist(next);
      this.customDefinitions = next;
      this.refreshEffectiveConfig();
      return checked;
    });
  }

  async delete(
    nameInput: string,
    options: { expectedBefore?: StrategyBlueprintExpectedBefore } = {},
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertMutable();
      const name = parseName(nameInput);
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Configured strategy '${name}' cannot be deleted from the control plane`,
        );
      }
      if (!Object.hasOwn(this.customDefinitions, name)) {
        if (options.expectedBefore !== undefined && options.expectedBefore !== null) {
          throw new StrategyBlueprintDriftError(
            `Strategy blueprint '${name}' drifted: expected an existing definition before delete`,
          );
        }
        throw new StrategyBlueprintNotFoundError(`Strategy blueprint '${name}' was not found`);
      }
      this.assertExpectedBefore(name, options.expectedBefore);
      const next = { ...this.customDefinitions };
      delete next[name];
      await this.persist(next);
      this.customDefinitions = next;
      this.refreshEffectiveConfig();
    });
  }

  private assertMutable(): void {
    if (this.indeterminate) {
      throw new StrategyBlueprintIndeterminateError(
        "Strategy blueprint catalog commit outcome is indeterminate; reopen the catalog before another mutation",
      );
    }
  }

  private assertExpectedBefore(
    name: string,
    expectedBefore: StrategyBlueprintExpectedBefore | undefined,
  ): void {
    if (expectedBefore === undefined) {
      return;
    }
    const current = Object.hasOwn(this.customDefinitions, name)
      ? this.customDefinitions[name]
      : undefined;
    if (expectedBefore === null) {
      if (current !== undefined) {
        throw new StrategyBlueprintDriftError(
          `Strategy blueprint '${name}' drifted: expected absence before write`,
        );
      }
      return;
    }
    if (current === undefined) {
      throw new StrategyBlueprintDriftError(
        `Strategy blueprint '${name}' drifted: expected an existing definition before write`,
      );
    }
    if (!deepEqual(current, expectedBefore)) {
      throw new StrategyBlueprintDriftError(
        `Strategy blueprint '${name}' drifted: expected-before definition no longer matches`,
      );
    }
  }

  private async load(): Promise<void> {
    let contents: string;
    try {
      await assertPrimaryFileSafe(this.io, this.root, this.filePath);
      contents = await this.io.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      if (error instanceof StrategyBlueprintError) throw error;
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
    this.persistedContents = contents;
    for (const name of Object.keys(parsed.data.definitions)) {
      if (this.baseNames.has(name)) {
        throw new StrategyBlueprintConflictError(
          `Custom strategy '${name}' conflicts with a configured strategy`,
        );
      }
    }
    this.customDefinitions = structuredClone(parsed.data.definitions);
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
    await assertRepositoryOwnedStorage(this.io, this.root, this.stateDirectory, this.filePath);
    await this.assertDiskBaseline();

    const serialized = `${JSON.stringify({ version: 1, definitions }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let renameAttempted = false;

    try {
      await assertRepositoryOwnedStorage(this.io, this.root, this.stateDirectory, this.filePath);
      await this.io.beforeAtomicStage?.("open");
      const handle = await this.io.open(temporaryPath, "wx", 0o600);
      try {
        await this.io.beforeAtomicStage?.("write");
        await handle.writeFile(serialized, "utf8");
        await this.io.beforeAtomicStage?.("file-sync");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await assertRepositoryOwnedStorage(this.io, this.root, this.stateDirectory, this.filePath);
      await this.io.beforeAtomicStage?.("rename");
      renameAttempted = true;
      await this.io.rename(temporaryPath, this.filePath);
      await this.io.beforeAtomicStage?.("directory-sync");
      await this.io.syncDirectory(this.stateDirectory);
      this.persistedContents = serialized;
    } catch (error) {
      if (!renameAttempted) {
        await this.io.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      if (renameAttempted) {
        this.indeterminate = true;
        throw new StrategyBlueprintIndeterminateError(
          `Strategy blueprint catalog rename was attempted and its durability outcome is indeterminate; reopen before continuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (error instanceof StrategyBlueprintError) {
        throw error;
      }
      throw new StrategyBlueprintValidationError(
        `Failed to persist strategy blueprint catalog at ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async assertDiskBaseline(): Promise<void> {
    let currentContents: string | null;
    try {
      await assertPrimaryFileSafe(this.io, this.root, this.filePath);
      currentContents = await this.io.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        currentContents = null;
      } else {
        throw error;
      }
    }
    if (currentContents !== this.persistedContents) {
      throw new StrategyBlueprintDriftError(
        "Strategy blueprint catalog changed on disk after this instance opened; reopen before writing",
      );
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
        executionTimeoutSeconds: legacyExecutionTimeoutSeconds,
        maxAgentInvocations: legacyMaxAgentInvocations,
        maxProcessOutputBytes: legacyMaxProcessOutputBytes,
        maxArtifactBytes: legacyMaxArtifactBytes,
        roleProfiles: {},
        approvalGates: ["final"],
        approvalTimeoutSeconds: legacyApprovalTimeoutSeconds,
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortObjectKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function resolveRepositoryOwnedDirectory(
  root: string,
  relativeDirectory: string,
  label: string,
): string {
  if (!relativeDirectory || relativeDirectory.includes("\0")) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} must be a non-empty repository-relative path`,
    );
  }
  if (relativeDirectory !== relativeDirectory.trim()) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} must not include leading or trailing whitespace`,
    );
  }
  if (path.isAbsolute(relativeDirectory) || /^[A-Za-z]:[\\/]/.test(relativeDirectory)) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} must be repository-relative (absolute paths are not allowed)`,
    );
  }
  if (relativeDirectory.includes("\\")) {
    throw new StrategyBlueprintUnsafePathError(`${label} must use POSIX separators only`);
  }
  const segments = relativeDirectory.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} must not contain empty, '.', or '..' segments`,
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} must resolve inside the repository root`,
    );
  }
  return resolved;
}

async function createRepositoryOwnedDirectory(
  io: StrategyBlueprintFileIo,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StrategyBlueprintUnsafePathError(
      `Strategy blueprint storage directory must remain below repository root: ${target}`,
    );
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await io.lstat(current);
      assertDirectoryEntrySafe(info, current);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await io.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await io.lstat(current);
      assertDirectoryEntrySafe(info, current);
    }
  }
  await assertExistingDirectoryChain(io, root, target);
}

async function assertRepositoryOwnedStorage(
  io: StrategyBlueprintFileIo,
  root: string,
  stateDirectory: string,
  filePath: string,
): Promise<void> {
  await assertExistingDirectoryChain(io, root, stateDirectory);
  await assertPrimaryFileSafe(io, root, filePath);
}

async function assertExistingDirectoryChain(
  io: StrategyBlueprintFileIo,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StrategyBlueprintUnsafePathError(
      `Strategy blueprint storage directory must remain below repository root: ${target}`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await io.lstat(current);
    assertDirectoryEntrySafe(info, current);
  }
  const canonical = await io.realpath(target);
  assertCanonicalPathInsideRoot(root, canonical, "Strategy blueprint storage directory");
}

function assertDirectoryEntrySafe(
  info: Awaited<ReturnType<typeof lstat>>,
  entryPath: string,
): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StrategyBlueprintUnsafePathError(
      `Strategy blueprint storage path component must be a real directory, not a symlink or file: ${entryPath}`,
    );
  }
}

async function assertPrimaryFileSafe(
  io: StrategyBlueprintFileIo,
  root: string,
  filePath: string,
): Promise<void> {
  try {
    const info = await io.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new StrategyBlueprintUnsafePathError(
        `Strategy blueprint catalog must be a regular non-symlink file: ${filePath}`,
      );
    }
    const canonical = await io.realpath(filePath);
    assertCanonicalPathInsideRoot(root, canonical, "Strategy blueprint catalog");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function assertCanonicalPathInsideRoot(root: string, candidate: string, label: string): void {
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new StrategyBlueprintUnsafePathError(
      `${label} resolves outside repository root: ${candidate}`,
    );
  }
}

async function cleanOrphanTemporaryFiles(
  io: StrategyBlueprintFileIo,
  stateDirectory: string,
  filePath: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await io.readdir(stateDirectory);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  const escapedBaseName = escapeRegularExpression(path.basename(filePath));
  const ownedTemporaryName = new RegExp(
    `^${escapedBaseName}\\.\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
    "i",
  );
  for (const entry of entries) {
    if (!ownedTemporaryName.test(entry)) {
      continue;
    }
    const absolute = path.join(stateDirectory, entry);
    try {
      const info = await io.lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await io.rm(absolute, { force: true });
    } catch {
      // Best-effort cleanup only; never mask primary-document failures.
    }
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function defaultSyncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    handle = await openAsync(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (
      process.platform === "win32" &&
      (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
