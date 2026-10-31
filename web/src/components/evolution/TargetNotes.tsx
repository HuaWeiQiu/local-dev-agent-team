import type { ReactNode } from "react";
import type { EvolutionProposal } from "../../types";
import { Card, SectionTitle } from "../../ui/card";
import { Callout } from "../../ui/form";
import { formatDate, shortDigest } from "./format";

export function ScopeNote({ proposal }: { proposal: EvolutionProposal | undefined }) {
  const automatic = proposal?.evaluation?.source === "server-automatic-run-evaluation-v1";
  return (
    <Callout tone="info">
      <strong className="block font-semibold">{automatic ? "自动演进记录" : "人工候选控制"}</strong>
      <span className="mt-0.5 block">
        {automatic
          ? "项目级控制器已隔离评测并按确定性分数决定；候选本身不能自授权。"
          : "结构预检不会执行候选；应用与回滚仍需要人工查看精确预览。"}
      </span>
    </Callout>
  );
}

export function TargetMetadata({ proposal, catalogRevision }: { proposal: EvolutionProposal; catalogRevision: number }) {
  const rows: Array<[string, ReactNode]> = [
    ["类型", proposal.candidate.kind === "strategy-blueprint" ? "执行策略" : "角色提示词"],
    ["Catalog", `修订 ${catalogRevision}`],
    ["目标摘要", <code key="digest" className="font-mono text-xs">{shortDigest(proposal.application?.afterTargetDigest ?? null)}</code>],
    ["创建时间", formatDate(proposal.createdAt)],
  ];
  if (proposal.archivedAt) rows.push(["归档时间", formatDate(proposal.archivedAt)]);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle>目标信息</SectionTitle>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-right text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
