// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EvidenceCallout,
  EvidenceEmpty,
  EvidenceHeader,
  EvidenceList,
  evidenceItemPassed,
  evidenceVerdict,
} from "../../web/src/components/evolution/detail/evidence.js";
import type { EvolutionProposal } from "../../web/src/types.js";

type Evaluation = NonNullable<EvolutionProposal["evaluation"]>;

function evaluation(patch: Partial<Evaluation> = {}): Evaluation {
  return {
    source: "server-structural-preflight-v1",
    evidence: {
      proposalId: "p-1",
      candidateDigest: "a".repeat(64),
      items: [
        { kind: "deterministic", id: "schema", summary: "结构合法", status: "pass" },
        { kind: "advisory", id: "review", summary: "独立审查", verdict: "approve" },
      ],
    },
    result: { passed: true, summary: "全部通过" },
    ...patch,
  } as Evaluation;
}

describe("evidence verdict", () => {
  it("describes a passing structural preflight", () => {
    const verdict = evidenceVerdict(evaluation());
    expect(verdict).toMatchObject({ automatic: false, passed: true, title: "结构预检通过" });
    expect(verdict.callout).toMatch(/未执行候选/);
  });

  it("describes a failing automatic evaluation", () => {
    const verdict = evidenceVerdict(
      evaluation({
        source: "server-automatic-run-evaluation-v1",
        result: { passed: false, summary: "分数未提升" },
      }),
    );
    expect(verdict).toMatchObject({
      automatic: true,
      passed: false,
      title: "隔离评测未通过",
      summary: "分数未提升",
    });
    expect(verdict.callout).toMatch(/隔离工作树/);
  });

  it("passes deterministic items on status and advisory on verdict", () => {
    expect(evidenceItemPassed({ kind: "deterministic", status: "pass" })).toBe(true);
    expect(evidenceItemPassed({ kind: "deterministic", status: "fail" })).toBe(false);
    expect(evidenceItemPassed({ kind: "advisory", verdict: "approve" })).toBe(true);
    expect(evidenceItemPassed({ kind: "advisory", verdict: "request_changes" })).toBe(false);
  });
});

describe("evidence components", () => {
  it("explains that no preflight ran", () => {
    render(<EvidenceEmpty />);
    expect(screen.getByText("尚未运行结构预检")).toBeVisible();
  });

  it("renders the pass card, the callout and the item rows", () => {
    const verdict = evidenceVerdict(evaluation());
    const items = evaluation().evidence.items;
    render(
      <>
        <EvidenceHeader verdict={verdict} />
        <EvidenceCallout verdict={verdict} />
        <EvidenceList items={items} />
      </>,
    );
    expect(screen.getByText("结构预检通过")).toBeVisible();
    expect(screen.getByText(/未执行候选/)).toBeVisible();
    expect(screen.getByText("通过")).toBeVisible();
    expect(screen.getByText("approve")).toBeVisible();
    expect(screen.getByText("schema")).toBeVisible();
  });

  it("renders a failing header and a failed item", () => {
    const verdict = evidenceVerdict(
      evaluation({ source: "server-automatic-run-evaluation-v1", result: { passed: false, summary: "差 20 分" } }),
    );
    render(
      <>
        <EvidenceHeader verdict={verdict} />
        <EvidenceList
          items={[{ kind: "deterministic", id: "score", summary: "分数", status: "fail" }] as never}
        />
      </>,
    );
    expect(screen.getByText("隔离评测未通过")).toBeVisible();
    expect(screen.getByText("失败")).toBeVisible();
  });
});
