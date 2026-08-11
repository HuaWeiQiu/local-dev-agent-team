import { createHash, randomUUID } from "node:crypto";
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
import type { LoadedConfig } from "../config/load.js";
import {
  createEvolutionCatalog,
  restoreEvolutionCatalog,
  type EvolutionActiveProposalPointer,
  type EvolutionCandidateTarget,
  type EvolutionCatalogRestoreMaterial,
  type EvolutionCatalogSnapshot,
  type EvolutionCatalog,
} from "./catalog.js";
import {
  assertPromotionRecordMatchesProposal,
  auditRecordSchema,
  createEvolutionTrustContext,
  EvolutionDomainError,
  parseEvolutionProposal,
  parsePromotionRecord,
  type AuditRecord,
  type EvolutionProposal,
  type EvolutionTrustContext,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
} from "./domain.js";

/** Durable evolution catalog document version. */
export const EVOLUTION_DURABLE_DOCUMENT_VERSION = 1 as const;

/** Primary durable filename under `<stateDirectory>/evolution/`. */
export const EVOLUTION_CATALOG_FILENAME = "catalog.json" as const;

export class EvolutionPersistenceError extends EvolutionDomainError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionPersistenceError";
  }
}

export class EvolutionPersistenceConflictError extends EvolutionPersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionPersistenceConflictError";
  }
}

export class EvolutionPersistenceValidationError extends EvolutionPersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionPersistenceValidationError";
  }
}

type DurablePayload = {
  readonly proposals: readonly EvolutionProposal[];
  readonly auditRecords: readonly AuditRecord[];
  readonly activeProposals: readonly EvolutionActiveProposalPointer[];
  readonly promotionRecords: readonly PromotionRecord[];
};

type DurableDocument = {
  readonly version: typeof EVOLUTION_DURABLE_DOCUMENT_VERSION;
  readonly revision: number;
  readonly payloadDigest: string;
  readonly payload: DurablePayload;
};

export type DurableEvolutionFileIo = {
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
  /** Narrow fault-injection hook used by persistence tests; production leaves it unset. */
  beforeAtomicStage?: (
    stage: "open" | "write" | "file-sync" | "rename" | "directory-sync",
  ) => Promise<void>;
};

