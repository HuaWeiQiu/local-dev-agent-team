import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { proposalTarget } from "../../../evolution";
import type { EvolutionProposal } from "../../../types";
import { Card, SectionTitle } from "../../../ui/card";
import { automaticSource } from "./evidence";

const CANDIDATE_LIMITS = ["不能自行执行", "不能自行晋升", "不网络发布", "不存储秘密"];

/** What the candidate will change, one sentence per candidate kind. */
export function targetSummary(kind: EvolutionProposal["candidate"]["kind"]): string {
  return kind === "strategy-blueprint"
    ? "候选将更新一个本地自定义执行策略。应用前会再次比较目标摘要。"
    : "候选指向项目已配置的角色提示词。内容只在精确预览和本地对象存储中使用。";
}

export function topologyLabel(mode: string | undefined): string {
  return mode === "sequential" ? "顺序执行" : "依赖并行";
}

export function secondsLabel(value: number | undefined): string {
  return value ? `${value}秒`.replace(/(\d+)秒/, "$1 秒") : "默认";
}

export function gatesLabel(gates: string[] | undefined): string {
  return gates?.join("、") || "沿用默认";
}

export function isAutomatic(proposal: EvolutionProposal): boolean {
  return proposal.evaluation?.source === automaticSource;
}

export function Overview({ proposal }: { proposal: EvolutionProposal }) {
  const { candidate } = proposal;
  return (
    <>
      <TargetCard proposal={proposal} />
      {candidate.kind === "strategy-blueprint" ? (
        <StrategyParams candidate={candidate} />
      ) : (
        <MaterialDigest candidate={candidate} />
      )}
      <PermissionsCard automatic={isAutomatic(proposal)} />
    </>
  );
}

function TargetCard({ proposal }: { proposal: EvolutionProposal }) {
  return (
    <Card className="flex flex-col gap-2 p-5">
      <SectionTitle>变更目标</SectionTitle>
      <h2 className="m-0 text-base font-semibold tracking-tight text-ink">{proposalTarget(proposal)}</h2>
      <p className="m-0 max-w-prose text-sm leading-relaxed text-ink-2">
        {targetSummary(proposal.candidate.kind)}
      </p>
    </Card>
  );
}

function StrategyParams({
  candidate,
}: {
  candidate: Extract<EvolutionProposal["candidate"], { kind: "strategy-blueprint" }>;
}) {
  const definition = candidate.definition;
  return (
    <Card className="flex flex-col gap-3 p-5">
      <SectionTitle>执行参数</SectionTitle>
      <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line sm:grid-cols-3">
        <Stat label="拓扑" value={topologyLabel(definition.topology?.mode)} />
        <Stat label="最大并行" value={definition.maxParallel ?? "默认"} />
        <Stat label="最多返工" value={definition.maxReworkAttempts ?? "默认"} />
        <Stat label="角色调用上限" value={definition.maxAgentInvocations ?? "默认"} />
        <Stat label="执行超时" value={secondsLabel(definition.executionTimeoutSeconds)} />
        <Stat label="人工门禁" value={gatesLabel(definition.approvalGates)} />
      </dl>
    </Card>
  );
}

function MaterialDigest({
  candidate,
}: {
  candidate: Extract<EvolutionProposal["candidate"], { kind: "role-prompt" }>;
}) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <SectionTitle>材料摘要</SectionTitle>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">仓库路径</dt>
        <dd className="m-0 min-w-0">
          <code className="break-all rounded bg-surface-3 px-1.5 py-0.5 text-xs">{candidate.path}</code>
        </dd>
        <dt className="text-muted">SHA-256</dt>
        <dd className="m-0 min-w-0">
          <code className="break-all rounded bg-surface-3 px-1.5 py-0.5 text-xs">{candidate.contentDigest}</code>
        </dd>
      </dl>
    </Card>
  );
}

function PermissionsCard({ automatic }: { automatic: boolean }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <SectionTitle>候选权限</SectionTitle>
      <div className="flex flex-wrap gap-2">
        {CANDIDATE_LIMITS.map((label) => (
          <span key={label} className="bd inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
            <LockKeyhole aria-hidden className="size-3.5 text-muted" />
            {label}
          </span>
        ))}
      </div>
      {automatic && (
        <p className="m-0 text-xs leading-relaxed text-muted">
          自动演进由项目级受限控制器授权，候选策略本身始终没有执行或晋升权限。
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-surface px-3 py-2.5">
      <dt className="text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="m-0 text-sm font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}
