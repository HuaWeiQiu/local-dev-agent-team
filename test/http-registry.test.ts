import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectedOnly, readRegistry } from "../src/server/http.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

const connected = [
  { id: "p1", name: "Demo", defaultBranch: "main", connected: true as const },
  { id: "p2", name: "Other", defaultBranch: "main", connected: true as const },
];

async function registryFile(content: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-registry-"));
  roots.push(root);
  const file = path.join(root, "registry.json");
  await writeFile(file, content, "utf8");
  return file;
}

describe("connectedOnly", () => {
  it("lists the served projects as ours", () => {
    expect(connectedOnly(connected)).toEqual([
      { id: "p1", name: "Demo", path: "", connected: true, occupancy: "ours" },
      { id: "p2", name: "Other", path: "", connected: true, occupancy: "ours" },
    ]);
  });
});

describe("readRegistry", () => {
  it("flags which entries this process serves", async () => {
    const file = await registryFile(
      JSON.stringify({
        projects: [
          { id: "p1", name: "Demo", path: "/a", occupancy: "ours" },
          { id: "p3", name: "Elsewhere", path: "/b", occupancy: "foreign" },
        ],
      }),
    );
    expect(readRegistry(file, connected)).toEqual([
      { id: "p1", name: "Demo", path: "/a", occupancy: "ours", connected: true },
      { id: "p3", name: "Elsewhere", path: "/b", occupancy: "foreign", connected: false },
    ]);
  });

  it("reports nothing for an empty or malformed file", async () => {
    expect(readRegistry(await registryFile(JSON.stringify({ projects: [] })), connected)).toBeUndefined();
    expect(readRegistry(await registryFile("not json"), connected)).toBeUndefined();
  });

  it("reports nothing for a file it cannot read", () => {
    expect(readRegistry("/nonexistent/registry.json", connected)).toBeUndefined();
  });
});