const defaultFileIo: DurableEvolutionFileIo = {
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

const catalogFileMutationQueues = new Map<string, Promise<void>>();

/**
 * Asynchronous durable wrapper around a pure {@link EvolutionCatalog}.
 *
 * Trust is derived solely from {@link LoadedConfig} roles. Mutations are
 * serialized through a failure-tolerant queue, staged against a restored working
 * catalog, and committed with unique `wx` temporary files, mode `0600`, file
 * fsync, rename, directory fsync, then memory swap.
 *
 * The payload SHA-256 digest detects corruption; it is not authentication
 * against an attacker with filesystem write access.
 */
export class DurableEvolutionCatalog {
  readonly root: string;
  readonly stateDirectory: string;
  readonly evolutionDirectory: string;
  readonly filePath: string;

  #catalog: EvolutionCatalog;
  #revision: number;
  #trust: EvolutionTrustContext;
  #io: DurableEvolutionFileIo;
  #mutationQueue: Promise<void> = Promise.resolve();
  #indeterminate = false;
  #exclusiveWriter: object | null = null;

  private constructor(options: {
    root: string;
    stateDirectory: string;
    evolutionDirectory: string;
    filePath: string;
    catalog: EvolutionCatalog;
    revision: number;
    trust: EvolutionTrustContext;
    io: DurableEvolutionFileIo;
  }) {
    this.root = options.root;
    this.stateDirectory = options.stateDirectory;
    this.evolutionDirectory = options.evolutionDirectory;
    this.filePath = options.filePath;
    this.#catalog = options.catalog;
    this.#revision = options.revision;
    this.#trust = options.trust;
    this.#io = options.io;
  }

  /**
   * Open (or create) the durable catalog under the repository-owned state directory.
   * Fail-closed on corrupt primary documents; empty only when the primary is absent.
   */
  static async open(
    loaded: LoadedConfig,
    options: { io?: Partial<DurableEvolutionFileIo> } = {},
  ): Promise<DurableEvolutionCatalog> {
    if (!loaded || typeof loaded !== "object") {
      throw new EvolutionPersistenceValidationError("LoadedConfig is required");
    }
    if (typeof loaded.root !== "string" || !loaded.root.trim()) {
      throw new EvolutionPersistenceValidationError("LoadedConfig.root is required");
    }
    if (!loaded.config || typeof loaded.config !== "object") {
      throw new EvolutionPersistenceValidationError("LoadedConfig.config is required");
    }

    const io: DurableEvolutionFileIo = { ...defaultFileIo, ...options.io };
    let root: string;
    try {
      root = await io.realpath(path.resolve(loaded.root));
      const rootInfo = await io.lstat(root);
      if (!rootInfo.isDirectory()) {
        throw new EvolutionPersistenceValidationError(
          `LoadedConfig.root must resolve to a directory: ${root}`,
        );
      }
    } catch (error) {
      if (error instanceof EvolutionPersistenceError) throw error;
      throw new EvolutionPersistenceValidationError(
        `Unable to resolve repository root '${loaded.root}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const stateDirectoryRelative = loaded.config.project?.stateDirectory;
    if (typeof stateDirectoryRelative !== "string" || !stateDirectoryRelative.trim()) {
      throw new EvolutionPersistenceValidationError(
        "project.stateDirectory must be a non-empty repository-relative path",
      );
    }

    const stateDirectory = resolveRepositoryOwnedDirectory(
      root,
      stateDirectoryRelative,
      "project.stateDirectory",
    );
    const evolutionDirectory = path.join(stateDirectory, "evolution");
    const filePath = path.join(evolutionDirectory, EVOLUTION_CATALOG_FILENAME);

    let trust: EvolutionTrustContext;
    try {
      trust = createEvolutionTrustContext({
        roles: trustRolesFromLoadedConfig(loaded.config.roles),
      });
    } catch (error) {
      if (error instanceof EvolutionDomainError) {
        throw new EvolutionPersistenceValidationError(error.message);
      }
      throw error;
    }

    await createRepositoryOwnedDirectory(io, root, stateDirectory);
    await createRepositoryOwnedDirectory(io, root, evolutionDirectory);
    await assertRepositoryOwnedStorage(io, root, stateDirectory, evolutionDirectory, filePath);
    await cleanOrphanTemporaryFiles(io, evolutionDirectory, filePath);

    let catalog: EvolutionCatalog;
    let revision: number;
    try {
      await assertPrimaryFileSafe(io, root, filePath);
      const contents = await io.readFile(filePath, "utf8");
      const restored = restoreFromDocumentText(contents, trust, filePath);
      catalog = restored.catalog;
      revision = restored.revision;
    } catch (error) {
      if (isNotFound(error)) {
        catalog = createEvolutionCatalog(trust);
        revision = 0;
      } else if (error instanceof EvolutionPersistenceError) {
        throw error;
      } else if (error instanceof EvolutionDomainError) {
        throw new EvolutionPersistenceValidationError(error.message);
      } else {
        throw error;
      }
    }

    return new DurableEvolutionCatalog({
      root,
      stateDirectory,
      evolutionDirectory,
      filePath,
      catalog,
      revision,
      trust,
      io,
    });
  }

  /** Last successfully committed monotonic revision (`0` when no document exists). */
  get revision(): number {
    return this.#revision;
  }

  getProposal(proposalId: string): EvolutionProposal | undefined {
    return this.#catalog.getProposal(proposalId);
  }

  getActiveProposalId(target: EvolutionCandidateTarget): string | null {
    return this.#catalog.getActiveProposalId(target);
  }

  snapshot(): EvolutionCatalogSnapshot {
    return this.#catalog.snapshot();
  }

  /**
   * Atomically read the committed catalog revision together with a snapshot.
   * Callers must not pair a separate `revision` getter read with `snapshot()`
   * across `await` boundaries.
   */
  async readSnapshot(): Promise<{
    revision: number;
    snapshot: EvolutionCatalogSnapshot;
  }> {
    return await this.#enqueue(async () => ({
      revision: this.#revision,
      snapshot: this.#catalog.snapshot(),
    }));
  }

  /**
   * Permanently bind mutations on this instance to one coordinator-owned lease.
   * Reads and pure preflights remain available to observers.
   */
  claimExclusiveWriter(): object {
    if (this.#exclusiveWriter) {
      throw new EvolutionPersistenceError(
        "Durable evolution catalog already has an exclusive mutation owner",
      );
    }
    const lease = Object.freeze({});
    this.#exclusiveWriter = lease;
    return lease;
  }

  releaseExclusiveWriter(writer: object): void {
    if (this.#exclusiveWriter !== writer) {
      throw new EvolutionPersistenceError(
        "Only the current exclusive mutation owner can release the durable catalog",
      );
    }
    this.#exclusiveWriter = null;
  }

  /** Validate a proposal against the current catalog without writing state. */
  async validateProposal(input: {
    id: string;
    createdAt: string;
    policy: unknown;
    candidate: unknown;
    origin?: "automatic-controller-v1";
  }): Promise<EvolutionProposal> {
    return await this.#enqueue(async () => {
      const working = restoreEvolutionCatalog(this.#trust, this.#catalog.exportDurableMaterial());
      return working.propose(input);
    });
  }

  /** Run the full promotion transition against an isolated catalog clone. */
  async preflightPromote(
    proposalId: string,
    evidence: unknown,
    decision: unknown,
    applicationCommandId?: string,
  ): Promise<{ proposal: EvolutionProposal; record: PromotionRecord }> {
    return await this.#enqueue(async () => {
      const working = restoreEvolutionCatalog(this.#trust, this.#catalog.exportDurableMaterial());
      return working.promote(proposalId, evidence, decision, applicationCommandId);
    });
  }

  /** Run the full rollback transition against an isolated catalog clone. */
  async preflightRollback(
    proposalId: string,
    decision: unknown,
    applicationCommandId?: string,
  ): Promise<{ proposal: EvolutionProposal; record: RollbackRecord }> {
    return await this.#enqueue(async () => {
      const working = restoreEvolutionCatalog(this.#trust, this.#catalog.exportDurableMaterial());
      return working.rollback(proposalId, decision, applicationCommandId);
    });
  }

  async propose(
    input: {
      id: string;
      createdAt: string;
      policy: unknown;
      candidate: unknown;
      origin?: "automatic-controller-v1";
    },
    writer?: object,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) => working.propose(input));
    return Object.freeze({ proposal: result, committedRevision });
  }

  async beginEvaluation(
    proposalId: string,
    at: string,
    writer?: object,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.beginEvaluation(proposalId, at),
    );
    return Object.freeze({ proposal: result, committedRevision });
  }

  async evaluate(
    proposalId: string,
    evidence: unknown,
    at: string,
    writer?: object,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.evaluate(proposalId, evidence, at),
    );
    return Object.freeze({ proposal: result, committedRevision });
  }

  async evaluateServerPreflight(
    proposalId: string,
    evidence: unknown,
    at: string,
    writer?: object,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.evaluateServerPreflight(proposalId, evidence, at),
    );
    return Object.freeze({ proposal: result, committedRevision });
  }

  async evaluateAutomaticRun(
    proposalId: string,
    evidence: unknown,
    at: string,
    writer?: object,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.evaluateAutomaticRun(proposalId, evidence, at),
    );
    return Object.freeze({ proposal: result, committedRevision });
  }

  async promote(
    proposalId: string,
    evidence: unknown,
    decision: unknown,
    writer?: object,
    applicationCommandId?: string,
  ): Promise<{
    proposal: EvolutionProposal;
    record: PromotionRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.promote(proposalId, evidence, decision, applicationCommandId),
    );
    return { ...result, committedRevision };
  }

  async reject(
    proposalId: string,
    decision: unknown,
    writer?: object,
  ): Promise<{
    proposal: EvolutionProposal;
    record: RejectionRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.reject(proposalId, decision),
    );
    return { ...result, committedRevision };
  }

  async rollback(
    proposalId: string,
    decision: unknown,
    writer?: object,
    applicationCommandId?: string,
  ): Promise<{
    proposal: EvolutionProposal;
    record: RollbackRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.rollback(proposalId, decision, applicationCommandId),
    );
    return { ...result, committedRevision };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertWriter(writer: object | undefined): void {
    if (this.#exclusiveWriter && writer !== this.#exclusiveWriter) {
      throw new EvolutionPersistenceError(
        "Durable evolution catalog mutations are owned by its application coordinator",
      );
    }
  }

  #mutate<T>(
    operation: (working: EvolutionCatalog) => T,
  ): Promise<{ result: T; committedRevision: number }> {
    return this.#enqueue(async () => await serializeCatalogFileMutation(this.filePath, async () => {
      if (this.#indeterminate) {
        throw new EvolutionPersistenceError(
          "Durable evolution catalog commit outcome is indeterminate; reopen the catalog before another mutation",
        );
      }
      const expectedRevision = this.#revision;

      // Stage against a restored working catalog from the last committed material.
      const material = this.#catalog.exportDurableMaterial();
      const working = restoreEvolutionCatalog(this.#trust, material);
      const result = operation(working);
      const nextMaterial = working.exportDurableMaterial();
      const nextRevision = this.#revision + 1;

      await this.#persist(nextMaterial, nextRevision, expectedRevision);

      // Memory swap only after durable success.
      this.#catalog = working;
      this.#revision = nextRevision;
      return { result, committedRevision: nextRevision };
    }));
  }

  async #persist(
    material: EvolutionCatalogRestoreMaterial,
    nextRevision: number,
    expectedRevision: number,
  ): Promise<void> {
    if (expectedRevision !== this.#revision) {
      throw new EvolutionPersistenceConflictError(
        `Stale durable evolution catalog revision: expected ${expectedRevision}, current ${this.#revision}`,
      );
    }

    await assertRepositoryOwnedStorage(
      this.#io,
      this.root,
      this.stateDirectory,
      this.evolutionDirectory,
      this.filePath,
    );

    try {
      await assertPrimaryFileSafe(this.#io, this.root, this.filePath);
      const existing = await this.#io.readFile(this.filePath, "utf8");
      const restored = restoreFromDocumentText(existing, this.#trust, this.filePath);
      if (restored.revision !== expectedRevision) {
        throw new EvolutionPersistenceConflictError(
          `Stale durable evolution catalog revision on disk: expected ${expectedRevision}, found ${restored.revision}`,
        );
      }
      if (
        !deepEqual(
          restored.catalog.exportDurableMaterial(),
          this.#catalog.exportDurableMaterial(),
        )
      ) {
        throw new EvolutionPersistenceConflictError(
          `Durable evolution catalog changed on disk without advancing revision ${expectedRevision}`,
        );
      }
    } catch (error) {
      if (error instanceof EvolutionPersistenceConflictError) {
        throw error;
      }
      if (!isNotFound(error)) {
        if (error instanceof EvolutionPersistenceError) {
          throw error;
        }
        throw new EvolutionPersistenceValidationError(
          `Unable to read durable evolution catalog at ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (expectedRevision !== 0) {
        throw new EvolutionPersistenceConflictError(
          `Stale durable evolution catalog revision on disk: expected ${expectedRevision}, found missing document`,
        );
      }
    }

    const document = buildDurableDocument(material, nextRevision);
    const serialized = `${JSON.stringify(document)}\n`;

    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;

    try {
      await assertRepositoryOwnedStorage(
        this.#io,
        this.root,
        this.stateDirectory,
        this.evolutionDirectory,
        this.filePath,
      );
      await this.#io.beforeAtomicStage?.("open");
      const handle = await this.#io.open(temporaryPath, "wx", 0o600);
      try {
        await this.#io.beforeAtomicStage?.("write");
        await handle.writeFile(serialized, "utf8");
        await this.#io.beforeAtomicStage?.("file-sync");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await assertRepositoryOwnedStorage(
        this.#io,
        this.root,
        this.stateDirectory,
        this.evolutionDirectory,
        this.filePath,
      );
      await this.#io.beforeAtomicStage?.("rename");
      await this.#io.rename(temporaryPath, this.filePath);
      renamed = true;
      await this.#io.beforeAtomicStage?.("directory-sync");
      await this.#io.syncDirectory(this.evolutionDirectory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (renamed) {
        this.#indeterminate = true;
        throw new EvolutionPersistenceError(
          `Durable evolution catalog rename completed but directory fsync failed; reopen before continuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (error instanceof EvolutionPersistenceError) {
        throw error;
      }
      throw new EvolutionPersistenceError(
        `Failed to persist durable evolution catalog at ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function serializeCatalogFileMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = catalogFileMutationQueues.get(filePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  catalogFileMutationQueues.set(filePath, settled);
  void settled.finally(() => {
    if (catalogFileMutationQueues.get(filePath) === settled) {
      catalogFileMutationQueues.delete(filePath);
    }
  });
  return result;
}

function buildDurableDocument(
  material: EvolutionCatalogRestoreMaterial,
  revision: number,
): DurableDocument {
  const payload: DurablePayload = {
    proposals: material.proposals,
    auditRecords: material.auditRecords,
    activeProposals: material.activeProposals,
    promotionRecords: material.promotionRecords,
  };
  return {
    version: EVOLUTION_DURABLE_DOCUMENT_VERSION,
    revision,
    payloadDigest: computePayloadDigest(payload),
    payload,
  };
}

/**
 * Deterministic SHA-256 over canonical payload JSON.
 * Detects corruption; not authentication against filesystem writers.
 */
export function computePayloadDigest(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

function restoreFromDocumentText(
  contents: string,
  trust: EvolutionTrustContext,
  filePath: string,
): { catalog: EvolutionCatalog; revision: number } {
  let document: unknown;
  try {
    document = JSON.parse(contents) as unknown;
  } catch {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: malformed JSON`,
    );
  }
  return restoreFromDocument(document, trust, filePath);
}

function restoreFromDocument(
  document: unknown,
  trust: EvolutionTrustContext,
  filePath: string,
): { catalog: EvolutionCatalog; revision: number } {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: expected object document`,
    );
  }

  const record = document as Record<string, unknown>;
  assertExactKeys(
    record,
    ["version", "revision", "payloadDigest", "payload"],
    `durable evolution catalog at ${filePath}`,
  );
  if (record.version !== EVOLUTION_DURABLE_DOCUMENT_VERSION) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: unsupported version '${String(record.version)}'`,
    );
  }
  if (!isNonNegativeSafeInteger(record.revision) || record.revision === 0) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: persisted revision must be a positive safe integer`,
    );
  }
  if (typeof record.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.payloadDigest)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payloadDigest must be a lowercase SHA-256 hex string`,
    );
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload must be an object`,
    );
  }

  const payloadRecord = record.payload as Record<string, unknown>;
  assertExactKeys(
    payloadRecord,
    ["proposals", "auditRecords", "activeProposals", "promotionRecords"],
    `durable evolution catalog payload at ${filePath}`,
  );

  const expectedDigest = computePayloadDigest(payloadRecord);
  if (expectedDigest !== record.payloadDigest) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload digest mismatch`,
    );
  }

  if (!Array.isArray(payloadRecord.proposals)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.proposals must be an array`,
    );
  }
  if (!Array.isArray(payloadRecord.auditRecords)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.auditRecords must be an array`,
    );
  }
  if (!Array.isArray(payloadRecord.activeProposals)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.activeProposals must be an array`,
    );
  }
  if (!Array.isArray(payloadRecord.promotionRecords)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.promotionRecords must be an array`,
    );
  }

  const proposals: EvolutionProposal[] = [];
  const proposalById = new Map<string, EvolutionProposal>();
  for (const [index, raw] of payloadRecord.proposals.entries()) {
    let proposal: EvolutionProposal;
    try {
      proposal = parseEvolutionProposal(raw, trust);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.proposals[${index}]: ${message}`,
      );
    }
    if (proposalById.has(proposal.id)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: duplicate proposal id '${proposal.id}'`,
      );
    }
    proposalById.set(proposal.id, proposal);
    proposals.push(proposal);
  }

  const reconstructedRevision = proposals.reduce(
    (total, proposal) => total + 1 + proposal.transitions.length,
    0,
  );
  if (record.revision !== reconstructedRevision) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: revision ${record.revision} does not match ${reconstructedRevision} recorded mutation(s)`,
    );
  }

  const promotionRecords: PromotionRecord[] = [];
  const storedPromotionById = new Map<string, PromotionRecord>();
  for (const [index, raw] of payloadRecord.promotionRecords.entries()) {
    let promotion: PromotionRecord;
    try {
      promotion = parsePromotionRecord(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.promotionRecords[${index}]: ${message}`,
      );
    }
    if (storedPromotionById.has(promotion.proposalId)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: duplicate promotion record for '${promotion.proposalId}'`,
      );
    }
    const proposal = proposalById.get(promotion.proposalId);
    if (!proposal) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: promotion record references missing proposal '${promotion.proposalId}'`,
      );
    }
    try {
      assertPromotionRecordMatchesProposal(promotion, proposal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.promotionRecords[${index}]: ${message}`,
      );
    }
    storedPromotionById.set(promotion.proposalId, promotion);
    promotionRecords.push(promotion);
  }

  const auditRecords: AuditRecord[] = [];
  for (const [index, raw] of payloadRecord.auditRecords.entries()) {
    const parsed = auditRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.auditRecords[${index}] is malformed`,
      );
    }
    auditRecords.push(parsed.data);
  }

  const replayed = replayAuditHistory(auditRecords, proposalById, filePath);
  if (storedPromotionById.size !== replayed.promotionByProposal.size) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: promotion provenance does not match audit history`,
    );
  }
  for (const [proposalId, promotion] of replayed.promotionByProposal) {
    if (!deepEqual(storedPromotionById.get(proposalId), promotion)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: promotion provenance for '${proposalId}' does not match audit history`,
      );
    }
  }

  const activeProposals: EvolutionActiveProposalPointer[] = [];
  const activeKeys = new Set<string>();
  for (const [index, raw] of payloadRecord.activeProposals.entries()) {
    const pointer = parseActivePointer(raw, filePath, index);
    const key = candidateTargetKeyFromTarget(pointer.target);
    if (activeKeys.has(key)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: duplicate active pointer for '${key}'`,
      );
    }
    const proposal = proposalById.get(pointer.proposalId);
    if (!proposal) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: active pointer references missing proposal '${pointer.proposalId}'`,
      );
    }
    if (proposal.status !== "promoted") {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: active pointer '${pointer.proposalId}' requires promoted status`,
      );
    }
    if (candidateTargetKey(proposal.candidate) !== key) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: active pointer target does not match proposal '${pointer.proposalId}'`,
      );
    }
    activeKeys.add(key);
    activeProposals.push(pointer);
  }

  if (activeKeys.size !== replayed.activeByTarget.size) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: active pointers do not match replayed audit history`,
    );
  }
  for (const [targetKey, proposalId] of replayed.activeByTarget) {
    const pointer = activeProposals.find(
      (candidate) => candidateTargetKeyFromTarget(candidate.target) === targetKey,
    );
    if (pointer?.proposalId !== proposalId) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: active pointer for '${targetKey}' does not match replayed proposal '${proposalId}'`,
      );
    }
  }

  const material: EvolutionCatalogRestoreMaterial = {
    proposals,
    auditRecords,
    activeProposals,
    promotionRecords,
  };

  try {
    const catalog = restoreEvolutionCatalog(trust, material);
    return { catalog, revision: record.revision };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: ${message}`,
    );
  }
}

type AuditReplayResult = {
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
};

function replayAuditHistory(
  auditRecords: readonly AuditRecord[],
  proposalById: ReadonlyMap<string, EvolutionProposal>,
  filePath: string,
): AuditReplayResult {
  const promotionByProposal = new Map<string, PromotionRecord>();
  const activeByTarget = new Map<string, string>();
  const counts = new Map<
    string,
    { promotion: number; rejection: number; rollback: number }
  >();
  const applicationCommandIds = new Set<string>();

  for (const [index, audit] of auditRecords.entries()) {
    const proposal = proposalById.get(audit.proposalId);
    if (!proposal) {
      throw invalidHistory(filePath, index, `references missing proposal '${audit.proposalId}'`);
    }
    const count = counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
    count[audit.kind] += 1;
    counts.set(proposal.id, count);
    if (
      audit.kind !== "rejection" &&
      audit.applicationCommandId !== undefined &&
      applicationCommandIds.has(audit.applicationCommandId)
    ) {
      throw invalidHistory(
        filePath,
        index,
        `duplicates application command '${audit.applicationCommandId}'`,
      );
    }
    if (audit.kind !== "rejection" && audit.applicationCommandId !== undefined) {
      applicationCommandIds.add(audit.applicationCommandId);
    }
    const targetKey = candidateTargetKey(proposal.candidate);

    if (audit.kind === "promotion") {
      if (count.promotion !== 1) {
        throw invalidHistory(filePath, index, `duplicates promotion for '${proposal.id}'`);
      }
      try {
        assertPromotionRecordMatchesProposal(audit, proposal);
      } catch (error) {
        throw invalidHistory(
          filePath,
          index,
          error instanceof Error ? error.message : String(error),
        );
      }
      assertAuditTransitionAt(proposal, "evaluated", "promoted", audit.at, filePath, index);
      const currentActive = activeByTarget.get(targetKey) ?? null;
      if (audit.previousActiveProposalId !== currentActive) {
        throw invalidHistory(
          filePath,
          index,
          `promotion previousActiveProposalId must be '${currentActive ?? "null"}'`,
        );
      }
      if (audit.previousActiveProposalId !== null) {
        const previous = proposalById.get(audit.previousActiveProposalId);
        if (
          !previous ||
          candidateTargetKey(previous.candidate) !== targetKey ||
          !promotionByProposal.has(previous.id)
        ) {
          throw invalidHistory(
            filePath,
            index,
            `promotion previous active '${audit.previousActiveProposalId}' is not a prior promotion for the same target`,
          );
        }
      }
      promotionByProposal.set(proposal.id, audit);
      activeByTarget.set(targetKey, proposal.id);
      continue;
    }

    if (audit.kind === "rollback") {
      if (count.rollback !== 1) {
        throw invalidHistory(filePath, index, `duplicates rollback for '${proposal.id}'`);
      }
      const promotion = promotionByProposal.get(proposal.id);
      if (!promotion) {
        throw invalidHistory(filePath, index, `rolls back '${proposal.id}' before its promotion`);
      }
      if (activeByTarget.get(targetKey) !== proposal.id) {
        throw invalidHistory(filePath, index, `rolls back inactive proposal '${proposal.id}'`);
      }
      assertAuditTransitionAt(proposal, "promoted", "rolled-back", audit.at, filePath, index);
      if (audit.restoredActiveProposalId !== promotion.previousActiveProposalId) {
        throw invalidHistory(
          filePath,
          index,
          `rollback restoration does not match promotion provenance for '${proposal.id}'`,
        );
      }
      if (audit.restoredActiveProposalId === null) {
        activeByTarget.delete(targetKey);
      } else {
        const restored = proposalById.get(audit.restoredActiveProposalId);
        if (
          !restored ||
          candidateTargetKey(restored.candidate) !== targetKey ||
          !promotionByProposal.has(restored.id)
        ) {
          throw invalidHistory(
            filePath,
            index,
            `rollback target '${audit.restoredActiveProposalId}' is not a prior promotion for the same target`,
          );
        }
        activeByTarget.set(targetKey, restored.id);
      }
      continue;
    }

    if (count.rejection !== 1) {
      throw invalidHistory(filePath, index, `duplicates rejection for '${proposal.id}'`);
    }
    assertAuditTransitionAt(proposal, "evaluated", "rejected", audit.at, filePath, index);
    if (!proposal.evaluation || !deepEqual(audit.evaluation, proposal.evaluation.result)) {
      throw invalidHistory(
        filePath,
        index,
        `rejection evaluation does not match proposal '${proposal.id}'`,
      );
    }
  }

  for (const proposal of proposalById.values()) {
    const count = counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
    const expected =
      proposal.status === "rejected"
        ? { promotion: 0, rejection: 1, rollback: 0 }
        : proposal.status === "promoted"
          ? { promotion: 1, rejection: 0, rollback: 0 }
          : proposal.status === "rolled-back"
            ? { promotion: 1, rejection: 0, rollback: 1 }
            : { promotion: 0, rejection: 0, rollback: 0 };
    if (!deepEqual(count, expected)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: terminal audit cardinality for proposal '${proposal.id}' does not match status '${proposal.status}'`,
      );
    }
  }

  return { promotionByProposal, activeByTarget };
}

