import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const EXPERIENCE_CATALOG_VERSION = 1 as const;

export const experienceStatusSchema = z.enum([
  "candidate",
  "verified",
  "rejected",
  "retired",
]);

export const experienceSensitivitySchema = z.enum(["low", "medium", "high"]);
export const experienceScopeSchema = z.enum(["project", "shared"]);
export const experiencePortabilitySchema = z.enum(["project-bound", "cross-project"]);

export const experienceEntrySchema = z
  .object({
    id: z.string().uuid(),
    project: z.string().min(1),
    status: experienceStatusSchema,
    summary: z.string().trim().min(1).max(2_000),
    conditions: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
    sourceRunId: z.string().min(1),
    suiteDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    sensitivity: experienceSensitivitySchema.default("low"),
    scope: experienceScopeSchema.default("project"),
    portability: experiencePortabilitySchema.default("project-bound"),
    tags: z.array(z.string().trim().min(1).max(64)).max(16).default([]),
    sourceProjectId: z.string().trim().min(1).max(200).optional(),
    hitCount: z.number().int().min(0).default(0),
    successCount: z.number().int().min(0).default(0),
    failureReason: z.string().trim().max(2_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    verifiedAt: z.string().datetime().optional(),
    verifiedBy: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type ExperienceStatus = z.infer<typeof experienceStatusSchema>;
export type ExperienceSensitivity = z.infer<typeof experienceSensitivitySchema>;
export type ExperienceScope = z.infer<typeof experienceScopeSchema>;
export type ExperiencePortability = z.infer<typeof experiencePortabilitySchema>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;

export const experienceAuditSchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    actor: z.string().trim().min(1).max(200),
    action: z.enum(["extract", "promote", "reject", "retire", "retrieve", "share", "import"]),
    experienceId: z.string().uuid(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ExperienceAuditRecord = z.infer<typeof experienceAuditSchema>;

export const experienceCatalogSchema = z
  .object({
    version: z.literal(EXPERIENCE_CATALOG_VERSION),
    project: z.string().min(1),
    entries: z.array(experienceEntrySchema).default([]),
    audit: z.array(experienceAuditSchema).default([]),
  })
  .strict();

export type ExperienceCatalogDocument = z.infer<typeof experienceCatalogSchema>;

export interface ExtractExperienceInput {
  project: string;
  summary: string;
  conditions?: string[];
  sourceRunId: string;
  suiteDigest?: string;
  sensitivity?: ExperienceSensitivity;
  scope?: ExperienceScope;
  portability?: ExperiencePortability;
  tags?: string[];
  sourceProjectId?: string;
  actor?: string;
  reason?: string;
}

/**
 * Durable experience catalog (v1).
 * - candidate: extracted from completed runs; never auto-injected into prompts
 * - verified: only after explicit promote; may be retrieved for future use
 * - rejected/retired: kept for audit, not retrieved
 */
export class ExperienceCatalog {
  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  get path(): string {
    return this.filePath;
  }

  static defaultPath(stateRoot: string): string {
    return path.join(stateRoot, "experience", "catalog.json");
  }

  async load(): Promise<ExperienceCatalogDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return experienceCatalogSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) {
        return {
          version: EXPERIENCE_CATALOG_VERSION,
          project: path.basename(path.dirname(path.dirname(this.filePath))),
          entries: [],
          audit: [],
        };
      }
      throw error;
    }
  }

  async has(experienceId: string): Promise<boolean> {
    const doc = await this.load();
    return doc.entries.some((entry) => entry.id === experienceId);
  }

  async extract(input: ExtractExperienceInput): Promise<ExperienceEntry> {
    const doc = await this.load();
    const timestamp = new Date(this.now()).toISOString();
    const entry: ExperienceEntry = {
      id: randomUUID(),
      project: input.project,
      status: "candidate",
      summary: input.summary.trim(),
      conditions: input.conditions ?? [],
      sourceRunId: input.sourceRunId,
      ...(input.suiteDigest ? { suiteDigest: input.suiteDigest } : {}),
      sensitivity: input.sensitivity ?? "low",
      scope: input.scope ?? "project",
      portability: input.portability ?? "project-bound",
      tags: input.tags ?? [],
      ...(input.sourceProjectId ? { sourceProjectId: input.sourceProjectId } : {}),
      hitCount: 0,
      successCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    experienceEntrySchema.parse(entry);
    doc.project = input.project;
    doc.entries.push(entry);
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor: input.actor ?? "system:extract",
      action: "extract",
      experienceId: entry.id,
      reason: input.reason ?? "Extracted candidate experience from completed run",
    });
    await this.save(doc);
    return entry;
  }

  async promote(
    experienceId: string,
    actor: string,
    reason: string,
    options: { suiteDigest?: string } = {},
  ): Promise<ExperienceEntry> {
    const doc = await this.load();
    const entry = requireEntry(doc, experienceId);
    if (entry.status !== "candidate") {
      throw new Error(
        `Experience '${experienceId}' cannot be promoted from status '${entry.status}'`,
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    entry.status = "verified";
    entry.verifiedAt = timestamp;
    entry.verifiedBy = actor;
    entry.updatedAt = timestamp;
    if (options.suiteDigest) {
      entry.suiteDigest = options.suiteDigest;
    }
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor,
      action: "promote",
      experienceId,
      reason,
    });
    await this.save(doc);
    return { ...entry };
  }

  async reject(
    experienceId: string,
    actor: string,
    reason: string,
  ): Promise<ExperienceEntry> {
    const doc = await this.load();
    const entry = requireEntry(doc, experienceId);
    if (entry.status !== "candidate" && entry.status !== "verified") {
      throw new Error(
        `Experience '${experienceId}' cannot be rejected from status '${entry.status}'`,
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    entry.status = "rejected";
    entry.failureReason = reason;
    entry.updatedAt = timestamp;
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor,
      action: "reject",
      experienceId,
      reason,
    });
    await this.save(doc);
    return { ...entry };
  }

  /**
   * Retire a verified experience: kept for audit, excluded from retrieval.
   * There is no un-retire action in the v1 audit model.
   */
  async retire(
    experienceId: string,
    actor: string,
    reason: string,
  ): Promise<ExperienceEntry> {
    const doc = await this.load();
    const entry = requireEntry(doc, experienceId);
    if (entry.status !== "verified") {
      throw new Error(
        `Experience '${experienceId}' cannot be retired from status '${entry.status}'`,
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    entry.status = "retired";
    entry.updatedAt = timestamp;
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor,
      action: "retire",
      experienceId,
      reason,
    });
    await this.save(doc);
    return { ...entry };
  }

  /**
   * Import an already-verified experience (e.g. into the shared catalog).
   * Keeps a new id so project and shared copies remain independent.
   */
  async importVerified(
    input: ExperienceEntry & { actor: string; reason: string },
  ): Promise<ExperienceEntry> {
    const doc = await this.load();
    const timestamp = new Date(this.now()).toISOString();
    const entry: ExperienceEntry = {
      id: randomUUID(),
      project: input.project,
      status: "verified",
      summary: input.summary,
      conditions: input.conditions,
      sourceRunId: input.sourceRunId,
      ...(input.suiteDigest ? { suiteDigest: input.suiteDigest } : {}),
      sensitivity: input.sensitivity,
      scope: "shared",
      portability: "cross-project",
      tags: input.tags,
      ...(input.sourceProjectId ? { sourceProjectId: input.sourceProjectId } : {}),
      hitCount: 0,
      successCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      verifiedAt: timestamp,
      verifiedBy: input.actor,
    };
    experienceEntrySchema.parse(entry);
    doc.project = doc.project || "__shared__";
    if (doc.project === path.basename(path.dirname(path.dirname(this.filePath)))) {
      doc.project = "__shared__";
    }
    doc.entries.push(entry);
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor: input.actor,
      action: "import",
      experienceId: entry.id,
      reason: input.reason,
    });
    doc.audit.push({
      id: randomUUID(),
      at: timestamp,
      actor: input.actor,
      action: "share",
      experienceId: entry.id,
      reason: `Shared from project experience ${input.id}`,
    });
    await this.save(doc);
    return entry;
  }

  /**
   * Retrieve only verified experiences. Candidate entries are never returned.
   * Records a retrieve audit entry for transparency unless `recordHit` is false
   * (read-only previews, e.g. UI retrieval preview, must not inflate hitCount).
   */
  async retrieveVerified(
    options: {
      actor?: string;
      reason?: string;
      query?: string;
      limit?: number;
      recordHit?: boolean;
    } = {},
  ): Promise<ExperienceEntry[]> {
    const doc = await this.load();
    const query = options.query?.trim().toLowerCase();
    let entries = doc.entries.filter((entry) => entry.status === "verified");
    if (query) {
      const tokens = query.split(/\s+/).filter(Boolean);
      entries = entries.filter((entry) => {
        const haystack = [
          entry.summary,
          ...entry.conditions,
          ...entry.tags,
        ]
          .join(" ")
          .toLowerCase();
        if (tokens.length === 0) return true;
        // Prefer soft match: any token hits, or full substring
        return tokens.some((token) => haystack.includes(token)) || haystack.includes(query);
      });
    }
    const limit = options.limit ?? 20;
    const selected = entries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));

    if (selected.length > 0 && options.recordHit !== false) {
      const timestamp = new Date(this.now()).toISOString();
      for (const entry of selected) {
        const live = requireEntry(doc, entry.id);
        live.hitCount += 1;
        live.updatedAt = timestamp;
        entry.hitCount = live.hitCount;
        entry.updatedAt = timestamp;
        doc.audit.push({
          id: randomUUID(),
          at: timestamp,
          actor: options.actor ?? "system:retrieve",
          action: "retrieve",
          experienceId: entry.id,
          reason: options.reason ?? "Retrieved verified experience",
        });
      }
      await this.save(doc);
    }
    return selected;
  }

  async list(status?: ExperienceStatus): Promise<ExperienceEntry[]> {
    const doc = await this.load();
    return doc.entries
      .filter((entry) => (status ? entry.status === status : true))
      .map((entry) => ({ ...entry }));
  }

  /** Increment successCount for verified experiences that helped a later success. */
  async recordSuccess(experienceIds: string[]): Promise<number> {
    if (experienceIds.length === 0) return 0;
    const doc = await this.load();
    const idSet = new Set(experienceIds);
    let updated = 0;
    const timestamp = new Date(this.now()).toISOString();
    for (const entry of doc.entries) {
      if (!idSet.has(entry.id) || entry.status !== "verified") continue;
      entry.successCount += 1;
      entry.updatedAt = timestamp;
      updated += 1;
      doc.audit.push({
        id: randomUUID(),
        at: timestamp,
        actor: "system:success",
        action: "retrieve",
        experienceId: entry.id,
        reason: "Recorded successful outcome after experience was used",
      });
    }
    if (updated > 0) await this.save(doc);
    return updated;
  }

  /** Stable digest of verified knowledge only — for evidence binding. */
  async verifiedDigest(): Promise<string> {
    const verified = await this.list("verified");
    return createHash("sha256")
      .update(
        JSON.stringify(
          verified.map((entry) => ({
            id: entry.id,
            summary: entry.summary,
            conditions: entry.conditions,
            suiteDigest: entry.suiteDigest ?? null,
          })),
        ),
      )
      .digest("hex");
  }

  private async save(doc: ExperienceCatalogDocument): Promise<void> {
    const parsed = experienceCatalogSchema.parse(doc);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
  }
}

function requireEntry(
  doc: ExperienceCatalogDocument,
  experienceId: string,
): ExperienceEntry {
  const entry = doc.entries.find((item) => item.id === experienceId);
  if (!entry) {
    throw new Error(`Unknown experience id '${experienceId}'`);
  }
  return entry;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
