// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArchitectureDiagram } from "../../web/src/components/architecture/ArchitectureDiagram.js";
import {
  boxFooter,
  boxSubtitle,
  edgeGeometry,
  focusOf,
  moduleForPath,
  neighborhoodOf,
  stepsFor,
  traceLeaves,
} from "../../web/src/components/architecture/diagram/model.js";
import type { ArchitectureBox, ArchitectureDiagram as Diagram } from "../../web/src/architecture.js";
import {
  BoxLayer,
  EdgeLayer,
} from "../../web/src/components/architecture/diagram/sections.js";
import type { RepoTrace, TaskRunState } from "../../web/src/types.js";

function task(id: string, paths: string[]): TaskRunState {
  return {
    task: {
      id,
      title: id,
      description: "",
      dependsOn: [],
      ownedPaths: paths,
      acceptanceCommands: [],
      profile: null,
    },
    status: "running",
    attempts: 1,
  } as unknown as TaskRunState;
}

function box(patch: Partial<ArchitectureBox> = {}): ArchitectureBox {
  return {
    id: "m1",
    label: "m1",
    kind: "module",
    paths: ["src/a"],
    x: 0,
    y: 0,
    width: 176,
    height: 92,
    status: "working",
    tasks: [],
    ...patch,
  } as unknown as ArchitectureBox;
}

function diagram(patch: Partial<Diagram> = {}): Diagram {
  return {
    boxes: [box(), box({ id: "m2", label: "m2", paths: ["src/b"], x: 300 })],
    edges: [{ from: "m1", to: "m2", kind: "calls" }],
    width: 600,
    height: 300,
    ...patch,
  } as unknown as Diagram;
}

function trace(paths: string[], matched = true): RepoTrace {
  return {
    matched,
    nodes: paths.map((path, index) => ({
      id: `n${index}`,
      parentId: null,
      path,
      name: path.split("/").at(-1)!,
      kind: path.includes(".") ? "file" : "directory",
    })),
  } as unknown as RepoTrace;
}

describe("architecture diagram model", () => {
  it("keeps only leaf paths of a repository trace", () => {
    expect(traceLeaves(undefined)).toEqual([]);
    expect(traceLeaves(trace(["src", "src/a.ts", "src/b.ts", "docs"]))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "docs",
    ]);
  });

  it("matches a module by its longest covering path", () => {
    const boxes = [
      { id: "short", paths: ["src"] },
      { id: "long", paths: ["src/a"] },
    ];
    expect(moduleForPath(boxes, "src/a/b.ts")).toBe("long");
    expect(moduleForPath(boxes, "src/z.ts")).toBe("short");
    expect(moduleForPath(boxes, "other/file.ts")).toBeUndefined();
  });

  it("resolves the focus and its neighbourhood", () => {
    const map = diagram();
    expect(focusOf(map, "m1")).toBe("m1");
    expect(focusOf(map, "ghost")).toBeUndefined();
    expect(focusOf(map, undefined)).toBeUndefined();
    expect([...neighborhoodOf(map, "m1")].sort()).toEqual(["m1", "m2"]);
    expect(neighborhoodOf(map, undefined).size).toBe(0);
  });

  it("filters sequence steps around the focused module", () => {
    const presentation = {
      diagram: diagram(),
      source: "architect",
      sequence: [
        { from: "m1", to: "m2", label: "a" },
        { from: "m9", to: "m8", label: "b" },
      ],
    } as never;
    expect(stepsFor(presentation, undefined, new Set())).toHaveLength(2);
    expect(stepsFor(presentation, "m1", new Set(["m1", "m2"]))).toHaveLength(1);
  });

  it("computes edge geometry, captions and box copy", () => {
    const from = box({ x: 0, y: 0 });
    const to = box({ x: 0, y: 200 });
    const vertical = edgeGeometry({ from: "m1", to: "m2" } as never, from, to);
    expect(vertical.vertical).toBe(true);
    expect(vertical.caption).toBeUndefined();

    const horizontal = edgeGeometry({ from: "m1", to: "m2", kind: "calls" } as never, from, box({ x: 300, y: 200 }));
    expect(horizontal.vertical).toBe(false);
    expect(horizontal.caption).toBe("调用");

    expect(boxSubtitle(box({ responsibility: "owns billing" }))).toBe("owns billing");
    expect(boxSubtitle(box())).toBe("模块 · 进行中");
    expect(boxFooter(box({ tasks: [{}, {}] as never }))).toBe("进行中 · 2 个任务");
  });
});