function assertAuditTransitionAt(
  proposal: EvolutionProposal,
  from: EvolutionProposal["status"],
  to: EvolutionProposal["status"],
  at: string,
  filePath: string,
  auditIndex: number,
): void {
  const matches = proposal.transitions.filter(
    (transition) => transition.from === from && transition.to === to,
  );
  if (matches.length !== 1 || matches[0]!.at !== at) {
    throw invalidHistory(
      filePath,
      auditIndex,
      `timestamp does not match '${from}' -> '${to}' transition for '${proposal.id}'`,
    );
  }
}

function invalidHistory(
  filePath: string,
  auditIndex: number,
  message: string,
): EvolutionPersistenceValidationError {
  return new EvolutionPersistenceValidationError(
    `Invalid durable evolution catalog at ${filePath}: payload.auditRecords[${auditIndex}] ${message}`,
  );
}

function parseActivePointer(
  raw: unknown,
  filePath: string,
  index: number,
): EvolutionActiveProposalPointer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}] must be an object`,
    );
  }
  const value = raw as Record<string, unknown>;
  assertExactKeys(
    value,
    ["target", "proposalId"],
    `payload.activeProposals[${index}] at ${filePath}`,
  );
  if (typeof value.proposalId !== "string" || !value.proposalId.trim()) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}].proposalId is required`,
    );
  }
  if (!value.target || typeof value.target !== "object" || Array.isArray(value.target)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}].target is required`,
    );
  }
  const targetRecord = value.target as Record<string, unknown>;
  if (targetRecord.kind === "strategy-blueprint") {
    assertExactKeys(
      targetRecord,
      ["kind", "name"],
      `payload.activeProposals[${index}].target at ${filePath}`,
    );
    if (typeof targetRecord.name !== "string" || !targetRecord.name.trim()) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}].target.name is required`,
      );
    }
    return {
      target: { kind: "strategy-blueprint", name: targetRecord.name },
      proposalId: value.proposalId,
    };
  }
  if (targetRecord.kind === "role-prompt") {
    assertExactKeys(
      targetRecord,
      ["kind", "path"],
      `payload.activeProposals[${index}].target at ${filePath}`,
    );
    if (typeof targetRecord.path !== "string" || !targetRecord.path.trim()) {
      throw new EvolutionPersistenceValidationError(
        `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}].target.path is required`,
      );
    }
    return {
      target: { kind: "role-prompt", path: targetRecord.path },
      proposalId: value.proposalId,
    };
  }
  throw new EvolutionPersistenceValidationError(
    `Invalid durable evolution catalog at ${filePath}: payload.activeProposals[${index}].target.kind is unsupported`,
  );
}

