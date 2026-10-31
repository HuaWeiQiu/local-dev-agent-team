import { auditTrailViolation, recordTrail } from "./audit-trail.js";
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
  type ArchiveRecord,
  type AuditRecord,
  type DeletionRecord,
  type EvolutionProposal,
  type EvolutionTrustContext,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
  type UnarchiveRecord,
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
function assertLoadedConfig(loaded: LoadedConfig): void {
  if (!loaded || typeof loaded !== "object") {
    throw new EvolutionPersistenceValidationError("LoadedConfig is required");
  }
  if (typeof loaded.root !== "string" || !loaded.root.trim()) {
    throw new EvolutionPersistenceValidationError("LoadedConfig.root is required");
  }
  if (!loaded.config || typeof loaded.config !== "object") {
    throw new EvolutionPersistenceValidationError("LoadedConfig.config is required");
  }
}

/** The realpath of the repository root, which must be a directory. */
async function resolveRepositoryRoot(
  io: DurableEvolutionFileIo,
  configuredRoot: string,
): Promise<string> {
  try {
    const root = await io.realpath(path.resolve(configuredRoot));
    const rootInfo = await io.lstat(root);
    if (!rootInfo.isDirectory()) {
      throw new EvolutionPersistenceValidationError(
        `LoadedConfig.root must resolve to a directory: ${root}`,
      );
    }
    return root;
  } catch (error) {
    if (error instanceof EvolutionPersistenceError) throw error;
    throw new EvolutionPersistenceValidationError(
      `Unable to resolve repository root '${configuredRoot}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function stateDirectoryOf(loaded: LoadedConfig): string {
  const stateDirectoryRelative = loaded.config.project?.stateDirectory;
  if (typeof stateDirectoryRelative !== "string" || !stateDirectoryRelative.trim()) {
    throw new EvolutionPersistenceValidationError(
      "project.stateDirectory must be a non-empty repository-relative path",
    );
  }
  return stateDirectoryRelative;
}

function trustFrom(loaded: LoadedConfig): EvolutionTrustContext {
  try {
    return createEvolutionTrustContext({ roles: trustRolesFromLoadedConfig(loaded.config.roles) });
  } catch (error) {
    if (error instanceof EvolutionDomainError) {
      throw new EvolutionPersistenceValidationError(error.message);
    }
    throw error;
  }
}

async function prepareStorage(
  io: DurableEvolutionFileIo,
  root: string,
  stateDirectory: string,
  evolutionDirectory: string,
  filePath: string,
): Promise<void> {
  await createRepositoryOwnedDirectory(io, root, stateDirectory);
  await createRepositoryOwnedDirectory(io, root, evolutionDirectory);
  await assertRepositoryOwnedStorage(io, root, stateDirectory, evolutionDirectory, filePath);
  await cleanOrphanTemporaryFiles(io, evolutionDirectory, filePath);
}

/** An absent document is a fresh catalog; any other failure is reported. */
async function loadOrCreate(
  io: DurableEvolutionFileIo,
  root: string,
  filePath: string,
  trust: EvolutionTrustContext,
): Promise<{ catalog: EvolutionCatalog; revision: number }> {
  try {
    await assertPrimaryFileSafe(io, root, filePath);
    const contents = await io.readFile(filePath, "utf8");
    return restoreFromDocumentText(contents, trust, filePath);
  } catch (error) {
    if (isNotFound(error)) return { catalog: createEvolutionCatalog(trust), revision: 0 };
    if (error instanceof EvolutionPersistenceError) throw error;
    if (error instanceof EvolutionDomainError) {
      throw new EvolutionPersistenceValidationError(error.message);
    }
    throw error;
  }
}

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
    assertLoadedConfig(loaded);
    const io: DurableEvolutionFileIo = { ...defaultFileIo, ...options.io };
    const root = await resolveRepositoryRoot(io, loaded.root);
    const stateDirectoryRelative = stateDirectoryOf(loaded);
    const stateDirectory = resolveRepositoryOwnedDirectory(
      root,
      stateDirectoryRelative,
      "project.stateDirectory",
    );
    const evolutionDirectory = path.join(stateDirectory, "evolution");
    const filePath = path.join(evolutionDirectory, EVOLUTION_CATALOG_FILENAME);
    const trust = trustFrom(loaded);
    await prepareStorage(io, root, stateDirectory, evolutionDirectory, filePath);
    const { catalog, revision } = await loadOrCreate(io, root, filePath, trust);
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

  async archive(
    proposalId: string,
    decision: unknown,
    writer?: object,
  ): Promise<{
    proposal: EvolutionProposal;
    record: ArchiveRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.archive(proposalId, decision),
    );
    return { ...result, committedRevision };
  }

  async unarchive(
    proposalId: string,
    decision: unknown,
    writer?: object,
  ): Promise<{
    proposal: EvolutionProposal;
    record: UnarchiveRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.unarchive(proposalId, decision),
    );
    return { ...result, committedRevision };
  }

  async deleteProposal(
    proposalId: string,
    decision: unknown,
    writer?: object,
  ): Promise<{
    record: DeletionRecord;
    committedRevision: number;
  }> {
    this.#assertWriter(writer);
    const { result, committedRevision } = await this.#mutate((working) =>
      working.deleteProposal(proposalId, decision),
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
  const record = asDocument(document, filePath);
  assertDocumentHeader(record, filePath);
  const payloadRecord = asPayload(record, filePath);
  const proposalById = proposalsFromPayload(payloadRecord, trust, filePath);
  const storedPromotionById = promotionsFromPayload(payloadRecord, proposalById, filePath);
  const auditRecords = auditsFromPayload(payloadRecord, filePath);
  assertRevision(record, proposalById, auditRecords, filePath);
  const replayed = replayAuditHistory(auditRecords, proposalById, filePath);
  assertProvenance(replayed, storedPromotionById, filePath);
  const activeProposals = activePointersFrom(payloadRecord, proposalById, replayed, filePath);
  return openRestoredCatalog(trust, filePath, Number(record.revision), {
    proposals: [...proposalById.values()],
    auditRecords,
    activeProposals,
    promotionRecords: [...storedPromotionById.values()],
  });
}

function invalid(filePath: string, detail: string): EvolutionPersistenceValidationError {
  return new EvolutionPersistenceValidationError(
    `Invalid durable evolution catalog at ${filePath}: ${detail}`,
  );
}

function asDocument(document: unknown, filePath: string): Record<string, unknown> {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalid(filePath, "expected object document");
  }
  return document as Record<string, unknown>;
}

/** Version, revision and digest are checked before any payload is read. */
function assertDocumentHeader(record: Record<string, unknown>, filePath: string): void {
  assertExactKeys(record, ["version", "revision", "payloadDigest", "payload"], `durable evolution catalog at ${filePath}`);
  if (record.version !== EVOLUTION_DURABLE_DOCUMENT_VERSION) {
    throw invalid(filePath, `unsupported version '${String(record.version)}'`);
  }
  if (!isNonNegativeSafeInteger(record.revision) || record.revision === 0) {
    throw invalid(filePath, "persisted revision must be a positive safe integer");
  }
  if (typeof record.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.payloadDigest)) {
    throw invalid(filePath, "payloadDigest must be a lowercase SHA-256 hex string");
  }
}

function asPayload(record: Record<string, unknown>, filePath: string): Record<string, unknown> {
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw invalid(filePath, "payload must be an object");
  }
  const payloadRecord = record.payload as Record<string, unknown>;
  assertExactKeys(
    payloadRecord,
    ["proposals", "auditRecords", "activeProposals", "promotionRecords"],
    `durable evolution catalog payload at ${filePath}`,
  );
  if (computePayloadDigest(payloadRecord) !== record.payloadDigest) {
    throw invalid(filePath, "payload digest mismatch");
  }
  for (const key of ["proposals", "auditRecords", "activeProposals", "promotionRecords"]) {
    if (!Array.isArray(payloadRecord[key])) {
      throw invalid(filePath, `payload.${key} must be an array`);
    }
  }
  return payloadRecord;
}

function proposalsFromPayload(
  payloadRecord: Record<string, unknown>,
  trust: EvolutionTrustContext,
  filePath: string,
): Map<string, EvolutionProposal> {
  const proposalById = new Map<string, EvolutionProposal>();
  for (const [index, raw] of (payloadRecord.proposals as unknown[]).entries()) {
    const proposal = parseOrThrow(() => parseEvolutionProposal(raw, trust), filePath, `payload.proposals[${index}]`);
    if (proposalById.has(proposal.id)) {
      throw invalid(filePath, `duplicate proposal id '${proposal.id}'`);
    }
    proposalById.set(proposal.id, proposal);
  }
  return proposalById;
}

function promotionsFromPayload(
  payloadRecord: Record<string, unknown>,
  proposalById: Map<string, EvolutionProposal>,
  filePath: string,
): Map<string, PromotionRecord> {
  const stored = new Map<string, PromotionRecord>();
  for (const [index, raw] of (payloadRecord.promotionRecords as unknown[]).entries()) {
    const promotion = parseOrThrow(() => parsePromotionRecord(raw), filePath, `payload.promotionRecords[${index}]`);
    if (stored.has(promotion.proposalId)) {
      throw invalid(filePath, `duplicate promotion record for '${promotion.proposalId}'`);
    }
    const proposal = proposalById.get(promotion.proposalId);
    if (!proposal) {
      throw invalid(filePath, `promotion record references missing proposal '${promotion.proposalId}'`);
    }
    parseOrThrow(
      () => assertPromotionRecordMatchesProposal(promotion, proposal),
      filePath,
      `payload.promotionRecords[${index}]`,
    );
    stored.set(promotion.proposalId, promotion);
  }
  return stored;
}

function auditsFromPayload(payloadRecord: Record<string, unknown>, filePath: string): AuditRecord[] {
  return (payloadRecord.auditRecords as unknown[]).map((raw, index) => {
    const parsed = auditRecordSchema.safeParse(raw);
    if (!parsed.success) throw invalid(filePath, `payload.auditRecords[${index}] is malformed`);
    return parsed.data;
  });
}

function parseOrThrow<T>(parse: () => T, filePath: string, label: string): T {
  try {
    return parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(filePath, `${label}: ${message}`);
  }
}

/**
 * Every mutation bumps the revision once: creation plus transitions per live
 * proposal, one per archival marker, and the tombstone weight per deletion.
 */
function assertRevision(
  record: Record<string, unknown>,
  proposalById: Map<string, EvolutionProposal>,
  auditRecords: AuditRecord[],
  filePath: string,
): void {
  const archivalMutations = auditRecords.filter(
    (audit) => audit.kind === "archive" || audit.kind === "unarchive",
  ).length;
  const deletions = auditRecords.filter((audit) => audit.kind === "delete").length;
  const reconstructed =
    [...proposalById.values()].reduce(
      (total, proposal) => total + 1 + proposal.transitions.length,
      0,
    ) +
    archivalMutations +
    deletions * DELETED_PROPOSAL_REVISION_WEIGHT;
  if (record.revision !== reconstructed) {
    throw invalid(filePath, `revision ${String(record.revision)} does not match ${reconstructed} recorded mutation(s)`);
  }
}

function assertProvenance(
  replayed: AuditReplayResult,
  stored: Map<string, PromotionRecord>,
  filePath: string,
): void {
  if (stored.size !== replayed.promotionByProposal.size) {
    throw invalid(filePath, "promotion provenance does not match audit history");
  }
  for (const [proposalId, promotion] of replayed.promotionByProposal) {
    if (!deepEqual(stored.get(proposalId), promotion)) {
      throw invalid(filePath, `promotion provenance for '${proposalId}' does not match audit history`);
    }
  }
}

/** Pointers must agree with the replay in both directions. */
function activePointersFrom(
  payloadRecord: Record<string, unknown>,
  proposalById: Map<string, EvolutionProposal>,
  replayed: AuditReplayResult,
  filePath: string,
): EvolutionActiveProposalPointer[] {
  const activeProposals = (payloadRecord.activeProposals as unknown[]).map((raw, index) =>
    parseActivePointer(raw, filePath, index),
  );
  const activeKeys = new Set<string>();
  for (const pointer of activeProposals) {
    const key = candidateTargetKeyFromTarget(pointer.target);
    if (activeKeys.has(key)) throw invalid(filePath, `duplicate active pointer for '${key}'`);
    assertPointerMatches(pointer, key, proposalById, filePath);
    activeKeys.add(key);
  }
  if (activeKeys.size !== replayed.activeByTarget.size) {
    throw invalid(filePath, "active pointers do not match replayed audit history");
  }
  for (const [targetKey, proposalId] of replayed.activeByTarget) {
    const pointer = activeProposals.find(
      (candidate) => candidateTargetKeyFromTarget(candidate.target) === targetKey,
    );
    if (pointer?.proposalId !== proposalId) {
      throw invalid(filePath, `active pointer for '${targetKey}' does not match replayed proposal '${proposalId}'`);
    }
  }
  return activeProposals;
}

function assertPointerMatches(
  pointer: EvolutionActiveProposalPointer,
  key: string,
  proposalById: Map<string, EvolutionProposal>,
  filePath: string,
): void {
  const proposal = proposalById.get(pointer.proposalId);
  if (!proposal) {
    throw invalid(filePath, `active pointer references missing proposal '${pointer.proposalId}'`);
  }
  if (proposal.status !== "promoted") {
    throw invalid(filePath, `active pointer '${pointer.proposalId}' requires promoted status`);
  }
  if (candidateTargetKey(proposal.candidate) !== key) {
    throw invalid(filePath, `active pointer target does not match proposal '${pointer.proposalId}'`);
  }
}

function openRestoredCatalog(
  trust: EvolutionTrustContext,
  filePath: string,
  revision: number,
  material: EvolutionCatalogRestoreMaterial,
): { catalog: EvolutionCatalog; revision: number } {
  return parseOrThrow(
    () => ({ catalog: restoreEvolutionCatalog(trust, material), revision }),
    filePath,
    "restore",
  );
}

type AuditReplayResult = {
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
};

/**
 * Revision weight of a deletion tombstone: the deleted proposal was necessarily
 * rejected first, and the only lifecycle path to 'rejected' is
 * proposed → evaluating → evaluated → rejected, so its removal hides exactly
 * 1 (creation) + 3 (transitions) recorded mutations; +1 for the deletion.
 */
const DELETED_PROPOSAL_REVISION_WEIGHT = 5;

function replayAuditHistory(
  auditRecords: readonly AuditRecord[],
  proposalById: ReadonlyMap<string, EvolutionProposal>,
  filePath: string,
): AuditReplayResult {
  const replay: AuditReplay = {
    filePath,
    proposalById,
    promotionByProposal: new Map(),
    activeByTarget: new Map(),
    counts: new Map(),
    applicationCommandIds: new Set(),
    archivalStates: new Map(),
    deletedTrails: new Map(),
  };
  for (const [index, audit] of auditRecords.entries()) applyAuditAt(replay, index, audit);
  finishReplay(replay);
  return { promotionByProposal: replay.promotionByProposal, activeByTarget: replay.activeByTarget };
}

interface AuditReplay {
  filePath: string;
  proposalById: ReadonlyMap<string, EvolutionProposal>;
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
  counts: Map<string, { promotion: number; rejection: number; rollback: number }>;
  applicationCommandIds: Set<string>;
  archivalStates: Map<string, { archived: boolean; at: string | null }>;
  deletedTrails: Map<string, Array<{ index: number; audit: AuditRecord }>>;
}

/** A deleted proposal's trail, an archival marker, or a terminal decision. */
function applyAuditAt(replay: AuditReplay, index: number, audit: AuditRecord): void {
  const proposal = replay.proposalById.get(audit.proposalId);
  if (!proposal) return recordTrailAt(replay, index, audit);
  if (audit.kind === "delete") {
    throw invalidHistory(replay.filePath, index, `deletes live proposal '${proposal.id}'`);
  }
  claimCommandAt(replay, index, audit);
  if (audit.kind === "archive" || audit.kind === "unarchive") {
    return applyArchivalAt(replay, index, audit, proposal);
  }
  applyDecisionAt(replay, index, audit, proposal);
}

function recordTrailAt(replay: AuditReplay, index: number, audit: AuditRecord): void {
  const trail = replay.deletedTrails.get(audit.proposalId) ?? [];
  replay.deletedTrails.set(
    audit.proposalId,
    recordTrail(trail, index, audit, (at, message) => {
      throw invalidHistory(replay.filePath, at, message);
    }),
  );
}

function claimCommandAt(replay: AuditReplay, index: number, audit: AuditRecord): void {
  const commandId = "applicationCommandId" in audit ? audit.applicationCommandId : undefined;
  if (commandId === undefined) return;
  if (replay.applicationCommandIds.has(commandId)) {
    throw invalidHistory(replay.filePath, index, `duplicates application command '${commandId}'`);
  }
  replay.applicationCommandIds.add(commandId);
}

function applyArchivalAt(
  replay: AuditReplay,
  index: number,
  audit: AuditRecord,
  proposal: EvolutionProposal,
): void {
  const state = replay.archivalStates.get(proposal.id) ?? { archived: false, at: null };
  const archiving = audit.kind === "archive";
  if (archiving === state.archived) {
    throw invalidHistory(
      replay.filePath,
      index,
      archiving ? `duplicates archive for '${proposal.id}'` : `unarchives non-archived proposal '${proposal.id}'`,
    );
  }
  replay.archivalStates.set(proposal.id, {
    archived: archiving,
    at: archiving ? (audit as { at: string }).at : null,
  });
}

type DecisionKind = "promotion" | "rejection" | "rollback";

function applyDecisionAt(
  replay: AuditReplay,
  index: number,
  audit: AuditRecord,
  proposal: EvolutionProposal,
): void {
  const kind = audit.kind as DecisionKind;
  const count = replay.counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
  count[kind] += 1;
  replay.counts.set(proposal.id, count);
  if (kind === "promotion") return applyPromotionAt(replay, index, audit, proposal, count);
  if (kind === "rollback") return applyRollbackAt(replay, index, audit, proposal, count);
  applyRejectionAt(replay, index, audit, proposal, count);
}

function applyPromotionAt(
  replay: AuditReplay,
  index: number,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { promotion: number },
): void {
  if (count.promotion !== 1) {
    throw invalidHistory(replay.filePath, index, `duplicates promotion for '${proposal.id}'`);
  }
  const promotion = audit as Extract<AuditRecord, { kind: "promotion" }>;
  assertPromotionMatches(replay, index, promotion, proposal);
  assertAuditTransitionAt(proposal, "evaluated", "promoted", promotion.at, replay.filePath, index);
  const targetKey = candidateTargetKey(proposal.candidate);
  assertPromotionChainAt(replay, index, promotion, targetKey);
  replay.promotionByProposal.set(proposal.id, promotion);
  replay.activeByTarget.set(targetKey, proposal.id);
}

function assertPromotionMatches(
  replay: AuditReplay,
  index: number,
  promotion: Extract<AuditRecord, { kind: "promotion" }>,
  proposal: EvolutionProposal,
): void {
  try {
    assertPromotionRecordMatchesProposal(promotion, proposal);
  } catch (error) {
    throw invalidHistory(replay.filePath, index, error instanceof Error ? error.message : String(error));
  }
}

/** The declared predecessor must be the proposal the replay already promoted. */
function assertPromotionChainAt(
  replay: AuditReplay,
  index: number,
  promotion: Extract<AuditRecord, { kind: "promotion" }>,
  targetKey: string,
): void {
  const currentActive = replay.activeByTarget.get(targetKey) ?? null;
  if (promotion.previousActiveProposalId !== currentActive) {
    throw invalidHistory(
      replay.filePath,
      index,
      `promotion previousActiveProposalId must be '${currentActive ?? "null"}'`,
    );
  }
  if (currentActive === null) return;
  if (!isPriorPromotion(replay, currentActive, targetKey)) {
    throw invalidHistory(
      replay.filePath,
      index,
      `promotion previous active '${currentActive}' is not a prior promotion for the same target`,
    );
  }
}

function applyRollbackAt(
  replay: AuditReplay,
  index: number,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { rollback: number },
): void {
  if (count.rollback !== 1) {
    throw invalidHistory(replay.filePath, index, `duplicates rollback for '${proposal.id}'`);
  }
  const rollback = audit as Extract<AuditRecord, { kind: "rollback" }>;
  const targetKey = candidateTargetKey(proposal.candidate);
  const promotion = replay.promotionByProposal.get(proposal.id);
  if (!promotion) {
    throw invalidHistory(replay.filePath, index, `rolls back '${proposal.id}' before its promotion`);
  }
  if (replay.activeByTarget.get(targetKey) !== proposal.id) {
    throw invalidHistory(replay.filePath, index, `rolls back inactive proposal '${proposal.id}'`);
  }
  assertAuditTransitionAt(proposal, "promoted", "rolled-back", rollback.at, replay.filePath, index);
  assertRollbackProvenance(replay, index, rollback, promotion, proposal.id);
  restoreActiveAt(replay, index, rollback.restoredActiveProposalId, targetKey);
}

function assertRollbackProvenance(
  replay: AuditReplay,
  index: number,
  rollback: Extract<AuditRecord, { kind: "rollback" }>,
  promotion: PromotionRecord,
  proposalId: string,
): void {
  if (rollback.restoredActiveProposalId === promotion.previousActiveProposalId) return;
  throw invalidHistory(
    replay.filePath,
    index,
    `rollback restoration does not match promotion provenance for '${proposalId}'`,
  );
}

function restoreActiveAt(
  replay: AuditReplay,
  index: number,
  restoredId: string | null,
  targetKey: string,
): void {
  if (restoredId === null) {
    replay.activeByTarget.delete(targetKey);
    return;
  }
  if (!isPriorPromotion(replay, restoredId, targetKey)) {
    throw invalidHistory(
      replay.filePath,
      index,
      `rollback target '${restoredId}' is not a prior promotion for the same target`,
    );
  }
  replay.activeByTarget.set(targetKey, restoredId);
}

function isPriorPromotion(replay: AuditReplay, id: string, targetKey: string): boolean {
  const previous = replay.proposalById.get(id);
  if (!previous) return false;
  if (candidateTargetKey(previous.candidate) !== targetKey) return false;
  return replay.promotionByProposal.has(previous.id);
}

function applyRejectionAt(
  replay: AuditReplay,
  index: number,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { rejection: number },
): void {
  if (count.rejection !== 1) {
    throw invalidHistory(replay.filePath, index, `duplicates rejection for '${proposal.id}'`);
  }
  const rejection = audit as Extract<AuditRecord, { kind: "rejection" }>;
  assertAuditTransitionAt(proposal, "evaluated", "rejected", rejection.at, replay.filePath, index);
  if (!proposal.evaluation || !deepEqual(rejection.evaluation, proposal.evaluation.result)) {
    throw invalidHistory(
      replay.filePath,
      index,
      `rejection evaluation does not match proposal '${proposal.id}'`,
    );
  }
}

/** After the loop: deleted trails, archival state, then terminal cardinality. */
function finishReplay(replay: AuditReplay): void {
  for (const [proposalId, trail] of replay.deletedTrails) {
    assertDeletedAuditTrail(replay.filePath, proposalId, trail);
  }
  for (const proposal of replay.proposalById.values()) assertArchival(replay, proposal);
  for (const proposal of replay.proposalById.values()) assertCardinality(replay, proposal);
}

function assertArchival(replay: AuditReplay, proposal: EvolutionProposal): void {
  const state = replay.archivalStates.get(proposal.id) ?? { archived: false, at: null };
  if (
    state.archived === (proposal.archivedAt !== undefined) &&
    (!state.archived || proposal.archivedAt === state.at)
  ) {
    return;
  }
  throw new EvolutionPersistenceValidationError(
    `Invalid durable evolution catalog at ${replay.filePath}: archival state for proposal '${proposal.id}' does not match audit history`,
  );
}

const EXPECTED_COUNTS: Record<string, { promotion: number; rejection: number; rollback: number }> = {
  rejected: { promotion: 0, rejection: 1, rollback: 0 },
  promoted: { promotion: 1, rejection: 0, rollback: 0 },
  "rolled-back": { promotion: 1, rejection: 0, rollback: 1 },
};

const NO_DECISIONS = { promotion: 0, rejection: 0, rollback: 0 };

function assertCardinality(replay: AuditReplay, proposal: EvolutionProposal): void {
  const count = replay.counts.get(proposal.id) ?? NO_DECISIONS;
  if (deepEqual(count, EXPECTED_COUNTS[proposal.status] ?? NO_DECISIONS)) return;
  throw new EvolutionPersistenceValidationError(
    `Invalid durable evolution catalog at ${replay.filePath}: terminal audit cardinality for proposal '${proposal.id}' does not match status '${proposal.status}'`,
  );
}


/**
 * Validate the retained audit trail of a deleted proposal: exactly one
 * rejection first, exactly one deletion tombstone last, and alternating
 * archive/unarchive markers in between.
 */
export function assertDeletedAuditTrail(
  filePath: string,
  proposalId: string,
  trail: ReadonlyArray<{ index: number; audit: AuditRecord }>,
): void {
  const violation = auditTrailViolation(trail.map((entry) => entry.audit.kind));
  if (!violation) return;
  const index = trail[violation.index]?.index ?? violation.index;
  throw invalidHistory(filePath, index, violation.message(proposalId));
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
  const label = `payload.activeProposals[${index}]`;
  const value = pointerObject(raw, filePath, `${label} must be an object`);
  assertExactKeys(value, ["target", "proposalId"], `${label} at ${filePath}`);
  const proposalId = pointerString(value.proposalId, filePath, `${label}.proposalId is required`);
  const target = pointerObject(value.target, filePath, `${label}.target is required`);
  return { target: pointerTarget(target, filePath, label), proposalId };
}

function pointerObject(raw: unknown, filePath: string, detail: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(filePath, detail);
  return raw as Record<string, unknown>;
}

function pointerString(value: unknown, filePath: string, detail: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(filePath, detail);
  return value;
}

type PointerTarget = EvolutionActiveProposalPointer["target"];

/** One reader per supported target kind, mirroring the catalog. */
const POINTER_TARGETS: Record<
  string,
  (target: Record<string, unknown>, filePath: string, label: string) => PointerTarget
> = {
  "strategy-blueprint": (target, filePath, label) => {
    assertExactKeys(target, ["kind", "name"], `${label}.target at ${filePath}`);
    return {
      kind: "strategy-blueprint",
      name: pointerString(target.name, filePath, `${label}.target.name is required`),
    };
  },
  "role-prompt": (target, filePath, label) => {
    assertExactKeys(target, ["kind", "path"], `${label}.target at ${filePath}`);
    return {
      kind: "role-prompt",
      path: pointerString(target.path, filePath, `${label}.target.path is required`),
    };
  },
};

function pointerTarget(
  target: Record<string, unknown>,
  filePath: string,
  label: string,
): PointerTarget {
  const read = POINTER_TARGETS[String(target.kind)];
  if (!read) throw invalid(filePath, `${label}.target.kind is unsupported`);
  return read(target, filePath, label);
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
  assertRelativeDirectory(relativeDirectory, label);
  const segments = relativeDirectory.split("/");
  assertSafeSegments(segments, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix(resolvedRoot))) {
    throw new EvolutionPersistenceValidationError(
      `${label} must resolve inside the repository root`,
    );
  }
  return resolved;
}

/** One guard per rule; the first violation names the field. */
function assertRelativeDirectory(relativeDirectory: string, label: string): void {
  const violations: Array<[boolean, string]> = [
    [
      !relativeDirectory || relativeDirectory.includes("\0"),
      "must be a non-empty repository-relative path",
    ],
    [
      relativeDirectory !== relativeDirectory.trim(),
      "must not include leading or trailing whitespace",
    ],
    [
      path.isAbsolute(relativeDirectory) || /^[A-Za-z]:[\\/]/.test(relativeDirectory),
      "must be repository-relative (absolute paths are not allowed)",
    ],
    [relativeDirectory.includes("\\"), "must use POSIX separators only"],
  ];
  for (const [violated, detail] of violations) {
    if (violated) throw new EvolutionPersistenceValidationError(`${label} ${detail}`);
  }
}

function assertSafeSegments(segments: string[], label: string): void {
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new EvolutionPersistenceValidationError(
      `${label} must not contain empty, '.', or '..' segments`,
    );
  }
}

function rootPrefix(resolvedRoot: string): string {
  return resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
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

/** One guard per rule; the first violation names the field. */
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

/** A missing directory simply has no orphans. */
async function listOrSkip(
  io: DurableEvolutionFileIo,
  evolutionDirectory: string,
): Promise<string[] | undefined> {
  try {
    return await io.readdir(evolutionDirectory);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isTemporaryFor(entry: string, prefix: string): boolean {
  return entry.startsWith(prefix) && entry.endsWith(".tmp");
}

async function cleanOrphanTemporaryFiles(
  io: DurableEvolutionFileIo,
  evolutionDirectory: string,
  filePath: string,
): Promise<void> {
  const entries = await listOrSkip(io, evolutionDirectory);
  if (!entries) return;
  const prefix = `${path.basename(filePath)}.`;
  for (const entry of entries) {
    if (!isTemporaryFor(entry, prefix)) continue;
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

/** Windows reports directory fsync as one of these codes instead. */
const UNSUPPORTED_SYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]);

export function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = errorCode(error);
  return code !== undefined && UNSUPPORTED_SYNC_CODES.has(code);
}

async function defaultSyncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    handle = await openAsync(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
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
