import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import { ExperienceCatalog } from "../src/experience/catalog.js";
import {
  parseReasoningBank,
  stableExperienceId,
  toExperienceEntries,
} from "../src/experience/reasoning-bank.js";
import { ExperienceService } from "../src/experience/service.js";

const MARKDOWN = `# Reasoning Bank — demo

Entry format:

\`\`\`markdown
### <one-line title>
- applies when: <task pattern>
- strategy: <what to do>
- source: success | failure
- status: active | retired
\`\`\`

---

## Entries

### Approval gate timeout ends a run as blocked
- applies when: a run stops at awaiting-human and nobody approves in time
- strategy: keep the gate short, or merge the integration branch by hand
- source: failure (2026-08-31): run 1 expired after 3600s
- status: active

### Wrap the parser in a pure function
- applies when: markdown owned by a curator must reach a typed store
- strategy: parse to a plain list first, then map to the typed schema
- source: success (2026-10-30): import path shipped with tests
- status: retired (superseded)
`;

describe("reasoning bank bridge", () => {
  it("parses entries and ignores the fenced format example", () => {
    const entries = parseReasoningBank(MARKDOWN);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Approval gate timeout ends a run as blocked",
      "Wrap the parser in a pure function",
    ]);
    expect(entries[0]).toMatchObject({
      appliesWhen: "a run stops at awaiting-human and nobody approves in time",
      strategy: "keep the gate short, or merge the integration branch by hand",
      status: "active",
    });
    expect(entries[1]?.status).toBe("retired");
  });

  it("skips entries without a strategy", () => {
    const entries = parseReasoningBank("### Only a title\n- source: failure\n");
    expect(entries).toEqual([]);
  });

  it("maps entries to candidates with stable, project-scoped ids", () => {
    const parsed = parseReasoningBank(MARKDOWN);
    const context = { project: "demo", sourcePath: "agent-memory/reasoning-bank.md", now: "2026-10-30T00:00:00.000Z" };
    const first = toExperienceEntries(parsed, context);
    const second = toExperienceEntries(parsed, context);

    expect(first[0]?.entry.status).toBe("candidate");
    expect(first[0]?.entry.id).toBe(second[0]?.entry.id);
    expect(first[0]?.entry.id).toBe(
      stableExperienceId("demo", "Approval gate timeout ends a run as blocked"),
    );
    expect(first[0]?.entry.tags).toContain("source:failure");
    expect(first[0]?.entry.tags).toContain("status:active");
    expect(first[0]?.entry.summary).toContain("Approval gate timeout");
    expect(first[0]?.entry.verifiedAt).toBeUndefined();
    expect(first[0]?.entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("imports idempotently and never injects an imported entry before promotion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-reasoning-bank-"));
    const catalog = new ExperienceCatalog(ExperienceCatalog.defaultPath(root));
    const parsed = parseReasoningBank(MARKDOWN);
    const items = toExperienceEntries(parsed, {
      project: "demo",
      sourcePath: "agent-memory/reasoning-bank.md",
      now: "2026-10-30T00:00:00.000Z",
    });

    const first = await catalog.importCandidates(items, {
      actor: "operator",
      reason: "first import",
    });
    expect(first.added).toHaveLength(2);
    expect(first.unchanged).toHaveLength(0);

    const second = await catalog.importCandidates(items, {
      actor: "operator",
      reason: "second import",
    });
    expect(second.added).toHaveLength(0);
    expect(second.unchanged).toHaveLength(2);

    // Imported entries stay candidates: the retrieval path still returns nothing.
    expect(await catalog.retrieveVerified()).toEqual([]);

    const promoted = await catalog.promote(items[0]!.entry.id, "operator", "validated by hand");
    expect(promoted.status).toBe("verified");
    expect(await catalog.retrieveVerified()).toHaveLength(1);

    // A re-import must not reset the promoted entry back to candidate.
    const third = await catalog.importCandidates(items, {
      actor: "operator",
      reason: "third import",
    });
    expect(third.added).toHaveLength(0);
    const stored = (await catalog.list()).find((entry) => entry.id === promoted.id);
    expect(stored?.status).toBe("verified");

    const doc = await catalog.load();
    expect(doc.audit.filter((record) => record.action === "import")).toHaveLength(2);
  });

  it("imports a project reasoning bank through the service and stays idempotent", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-rb-service-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-rb-home-"));
    const agentMemory = path.join(projectRoot, "agent-memory");
    await mkdir(agentMemory, { recursive: true });
    await writeFile(path.join(agentMemory, "reasoning-bank.md"), MARKDOWN, "utf8");

    const config = createDefaultConfig("demo");
    const loaded: LoadedConfig = {
      root: projectRoot,
      path: path.join(projectRoot, "agent-team.yaml"),
      config,
    };
    const service = ExperienceService.forLoaded(loaded, {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });

    const first = await service.importReasoningBank({ actor: "tester", reason: "bridge" });
    expect(first.parsed).toBe(2);
    expect(first.imported).toBe(2);
    expect(first.added).toHaveLength(2);
    expect(first.unchanged).toHaveLength(0);
    expect(first.filePath).toBe(path.join(agentMemory, "reasoning-bank.md"));

    const second = await service.importReasoningBank({ actor: "tester" });
    expect(second.added).toHaveLength(0);
    expect(second.unchanged).toHaveLength(2);

    // Imported entries are candidates: the planning path still injects nothing.
    const snapshot = await service.snapshot();
    expect(snapshot.counts.candidate).toBe(2);
    expect(snapshot.counts.verified).toBe(0);
    const bundle = await service.retrieveForPlanning("anything");
    expect(bundle?.items ?? []).toEqual([]);

    await expect(
      service.importReasoningBank({ filePath: path.join(projectRoot, "missing.md") }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("records a default audit reason and supports a single-entry dry run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "agent-team-rb-meta-"));
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-rb-home-"));
    const agentMemory = path.join(projectRoot, "agent-memory");
    await mkdir(agentMemory, { recursive: true });
    const single = "### Only entry\n- applies when: a\n- strategy: b\n- source: success\n- status: active\n";
    await writeFile(path.join(agentMemory, "reasoning-bank.md"), single, "utf8");

    const loaded: LoadedConfig = {
      root: projectRoot,
      path: path.join(projectRoot, "agent-team.yaml"),
      config: createDefaultConfig("demo"),
    };
    const service = ExperienceService.forLoaded(loaded, {
      ...process.env,
      AGENT_TEAM_HOME: home,
    });

    const dry = await service.importReasoningBank({ dryRun: true });
    expect(dry.parsed).toBe(1);
    expect(dry.added).toHaveLength(1);

    const written = await service.importReasoningBank({});
    expect(written.unchanged).toHaveLength(0);
    const catalog = new ExperienceCatalog(
      ExperienceCatalog.defaultPath(path.join(projectRoot, ".agent-team")),
    );
    const doc = await catalog.load();
    expect(doc.audit.at(-1)?.reason).toBe(
      "Imported 1 curated entry from agent-memory/reasoning-bank.md",
    );
  });

  it("reports a dry run without writing the catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-reasoning-bank-dry-"));
    const catalog = new ExperienceCatalog(ExperienceCatalog.defaultPath(root));
    const items = toExperienceEntries(parseReasoningBank(MARKDOWN), {
      project: "demo",
      sourcePath: "agent-memory/reasoning-bank.md",
      now: "2026-10-30T00:00:00.000Z",
    });

    const result = await catalog.importCandidates(items, {
      actor: "operator",
      reason: "dry run",
      dryRun: true,
    });
    expect(result.added).toHaveLength(2);
    expect(await catalog.list()).toEqual([]);
  });
});