function candidateTargetKey(candidate: EvolutionProposal["candidate"]): string {
  if (candidate.kind === "strategy-blueprint") {
    return `strategy-blueprint:${candidate.name}`;
  }
  return `role-prompt:${candidate.path}`;
}

function candidateTargetKeyFromTarget(target: EvolutionCandidateTarget): string {
  if (target.kind === "strategy-blueprint") {
    return `strategy-blueprint:${target.name}`;
  }
  return `role-prompt:${target.path}`;
}

/**
 * Project config roles may carry `promptFile?: string | undefined` under
 * exactOptionalPropertyTypes. Trust context only accepts an omitted or string
 * `promptFile`, so map roles without writing an explicit undefined property.
 */
function trustRolesFromLoadedConfig(
  roles: LoadedConfig["config"]["roles"],
): Readonly<Record<string, { allowedProfiles: readonly string[]; promptFile?: string }>> {
  const mapped: Record<string, { allowedProfiles: readonly string[]; promptFile?: string }> =
    Object.create(null);
  for (const [roleName, role] of Object.entries(roles)) {
    if (typeof role.promptFile === "string") {
      mapped[roleName] = {
        allowedProfiles: role.allowedProfiles,
        promptFile: role.promptFile,
      };
    } else {
      mapped[roleName] = {
        allowedProfiles: role.allowedProfiles,
      };
    }
  }
  return mapped;
}