describe("ArchitectureDiagram", () => {
  it("renders nothing without modules", () => {
    const { container } = render(
      <ArchitectureDiagram tasks={[]} onSelectModule={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders modules and reports a selection", async () => {
    const onSelectModule = vi.fn();
    render(
      <ArchitectureDiagram
        tasks={[task("T1", ["src/a/index.ts"]), task("T2", ["src/b/index.ts"])]}
        onSelectModule={onSelectModule}
      />,
    );
    expect(screen.getByRole("region", { name: "系统架构图" })).toBeTruthy();
    const modules = within(screen.getByRole("region", { name: "系统架构图" }))
      .getAllByRole("button")
      .filter((node) => node.className.includes("absolute"));
    expect(modules.length).toBeGreaterThan(0);
    await userEvent.click(modules[0]!);
    expect(onSelectModule).toHaveBeenCalled();
  });

  it("switches to the sequence view", async () => {
    render(
      <ArchitectureDiagram
        tasks={[task("T1", ["src/a/index.ts"]), task("T2", ["src/b/index.ts"])]}
        onSelectModule={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "时序" }));
    expect(screen.getByRole("button", { name: "时序" })).toHaveAttribute("aria-pressed", "true");
  });

  it("lists the repository index and clears the drill-down", async () => {
    const onClearModule = vi.fn();
    render(
      <ArchitectureDiagram
        tasks={[task("T1", ["src/a/index.ts"])]}
        repoTrace={trace(["src/a/index.ts"])}
        selectedModuleId={undefined}
        onSelectModule={() => undefined}
        onClearModule={onClearModule}
      />,
    );
    expect(screen.getByText("索引")).toBeVisible();
    expect(screen.getByText("目标命中")).toBeVisible();
  });

  it("draws edges with captions and fades outsiders when drilled down", () => {
    const map = diagram();
    const boxOf = new Map(map.boxes.map((item) => [item.id, item]));
    const { container } = render(
      <svg>
        <EdgeLayer diagram={map} boxOf={boxOf} focused="m1" neighborhood={new Set(["m1", "m2"])} />
      </svg>,
    );
    expect(container.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("调用");

    // An edge whose endpoints are missing draws nothing.
    const orphan = render(
      <svg>
        <EdgeLayer
          diagram={{ ...map, edges: [{ from: "x", to: "y" }] } as never}
          boxOf={boxOf}
          focused={undefined}
          neighborhood={new Set()}
        />
      </svg>,
    );
    expect(orphan.container.querySelectorAll("g")).toHaveLength(0);
  });

  it("styles module boxes by status and drill-down focus", () => {
    const boxes = [
      box({ id: "m1", status: "blocked" }),
      box({ id: "m2", status: "working" }),
      box({ id: "m3", status: "pending" }),
    ];
    render(
      <BoxLayer
        boxes={boxes}
        selectedModuleId="m2"
        focused="m2"
        neighborhood={new Set(["m2"])}
        onSelectModule={() => undefined}
      />,
    );
    const rendered = screen.getAllByRole("button");
    expect(rendered).toHaveLength(3);
    expect(rendered[0]!.className).toContain("border-danger/40");
    expect(rendered[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(rendered[2]!.className).toContain("opacity-30");
  });
});
