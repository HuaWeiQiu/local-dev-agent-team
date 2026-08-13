import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { clearPromptTemplateCache } from "../agents/service.js";
import type { LoadedConfig } from "../config/load.js";
import type { NamedStrategy } from "../config/schema.js";
import {
  GitManager,
  type ExactTrackedFileCommitAuthorization,
} from "../git/manager.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
  StrategyBlueprintDriftError,
  StrategyBlueprintError,
  StrategyBlueprintIndeterminateError,
  type StrategyBlueprintExpectedBefore,
} from "../strategies/catalog.js";
import type {
  EvolutionCandidate,
  EvolutionProposal,
  HumanDecision,
} from "./domain.js";
import { EvolutionPersistenceValidationError } from "./persistence.js";
import {
  EVOLUTION_PROMPT_MATERIAL_MAX_BYTES,
  EvolutionApplicationError,
  assertCanonicalInsideRoot,
  decodeUtf8,
  escapeRegExp,
  isolate,
  isAlreadyExists,
  isNotFound,
  mapGitError,
  sha256Bytes,
  sha256Canonical,
  type ApplicationRecord,
  type EvolutionApplicationFileIo,
  type TargetDigestState,
} from "./application-shared.js";

/** Dependencies shared by every repository-local evolution target mutation. */
export interface EvolutionApplicationTargetEnvironment {
  readonly io: EvolutionApplicationFileIo;
  /** Canonical repository root shared by the catalog, strategies, and Git manager. */
  readonly root: string;
  readonly objectsDirectory: string;
  readonly strategies: StrategyBlueprintCatalog;
  readonly git: GitManager;
  readonly loaded: LoadedConfig;
}

/**
 * Repository-local target reads and mutations for role prompts and custom
 * strategy blueprints. Prompt bytes are staged through the content-addressed
 * object store; prompt files are atomically replaced and committed through
 * exact-path Git authorizations. Never accepts caller-selected paths.
 */
export class EvolutionApplicationTargets {
  readonly #io: EvolutionApplicationFileIo;
  readonly #root: string;
  readonly #objectsDirectory: string;
  readonly #strategies: StrategyBlueprintCatalog;
  readonly #git: GitManager;
  readonly #loaded: LoadedConfig;

  constructor(environment: EvolutionApplicationTargetEnvironment) {
    this.#io = environment.io;
    this.#root = environment.root;
    this.#objectsDirectory = environment.objectsDirectory;
    this.#strategies = environment.strategies;
    this.#git = environment.git;
    this.#loaded = environment.loaded;
  }

  async readTargetState(candidate: EvolutionCandidate): Promise<TargetDigestState> {
    if (candidate.kind === "role-prompt") {
      const absolute = path.resolve(this.#root, candidate.path);
      assertCanonicalInsideRoot(this.#root, absolute, "Prompt target");
      try {
        const info = await this.#io.lstat(absolute);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target must be a regular non-symlink file: ${candidate.path}`,
          );
        }
        if ((info.mode & 0o7000) !== 0 || (await this.#io.realpath(absolute)) !== absolute) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target must not traverse symbolic links or use special permissions: ${candidate.path}`,
          );
        }
        const bytes = await this.#io.readFile(absolute);
        return {
          kind: "role-prompt",
          identity: candidate.path,
          digest: sha256Bytes(bytes),
          present: true,
          mode: info.mode & 0o777,
        };
      } catch (error) {
        if (isNotFound(error)) {
          return {
            kind: "role-prompt",
            identity: candidate.path,
            digest: null,
            present: false,
          };
        }
        throw error;
      }
    }

    const current = this.#strategies.customDefinition(candidate.name);
    if (!current) {
      return {
        kind: "strategy-blueprint",
        identity: candidate.name,
        digest: null,
        present: false,
        strategyDefinition: null,
      };
    }
    return {
      kind: "strategy-blueprint",
      identity: candidate.name,
      digest: sha256Canonical(current),
      present: true,
      strategyDefinition: current,
    };
  }

  async readLivePromptText(relativePath: string, expectedDigest: string): Promise<string> {
    return decodeUtf8(await this.readLivePromptBytes(relativePath, expectedDigest));
  }