function resolveRepositoryOwnedDirectory(
  root: string,
  relativeDirectory: string,
  label: string,
): string {
  if (!relativeDirectory || relativeDirectory.includes("\0")) {
    throw new EvolutionPersistenceValidationError(
      `${label} must be a non-empty repository-relative path`,
    );
  }
  if (relativeDirectory !== relativeDirectory.trim()) {
    throw new EvolutionPersistenceValidationError(
      `${label} must not include leading or trailing whitespace`,
    );
  }
  if (path.isAbsolute(relativeDirectory) || /^[A-Za-z]:[\\/]/.test(relativeDirectory)) {
    throw new EvolutionPersistenceValidationError(
      `${label} must be repository-relative (absolute paths are not allowed)`,
    );
  }
  if (relativeDirectory.includes("\\")) {
    throw new EvolutionPersistenceValidationError(`${label} must use POSIX separators only`);
  }
  const segments = relativeDirectory.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new EvolutionPersistenceValidationError(
      `${label} must not contain empty, '.', or '..' segments`,
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
    throw new EvolutionPersistenceValidationError(
      `${label} must resolve inside the repository root`,
    );
  }
  return resolved;
}

async function createRepositoryOwnedDirectory(
  io: DurableEvolutionFileIo,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvolutionPersistenceValidationError(
      `Evolution storage directory must remain below repository root: ${target}`,
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
  io: DurableEvolutionFileIo,
  root: string,
  stateDirectory: string,
  evolutionDirectory: string,
  filePath: string,
): Promise<void> {
  await assertExistingDirectoryChain(io, root, stateDirectory);
  await assertExistingDirectoryChain(io, root, evolutionDirectory);
  await assertPrimaryFileSafe(io, root, filePath);
}

async function assertExistingDirectoryChain(
  io: DurableEvolutionFileIo,
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvolutionPersistenceValidationError(
      `Evolution storage directory must remain below repository root: ${target}`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await io.lstat(current);
    assertDirectoryEntrySafe(info, current);
  }
  const canonical = await io.realpath(target);
  assertCanonicalPathInsideRoot(root, canonical, "Evolution storage directory");
}

function assertDirectoryEntrySafe(
  info: Awaited<ReturnType<typeof lstat>>,
  entryPath: string,
): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new EvolutionPersistenceValidationError(
      `Evolution storage path component must be a real directory, not a symlink or file: ${entryPath}`,
    );
  }
}

