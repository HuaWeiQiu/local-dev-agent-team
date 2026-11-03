import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintValidationError,
} from "../src/strategies/catalog.js";

const definition = {
  topology: { mode: "sequential" as const },
  maxParallel: 1,
  roleProfiles: {},
};

async function openCatalog() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-catalog-persist-"));
  const config = createDefaultConfig("fixture");
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  const loaded = await loadConfig(root);
  return { root, loaded };
}

describe("catalog persist failure modes", () => {
  it("removes its temporary file when the write fails before the rename", async () => {
    const { loaded } = await openCatalog();
    const catalog = await StrategyBlueprintCatalog.open(loaded, {
      io: {
        open: (async () => {
          throw new Error("disk full");
        }) as never,
      },
    });

    const error = await catalog.save("lane", definition).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StrategyBlueprintValidationError);
    const leftovers = (await readdir(catalog.stateDirectory)).filter((name) =>
      name.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("keeps writing after a failed pre-rename attempt", async () => {
    const { loaded } = await openCatalog();
    let failNext = true;
    const catalog = await StrategyBlueprintCatalog.open(loaded, {
      io: {
        open: (async (...args: Parameters<typeof import("node:fs/promises").open>) => {
          if (failNext) {
            failNext = false;
            throw new Error("disk full");
          }
          const fs = await import("node:fs/promises");
          return await fs.open(...args);
        }),
      },
    });

    await expect(catalog.save("lane", definition)).rejects.toBeInstanceOf(
      StrategyBlueprintValidationError,
    );
    await expect(catalog.save("lane", definition)).resolves.toMatchObject({ name: "lane" });
  });

  it("succeeds through the default io, which fsyncs the state directory", async () => {
    const { loaded } = await openCatalog();
    const catalog = await StrategyBlueprintCatalog.open(loaded);

    await expect(catalog.save("lane", definition)).resolves.toMatchObject({ name: "lane" });
  });
});
