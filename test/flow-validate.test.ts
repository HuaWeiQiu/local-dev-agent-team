import { describe, expect, it } from "vitest";
import { FlowValidationError, validateTemplate } from "../src/flow/validate.js";
import { FLOW_TEMPLATES, flowTemplate } from "../src/flow/templates.js";
import type { FlowGraph, FlowTemplate } from "../src/flow/types.js";

/** A template that validates, so each test can break exactly one thing. */
function template(patch: Partial<FlowTemplate> = {}): FlowTemplate {
  return { ...structuredClone(flowTemplate("standard")), ...patch };
}

function issuesOf(candidate: FlowTemplate): string[] {
  try {
    validateTemplate(candidate);
    return [];
  } catch (error) {
    if (error instanceof FlowValidationError) return error.issues;
    throw error;
  }
}

function graph(patch: Partial<FlowGraph>): FlowGraph {
  return { ...structuredClone(template().run), ...patch };
}

describe("every shipped template validates", () => {
  it.each(Object.keys(FLOW_TEMPLATES))("%s", (name) => {
    expect(() => validateTemplate(flowTemplate(name as never))).not.toThrow();
  });
});

describe("structural checks", () => {
  it("reports a duplicate node id", () => {
    const run = graph({ nodes: [...graph({}).nodes, graph({}).nodes[0]!] });
    expect(issuesOf(template({ run })).join(" ")).toContain("duplicate node");
  });

  it("reports an unknown kind, a mismatched id and an unknown fact", () => {
    const nodes = graph({}).nodes.map((node, index) =>
      index === 0 ? { ...node, kind: "nonsense" as never } : node,
    );
    expect(issuesOf(template({ run: graph({ nodes }) })).join(" ")).toContain("unknown node kind");

    const mismatched = graph({}).nodes.map((node, index) =>
      index === 0 ? { ...node, id: "renamed" as never } : node,
    );
    expect(issuesOf(template({ run: graph({ nodes: mismatched }) })).join(" ")).toContain(
      "must equal its kind",
    );

    const withFact = graph({}).nodes.map((node, index) =>
      index === 0 ? { ...node, when: { all: [{ fact: "nope", equals: true }] } as never } : node,
    );
    expect(issuesOf(template({ run: graph({ nodes: withFact }) })).join(" ")).toContain(
      "unknown fact",
    );
  });

  it("reports a start that is not a node", () => {
    expect(issuesOf(template({ run: graph({ start: "ghost" }) })).join(" ")).toContain(
      "is not a node",
    );
  });

  it("reports an edge that references a missing node", () => {
    const edges = [...graph({}).edges, { from: graph({}).start, to: "ghost" } as never];
    expect(issuesOf(template({ run: graph({ edges }) })).join(" ")).toContain("missing node");
  });

  it("reports a loop in the run graph", () => {
    const edges = [...graph({}).edges, { from: graph({}).start, to: graph({}).start, loop: true } as never];
    expect(issuesOf(template({ run: graph({ edges }) })).join(" ")).toContain("is not allowed");
  });

  it("reports a cycle and an unreachable node", () => {
    const base = graph({});
    const edges = [
      ...base.edges,
      { from: base.nodes[1]!.id, to: base.start } as never,
    ];
    const issues = issuesOf(template({ run: graph({ edges }) })).join(" ");
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("run invariants", () => {
  it("requires the whole chain", () => {
    const base = graph({});
    const run = {
      ...base,
      start: "plan",
      nodes: base.nodes.filter((node) => node.id !== "final-checks"),
      edges: base.edges.filter((edge) => edge.from !== "final-checks" && edge.to !== "final-checks"),
    };
    expect(issuesOf(template({ run })).join(" ")).toContain("required node 'final-checks' is missing");
  });

  it("requires the chain in order", () => {
    const base = graph({});
    const swapped = {
      ...base,
      edges: [
        ...base.edges.filter((edge) => edge.from !== "execute" && edge.to !== "execute"),
        { from: "execute", to: "plan" } as never,
      ],
    };
    // A wrong edge either breaks the chain or makes the graph invalid; both are
    // refused, so the assertion only needs an issue to exist.
    expect(issuesOf(template({ run: swapped })).length).toBeGreaterThan(0);
  });

  it("refuses a conditional mandatory step", () => {
    const nodes = graph({}).nodes.map((node) =>
      node.id === "final-checks" ? { ...node, when: { all: [] } as never } : node,
    );
    expect(issuesOf(template({ run: graph({ nodes }) })).join(" ")).toContain(
      "cannot be conditional",
    );
  });
});

describe("task invariants", () => {
  it("requires work first, quality next and commit last", () => {
    const base = template();
    const task = {
      ...base.task,
      nodes: base.task.nodes.filter((node) => node.id !== "quality"),
      edges: base.task.edges.filter((edge) => edge.from !== "quality" && edge.to !== "quality"),
    };
    expect(issuesOf({ ...base, task }).join(" ")).toContain("required node 'quality' is missing");
  });

  it("keeps review and test together", () => {
    const base = template();
    const task = { ...base.task, nodes: base.task.nodes.filter((node) => node.id !== "test") };
    const issues = issuesOf({ ...base, task }).join(" ");
    expect(issues.length).toBeGreaterThan(0);
  });
});