  async readLivePromptBytes(relativePath: string, expectedDigest: string): Promise<Buffer> {
    const absolute = path.resolve(this.#root, relativePath);
    assertCanonicalInsideRoot(this.#root, absolute, "Prompt target");
    const bytes = await this.#io.readFile(absolute);
    if (
      bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES ||
      sha256Bytes(bytes) !== expectedDigest
    ) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' changed or exceeds the review limit`,
      );
    }
    try {
      decodeUtf8(bytes);
    } catch {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' is not valid UTF-8`,
      );
    }
    return bytes;
  }

  async plannedAfterState(
    proposal: EvolutionProposal,
    before: TargetDigestState,
  ): Promise<TargetDigestState> {
    if (proposal.candidate.kind === "role-prompt") {
      return {
        kind: "role-prompt",
        identity: proposal.candidate.path,
        digest: proposal.candidate.contentDigest,
        present: true,
        ...(before.mode === undefined ? {} : { mode: before.mode }),
      };
    }
    return {
      kind: "strategy-blueprint",
      identity: proposal.candidate.name,
      digest: sha256Canonical(proposal.candidate.definition),
      present: true,
      strategyDefinition: proposal.candidate.definition as NamedStrategy,
    };
  }

  async plannedRollbackState(
    proposal: EvolutionProposal,
    application: ApplicationRecord,
  ): Promise<TargetDigestState> {
    if (proposal.candidate.kind === "role-prompt") {
      // Restore bytes from object store using before digest when present; absence means empty not allowed
      // Prompt files must always remain existing tracked files — restore previous content from objects.
      if (application.beforeTargetDigest === null) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Cannot roll back prompt application without a recorded before digest",
        );
      }
      return {
        ...application.beforeTarget,
      };
    }

    return isolate(application.beforeTarget);
  }

  async applyTarget(
    proposal: EvolutionProposal,
    before: TargetDigestState,
    after: TargetDigestState,
    decision: HumanDecision,
    mode: "apply" | "rollback",
    gitAuthorization?: ExactTrackedFileCommitAuthorization,
  ): Promise<void> {
    if (proposal.candidate.kind === "role-prompt") {
      if (!gitAuthorization) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Prompt mutation is missing its pre-mutation Git authorization",
        );
      }
      await this.#applyPromptTarget(
        proposal,
        before,
        after.digest!,
        decision,
        mode,
        gitAuthorization,
      );
      return;
    }
    await this.#applyStrategyTarget(proposal, before, after, mode);
  }

  async #applyPromptTarget(
    proposal: EvolutionProposal,
    expectedBefore: TargetDigestState,
    desiredDigest: string,
    decision: HumanDecision,
    mode: "apply" | "rollback",
    authorization: ExactTrackedFileCommitAuthorization,
  ): Promise<void> {
    if (proposal.candidate.kind !== "role-prompt") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a role-prompt candidate");
    }
    const relativePath = proposal.candidate.path;
    // Configured promptFile only
    const configured = Object.values(this.#loaded.config.roles ?? {}).some(
      (role) => role && typeof role === "object" && role.promptFile === relativePath,
    );
    if (!configured) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        `Prompt path '${relativePath}' is not a configured role promptFile`,
      );
    }

    const content = await this.readPromptObject(desiredDigest);
    const absolute = path.resolve(this.#root, relativePath);
    assertCanonicalInsideRoot(this.#root, absolute, "Prompt target");

    // Must already exist as tracked regular file — never create/delete
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await this.#io.lstat(absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt target '${relativePath}' does not exist; evolution never creates prompt files`,
        );
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target must be a regular non-symlink file: ${relativePath}`,
      );
    }
    if ((info.mode & 0o7000) !== 0) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' must not use special permission bits`,
      );
    }
    const canonicalTarget = await this.#io.realpath(absolute);
    if (canonicalTarget !== absolute) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' must not traverse symbolic links`,
      );
    }

    // Snapshot current bytes into the local object store for recovery/rollback.
    // Prompt files must contain no secrets; these objects are local recovery only.
    const currentBytes = await this.#io.readFile(absolute);
    if (
      sha256Bytes(currentBytes) !== expectedBefore.digest ||
      (expectedBefore.mode !== undefined && (info.mode & 0o777) !== expectedBefore.mode)
    ) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' changed after preview`,
      );
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    } catch {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' is not valid UTF-8`,
      );
    }
    if (currentBytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' exceeds material size limit`,
      );
    }
    await this.ingestPromptMaterial(sha256Bytes(currentBytes), currentBytes);

    const directory = path.dirname(absolute);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let renamed = false;
    try {
      await this.#io.beforeAtomicStage?.("open");
      const handle = await this.#io.open(temporaryPath, "wx", info.mode & 0o777);
      try {
        await this.#io.beforeAtomicStage?.("write");
        await handle.writeFile(content);
        await this.#io.chmod(temporaryPath, info.mode & 0o777);
        await this.#io.beforeAtomicStage?.("file-sync");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.beforeAtomicStage?.("rename");
      if ((await this.#io.realpath(directory)) !== directory) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Prompt parent directory changed before rename: ${relativePath}`,
        );
      }
      await this.#io.rename(temporaryPath, absolute);
      renamed = true;
      await this.#io.beforeAtomicStage?.("directory-sync");
      await this.#io.syncDirectory(directory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (renamed) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt rename completed but directory fsync failed; recovery required: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Failed to write prompt target '${relativePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Verify digest after write
    const written = await this.#io.readFile(absolute);
    const writtenDigest = sha256Bytes(written);
    if (writtenDigest !== desiredDigest) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target digest mismatch after write for '${relativePath}'`,
      );
    }
    const writtenInfo = await this.#io.lstat(absolute);
    if (!writtenInfo.isFile() || writtenInfo.isSymbolicLink() || (writtenInfo.mode & 0o777) !== (info.mode & 0o777)) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target permissions changed unexpectedly for '${relativePath}'`,
      );
    }

    try {
      await this.#git.commitExactTrackedFile(
        authorization,
        mode === "apply"
          ? `evolution: apply role-prompt ${relativePath} (${decision.actor})`
          : `evolution: rollback role-prompt ${relativePath} (${decision.actor})`,
      );
    } catch (error) {
      throw mapGitError(error);
    }

    clearPromptTemplateCache();
  }

  async #applyStrategyTarget(
    proposal: EvolutionProposal,
    before: TargetDigestState,
    after: TargetDigestState,
    _mode: "apply" | "rollback",
  ): Promise<void> {
    if (proposal.candidate.kind !== "strategy-blueprint") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a strategy-blueprint candidate");
    }
    const name = proposal.candidate.name;
    // Configured (agent-team.yaml) strategies are never mutated. source() reports
    // "config" for names that are not present as custom blueprints; when a name is
    // both a baseline config name and somehow custom, customDefinition wins. Reject
    // when the name is a baseline-only configured strategy.
    const custom = this.#strategies.customDefinition(name);
    if (!custom && this.#strategies.source(name) === "config") {
      // source returns "config" for any non-custom name, including unknown names.
      // Unknown names are allowed for create. Detect baseline names via conflict on save.
      // Preflight: if resolve would find a config strategy and custom is absent, block
      // only when the catalog considers it a configured strategy (save throws CONFLICT).
      // We probe by checking whether the name exists in loaded config strategies.
      const configuredNames = new Set(
        Object.keys(this.#loaded.config.strategies?.definitions ?? {}),
      );
      if (configuredNames.has(name)) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          `Configured strategy '${name}' cannot be modified by evolution application`,
        );
      }
    }

    try {
      if (!after.present || after.strategyDefinition === null || after.strategyDefinition === undefined) {
        const current = this.#strategies.customDefinition(name);
        if (!current) {
          if (!before.present) {
            return;
          }
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Strategy blueprint '${name}' is absent but rollback expected a definition`,
          );
        }
        await this.#strategies.delete(name, {
          expectedBefore: before.strategyDefinition ?? current,
        });
        return;
      }

      const expectedBefore: StrategyBlueprintExpectedBefore = before.present
        ? (before.strategyDefinition ?? this.#strategies.customDefinition(name) ?? null)
        : null;
      await this.#strategies.save(name, after.strategyDefinition, { expectedBefore });
    } catch (error) {
      if (error instanceof EvolutionApplicationError) {
        throw error;
      }
      if (error instanceof StrategyBlueprintDriftError) {
        throw new EvolutionApplicationError("TARGET_DRIFTED", error.message);
      }
      if (error instanceof StrategyBlueprintConflictError) {
        throw new EvolutionApplicationError("POLICY_DENIED", error.message);
      }
      if (error instanceof StrategyBlueprintIndeterminateError) {
        throw new EvolutionApplicationError("RECOVERY_REQUIRED", error.message);
      }
      if (error instanceof StrategyBlueprintError) {
        throw new EvolutionApplicationError("POLICY_DENIED", error.message);
      }
      throw error;
    }
  }

  async ingestPromptMaterial(contentDigest: string, content: Uint8Array): Promise<void> {
    if (typeof contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(contentDigest)) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        "Role-prompt contentDigest must be a lowercase SHA-256 hex digest",
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content);
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        "Role-prompt content must be valid UTF-8 text",
      );
    }
    if (bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Role-prompt content exceeds ${EVOLUTION_PROMPT_MATERIAL_MAX_BYTES} bytes`,
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== contentDigest) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Role-prompt content digest mismatch: expected ${contentDigest}, got ${actual}`,
      );
    }

    const objectPath = path.join(this.#objectsDirectory, contentDigest);
    assertCanonicalInsideRoot(this.#root, objectPath, "Prompt object");
    await createDirectoryChain(this.#io, this.#root, this.#objectsDirectory, 0o700);
    if ((await this.#io.realpath(this.#objectsDirectory)) !== this.#objectsDirectory) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Prompt object directory must not traverse symbolic links",
      );
    }

    try {
      const existingInfo = await this.#io.lstat(objectPath);
      if (existingInfo.isSymbolicLink() || !existingInfo.isFile()) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt object path is not a regular file: ${objectPath}`,
        );
      }
      if (process.platform !== "win32" && (existingInfo.mode & 0o777) !== 0o600) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt object permissions must be 0600: ${contentDigest}`,
        );
      }
      const existing = await this.#io.readFile(objectPath);
      if (sha256Bytes(existing) !== contentDigest) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Corrupted prompt object at ${contentDigest}`,
        );
      }
      // Idempotent re-ingest of identical object
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof EvolutionApplicationError) throw error;
        throw error;
      }
    }

    const temporaryPath = `${objectPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await this.#io.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await this.#io.chmod(temporaryPath, 0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.rename(temporaryPath, objectPath);
      await this.#io.syncDirectory(this.#objectsDirectory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Failed to persist prompt object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Post-condition
    const written = await this.#io.readFile(objectPath);
    if (sha256Bytes(written) !== contentDigest) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt object digest mismatch after write for ${contentDigest}`,
      );
    }
  }

  async readPromptObject(digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new EvolutionApplicationError("MATERIAL_MISSING", "Invalid prompt object digest");
    }
    const objectPath = path.join(this.#objectsDirectory, digest);
    assertCanonicalInsideRoot(this.#root, objectPath, "Prompt object");
    try {
      if ((await this.#io.realpath(this.#objectsDirectory)) !== this.#objectsDirectory) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          "Prompt object directory must not traverse symbolic links",
        );
      }
      const info = await this.#io.lstat(objectPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object must be a regular non-symlink file: ${digest}`,
        );
      }
      if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object permissions must be 0600: ${digest}`,
        );
      }
      const bytes = await this.#io.readFile(objectPath);
      if (bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object exceeds size limit: ${digest}`,
        );
      }
      if (sha256Bytes(bytes) !== digest) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Corrupted prompt object: ${digest}`,
        );
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object is not valid UTF-8: ${digest}`,
        );
      }
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof EvolutionApplicationError) throw error;
      if (isNotFound(error)) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object not found: ${digest}`,
        );
      }
      throw error;
    }
  }
}

export async function createDirectoryChain(
  io: EvolutionApplicationFileIo,
  root: string,
  target: string,
  mode: number,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvolutionPersistenceValidationError(
      `Path must remain below repository root: ${target}`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await io.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EvolutionPersistenceValidationError(
          `Path component must be a real directory: ${current}`,
        );
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await io.mkdir(current, { mode });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await io.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EvolutionPersistenceValidationError(
          `Path component must be a real directory: ${current}`,
        );
      }
    }
  }
}

export async function assertSafeRegularFileOrMissing(
  io: EvolutionApplicationFileIo,
  root: string,
  filePath: string,
): Promise<void> {
  try {
    const info = await io.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EvolutionPersistenceValidationError(
        `Application state must be a regular non-symlink file: ${filePath}`,
      );
    }
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw new EvolutionPersistenceValidationError(
        `Application state permissions must be 0600: ${filePath}`,
      );
    }
    const canonical = await io.realpath(filePath);
    assertCanonicalInsideRoot(root, canonical, "Application state");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function cleanOrphanTemps(
  io: EvolutionApplicationFileIo,
  directory: string,
  basename: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await io.readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const pattern = new RegExp(
    `^${escapeRegExp(basename)}\\.[0-9]+\\.[a-f0-9]{16}\\.tmp$`,
  );
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const absolute = path.join(directory, entry);
    try {
      const info = await io.lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await io.rm(absolute, { force: true });
    } catch {
      // best-effort
    }
  }
}
