// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceTaskMatrix } from "../web/src/components/run/EvidenceTaskMatrix.js";
import {
  commitLabel,
  qualityCell,
  taskCountLabel,
  taskSubtitle,
  verdictCell,
} from "../web/src/components/run/evidence/model.js";
import { EvidenceValue, TaskEvidenceRow } from "../web/src/components/run/evidence/sections.js";
import type { RunEvidence } from "../web/src/types.js";

type TaskEvidence = RunEvidence["tasks"][number];

function task(patch: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    id: "T1",
    title: "实现导出",
    status: "merged",
    attempts: 1,
    commit: "abcdef0123456789",
    findingCount: 0,
    ...patch,
  } as TaskEvidence;
}

describe("evidence matrix model", () => {
  it("reads a boolean quality gate", () => {
    expect(qualityCell(task({ qualityPassed: true }))).toEqual({ verdict: "pass", label: "通过" });
    expect(qualityCell(task({ qualityPassed: false }))).toEqual({ verdict: "fail", label: "失败" });
    expect(qualityCell(task())).toEqual({ verdict: "pending", label: "待执行" });
  });

  it("reads a verdict string", () => {
    expect(verdictCell("approve")).toEqual({ verdict: "pass", label: "approve" });
    expect(verdictCell("request_changes")).toEqual({ verdict: "fail", label: "request_changes" });
    expect(verdictCell(undefined)).toEqual({ verdict: "pending", label: "待执行" });
  });

  it("shortens the commit and labels the row", () => {
    expect(commitLabel(task())).toBe("abcdef012");
    expect(commitLabel(task({ commit: undefined }))).toBe("-");
    expect(taskSubtitle(task())).toBe("T1 · merged");
    expect(taskCountLabel(3)).toBe("3 个任务");
  });
});

describe("EvidenceTaskMatrix", () => {
  it("lists every task with its gates", () => {
    render(
      <EvidenceTaskMatrix
        tasks={[
          task({ qualityPassed: true, reviewVerdict: "approve", testVerdict: "request_changes" }),
          task({ id: "T2", title: "第二个", status: "blocked" }),
        ]}
      />,
    );
    expect(screen.getByRole("table", { name: "任务交付矩阵" })).toBeTruthy();
    expect(screen.getAllByText("实现导出").length).toBeGreaterThan(0);
    expect(screen.getByText("通过")).toBeVisible();
    expect(screen.getByText("request_changes")).toBeVisible();
    expect(screen.getAllByText("待执行").length).toBeGreaterThan(0);
    expect(screen.getByText("2 个任务")).toBeVisible();
  });

  it("explains an empty matrix", () => {
    render(<EvidenceTaskMatrix tasks={[]} />);
    expect(screen.getByText("还没有任务证据")).toBeVisible();
  });

  it("renders a row and a cell on their own", () => {
    const { container } = render(
      <table>
        <tbody>
          <TaskEvidenceRow
            task={task()}
            body="cell"
            cells={{
              quality: qualityCell(task({ qualityPassed: false })),
              review: verdictCell("approve"),
              test: verdictCell(undefined),
            }}
          />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll("td")).toHaveLength(5);
    render(<EvidenceValue cell={{ verdict: "pending", label: "待执行" }} />);
    expect(screen.getAllByText("待执行").length).toBeGreaterThan(0);
  });
});