async function assertPrimaryFileSafe(
  io: DurableEvolutionFileIo,
  root: string,
  filePath: string,
): Promise<void> {
  try {
    const info = await io.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EvolutionPersistenceValidationError(
        `Durable evolution catalog must be a regular non-symlink file: ${filePath}`,
      );
    }
    const canonical = await io.realpath(filePath);
    assertCanonicalPathInsideRoot(root, canonical, "Durable evolution catalog");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function assertCanonicalPathInsideRoot(root: string, candidate: string, label: string): void {
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new EvolutionPersistenceValidationError(
      `${label} resolves outside repository root: ${candidate}`,
    );
  }
}

async function cleanOrphanTemporaryFiles(
  io: DurableEvolutionFileIo,
  evolutionDirectory: string,
  filePath: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await io.readdir(evolutionDirectory);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  const prefix = `${path.basename(filePath)}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) {
      continue;
    }
    const absolute = path.join(evolutionDirectory, entry);
    try {
      const info = await io.lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await io.rm(absolute, { force: true });
    } catch {
      // Best-effort cleanup only; never mask primary-document failures.
    }
  }
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  const unexpected = actual.find((key) => !expected.has(key));
  const missing = expectedKeys.find((key) => !Object.hasOwn(record, key));
  if (unexpected || missing || actual.length !== expected.size) {
    throw new EvolutionPersistenceValidationError(
      `Invalid ${label}: expected exactly fields ${expectedKeys.join(", ")}${
        unexpected ? `; unexpected field '${unexpected}'` : ""
      }${missing ? `; missing field '${missing}'` : ""}`,
    );
  }
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}
