import { type lstat } from "node:fs/promises";
import path from "node:path";
import { promptTempName, siblingTempName, siblingTempPattern } from "./temp-names.js";
import { clearPromptTemplateCache } from "../agents/service.js";
import type { LoadedConfig } from "../config/load.js";
import type { NamedStrategy } from "../config/schema.js";
import {
  type GitManager,
  type ExactTrackedFileCommitAuthorization,
} from "../git/manager.js";
import {
  type StrategyBlueprintCatalog,
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
/** What a prompt target looks like on disk, once it has been vetted. */
export type PromptTargetFacts = {
  readonly relativePath: string;
  readonly absolute: string;
  /** The permission bits to preserve across the replace. */
  readonly mode: number;
};

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
      await this.applyPromptTarget(
        proposal,
        before,
        after.digest!,
        decision,
        mode,
        gitAuthorization,
      );
      return;
    }
    await this.applyStrategyTarget(proposal, before, after, mode);
  }

  async applyPromptTarget(
    proposal: EvolutionProposal,
    expectedBefore: TargetDigestState,
    desiredDigest: string,
    decision: HumanDecision,
    mode: "apply" | "rollback",
    authorization: ExactTrackedFileCommitAuthorization,
  ): Promise<void> {
    const relativePath = this.assertPromptCandidate(proposal);
    const target = await this.describePromptTarget(relativePath);
    const content = await this.readPromptObject(desiredDigest);
    const currentBytes = await this.assertPromptTargetUnchanged(target.absolute, target, expectedBefore);
    await this.ingestPromptMaterial(sha256Bytes(currentBytes), currentBytes);
    await this.writePromptAtomically(target, content);
    await this.assertPromptWriteLanded(target, desiredDigest);
    await this.commitPromptChange(authorization, mode, relativePath, decision);
  }

  /** Only a role-prompt candidate may be applied here, and only at a configured prompt path. */
  assertPromptCandidate(proposal: EvolutionProposal): string {
    if (proposal.candidate.kind !== "role-prompt") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a role-prompt candidate");
    }
    const relativePath = proposal.candidate.path;
    const configured = Object.values(this.#loaded.config.roles ?? {}).some(
      (role) => role && typeof role === "object" && role.promptFile === relativePath,
    );
    if (!configured) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        `Prompt path '${relativePath}' is not a configured role promptFile`,
      );
    }
    return relativePath;
  }

  /**
   * What is at the prompt path right now, and what is safe to assume about it. Evolution
   * never creates or deletes a prompt file: it replaces the bytes of one that already exists
   * as a regular, non-symlinked, sanctioned-permission file inside the repository.
   */
  async describePromptTarget(relativePath: string): Promise<PromptTargetFacts> {
    const absolute = path.resolve(this.#root, relativePath);
    assertCanonicalInsideRoot(this.#root, absolute, "Prompt target");
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
    if ((await this.#io.realpath(absolute)) !== absolute) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' must not traverse symbolic links`,
      );
    }
    return { relativePath, absolute, mode: info.mode & 0o777 };
  }

  /**
   * The preview the operator approved is still the truth: same bytes, same permissions, and
   * still something a prompt file can be (UTF-8, bounded). Anything else means the world
   * moved between preview and apply.
   */
  async assertPromptTargetUnchanged(
    absolute: string,
    target: PromptTargetFacts,
    expectedBefore: TargetDigestState,
  ): Promise<Buffer> {
    const currentBytes = await this.#io.readFile(absolute);
    // Two different things can move between preview and apply, and they are fixed by
    // different people: content usually means someone is editing the prompt, mode usually
    // means a deployment script changed the umask. Naming which one moved is the difference
    // between "state invalid" and an operator knowing who to ask.
    const mismatched = [
      sha256Bytes(currentBytes) === expectedBefore.digest ? null : "content",
      expectedBefore.mode !== undefined && target.mode !== expectedBefore.mode ? "mode" : null,
    ].filter((field): field is string => field !== null);
    if (mismatched.length > 0) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${target.relativePath}' changed after preview (${mismatched.join(", ")})`,
      );
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    } catch {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${target.relativePath}' is not valid UTF-8`,
      );
    }
    if (currentBytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${target.relativePath}' exceeds material size limit`,
      );
    }
    return currentBytes;
  }

  /**
   * Replace the bytes atomically: write a sibling temp file, fsync it, rename it over the
   * target, then fsync the directory. A failure after the rename is not "the write failed" —
   * the new bytes are already in place — so it is reported as recovery, not drift.
   */
  async writePromptAtomically(target: PromptTargetFacts, content: Buffer): Promise<void> {
    const absolute = target.absolute;
    const directory = path.dirname(absolute);
    const temporaryPath = path.join(directory, promptTempName(path.basename(absolute)));
    let renamed = false;
    try {
      await this.writeTemporaryPrompt(temporaryPath, content, target.mode);
      await this.#io.beforeAtomicStage?.("rename");
      await this.assertPromptParentUnchanged(directory, target.relativePath);
      await this.#io.rename(temporaryPath, absolute);
      renamed = true;
      await this.#io.beforeAtomicStage?.("directory-sync");
      await this.#io.syncDirectory(directory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw this.promptWriteFailure(error, renamed, target.relativePath);
    }
  }

  /** Create the temp file exclusively, fill it, and make its bytes durable. */
  async writeTemporaryPrompt(temporaryPath: string, content: Buffer, mode: number): Promise<void> {
    await this.#io.beforeAtomicStage?.("open");
    const handle = await this.#io.open(temporaryPath, "wx", mode);
    try {
      await this.#io.beforeAtomicStage?.("write");
      await handle.writeFile(content);
      await this.#io.chmod(temporaryPath, mode);
      await this.#io.beforeAtomicStage?.("file-sync");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** The directory must still be the one the path says it is, immediately before the rename. */
  async assertPromptParentUnchanged(directory: string, relativePath: string): Promise<void> {
    if ((await this.#io.realpath(directory)) !== directory) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt parent directory changed before rename: ${relativePath}`,
      );
    }
  }

  /**
   * What a failed write means. Once the rename happened the new bytes are in place and only
   * the directory entry may not be durable — that is recovery, not drift.
   */
  promptWriteFailure(error: unknown, renamed: boolean, relativePath: string): EvolutionApplicationError {
    const detail = error instanceof Error ? error.message : String(error);
    return renamed
      ? new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt rename completed but directory fsync failed; recovery required: ${detail}`,
        )
      : new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Failed to write prompt target '${relativePath}': ${detail}`,
        );
  }

  /** The bytes on disk after the replace must be the bytes the object store holds. */
  async assertPromptWriteLanded(
    target: PromptTargetFacts,
    desiredDigest: string,
  ): Promise<void> {
    const written = await this.#io.readFile(target.absolute);
    if (sha256Bytes(written) !== desiredDigest) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target digest mismatch after write for '${target.relativePath}'`,
      );
    }
    const writtenInfo = await this.#io.lstat(target.absolute);
    if (
      !writtenInfo.isFile() ||
      writtenInfo.isSymbolicLink() ||
      (writtenInfo.mode & 0o777) !== target.mode
    ) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target permissions changed unexpectedly for '${target.relativePath}'`,
      );
    }
  }

  /**
   * Commit exactly that one file. The message names the direction and the operator so the
   * history says who applied or rolled back what; the prompt template cache is dropped
   * afterwards because agents would otherwise keep serving the previous text.
   */
  async commitPromptChange(
    authorization: ExactTrackedFileCommitAuthorization,
    mode: "apply" | "rollback",
    relativePath: string,
    decision: HumanDecision,
  ): Promise<void> {
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

  async applyStrategyTarget(
    proposal: EvolutionProposal,
    before: TargetDigestState,
    after: TargetDigestState,
    _mode: "apply" | "rollback",
  ): Promise<void> {
    const name = this.assertStrategyCandidate(proposal);
    try {
      if (isAbsentDefinition(after)) {
        await this.removeStrategyDefinition(name, before);
        return;
      }
      await this.saveStrategyDefinition(name, before, after);
    } catch (error) {
      throw this.strategyApplyFailure(error);
    }
  }

  /**
   * Only a strategy blueprint may be applied here, and never one the project configures.
   *
   * The config/custom question has one subtlety worth keeping: `source()` reports "config" for
   * every name that is not a custom blueprint, including names nobody configured, so it cannot
   * decide this alone. The name is refused only when the loaded config actually declares it.
   */
  assertStrategyCandidate(proposal: EvolutionProposal): string {
    if (proposal.candidate.kind !== "strategy-blueprint") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a strategy-blueprint candidate");
    }
    const name = proposal.candidate.name;
    const custom = this.#strategies.customDefinition(name);
    if (custom || this.#strategies.source(name) !== "config") return name;
    const configuredNames = new Set(Object.keys(this.#loaded.config.strategies?.definitions ?? {}));
    if (configuredNames.has(name)) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        `Configured strategy '${name}' cannot be modified by evolution application`,
      );
    }
    return name;
  }

  /** Remove a custom blueprint, refusing when the rollback expected one that is not there. */
  async removeStrategyDefinition(name: string, before: TargetDigestState): Promise<void> {
    const current = this.#strategies.customDefinition(name);
    if (current) {
      await this.#strategies.delete(name, {
        expectedBefore: before.strategyDefinition ?? current,
      });
      return;
    }
    if (!before.present) return;
    throw new EvolutionApplicationError(
      "TARGET_DRIFTED",
      `Strategy blueprint '${name}' is absent but rollback expected a definition`,
    );
  }

  /** Save the definition, with the state the caller believed it was replacing. */
  async saveStrategyDefinition(
    name: string,
    before: TargetDigestState,
    after: TargetDigestState,
  ): Promise<void> {
    const expectedBefore: StrategyBlueprintExpectedBefore = before.present
      ? (before.strategyDefinition ?? this.#strategies.customDefinition(name) ?? null)
      : null;
    await this.#strategies.save(name, after.strategyDefinition!, { expectedBefore });
  }

  /**
   * What a failed catalog mutation means for the caller. Drift is a disagreement about the
   * current definition, conflict is a policy refusal, indeterminate means the write may have
   * happened — and that last one is the only one a retry must not treat as "did not happen".
   */
  strategyApplyFailure(error: unknown): unknown {
    if (error instanceof EvolutionApplicationError) return error;
    if (error instanceof StrategyBlueprintDriftError) {
      return new EvolutionApplicationError("TARGET_DRIFTED", error.message);
    }
    if (error instanceof StrategyBlueprintIndeterminateError) {
      return new EvolutionApplicationError("RECOVERY_REQUIRED", error.message);
    }
    if (error instanceof StrategyBlueprintConflictError || error instanceof StrategyBlueprintError) {
      return new EvolutionApplicationError("POLICY_DENIED", error.message);
    }
    return error;
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

    const temporaryPath = siblingTempName(objectPath);
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
    this.assertPromptObjectDigest(digest);
    try {
      const objectPath = await this.describePromptObject(digest);
      return this.verifyPromptObjectBytes(digest, await this.#io.readFile(objectPath));
    } catch (error) {
      throw this.promptObjectFailure(error, digest);
    }
  }

  /** A digest is the whole address of an object: anything else is not one. */
  assertPromptObjectDigest(digest: string): void {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new EvolutionApplicationError("MATERIAL_MISSING", "Invalid prompt object digest");
    }
  }

  /**
   * Where the object lives and whether that path is trustworthy: inside the repository, in a
   * directory that is not a link, and a regular file with the permissions we wrote it with.
   */
  async describePromptObject(digest: string): Promise<string> {
    const objectPath = path.join(this.#objectsDirectory, digest);
    assertCanonicalInsideRoot(this.#root, objectPath, "Prompt object");
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
    return objectPath;
  }

  /** The bytes must still be the bytes the digest names, and still be usable as a prompt. */
  verifyPromptObjectBytes(digest: string, bytes: Buffer): Buffer {
    if (bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError("MATERIAL_MISSING", `Prompt object exceeds size limit: ${digest}`);
    }
    if (sha256Bytes(bytes) !== digest) {
      throw new EvolutionApplicationError("MATERIAL_MISSING", `Corrupted prompt object: ${digest}`);
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
  }

  /** A read that failed for reasons other than our own guards, named for the operator. */
  promptObjectFailure(error: unknown, digest: string): unknown {
    if (error instanceof EvolutionApplicationError) return error;
    if (isNotFound(error)) {
      return new EvolutionApplicationError("MATERIAL_MISSING", `Prompt object not found: ${digest}`);
    }
    return error;
  }
}

/** A target that carries no definition: the operation is a removal. */
function isAbsentDefinition(target: TargetDigestState): boolean {
  return !target.present || target.strategyDefinition === null || target.strategyDefinition === undefined;
}

export async function createDirectoryChain(
  io: EvolutionApplicationFileIo,
  root: string,
  target: string,
  mode: number,
): Promise<void> {
  const relative = relativeInsideRoot(root, target);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await ensureRealDirectory(io, current, mode);
  }
}

/** The part of `target` below `root`, or a refusal: a chain may never leave the repository. */
function relativeInsideRoot(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvolutionPersistenceValidationError(`Path must remain below repository root: ${target}`);
  }
  return relative;
}

/**
 * One component of the chain: either a real directory already, or created and then checked
 * again. The second check is not redundant — `mkdir` on a path whose parent is a link creates
 * through the link, so what the path resolved to before the call is not what it means after.
 */
async function ensureRealDirectory(
  io: EvolutionApplicationFileIo,
  current: string,
  mode: number,
): Promise<void> {
  const existing = await inspectDirectoryComponent(io, current);
  if (existing !== "missing") {
    assertRealDirectory(existing, current);
    return;
  }
  try {
    await io.mkdir(current, { mode });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  // Straight `lstat`, not the tolerant helper: before this refactor a component that
  // disappeared between mkdir and the check surfaced the raw ENOENT, and that stays true.
  assertRealDirectory(await io.lstat(current), current);
}

async function inspectDirectoryComponent(
  io: EvolutionApplicationFileIo,
  current: string,
): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean } | "missing"> {
  try {
    return await io.lstat(current);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return "missing";
  }
}

function assertRealDirectory(
  info: { isSymbolicLink(): boolean; isDirectory(): boolean } | "missing",
  current: string,
): void {
  if (info === "missing" || info.isSymbolicLink() || !info.isDirectory()) {
    throw new EvolutionPersistenceValidationError(
      `Path component must be a real directory: ${current}`,
    );
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
  const pattern = siblingTempPattern(basename);
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
