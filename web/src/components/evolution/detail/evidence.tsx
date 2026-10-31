import { CheckCircle2, CircleAlert, FileCheck2, ShieldCheck } from "lucide-react";
import type { EvolutionProposal } from "../../../types";
import { Badge } from "../../../ui/badge";
import { Card } from "../../../ui/card";
import { cn } from "../../../ui/cn";
import { Callout } from "../../../ui/form";
import { evidenceItemSummary } from "../format";

export const automaticSource = "server-automatic-run-evaluation-v1";

export interface EvidenceVerdict {
  automatic: boolean;
  passed: boolean;
  title: string;
  summary: string;
  callout: string;
}

/** One shape for both preflight kinds: automatic evaluation vs structural check. */
export function evidenceVerdict(
  evaluation: NonNullable<EvolutionProposal["evaluation"]>,
): EvidenceVerdict {
  const automatic = evaluation.source === automaticSource;
  const passed = evaluation.result.passed;
  return {
    automatic,
    passed,
    title: verdictTitle(passed, automatic),
    summary: passed ? verdictSummary(automatic) : evaluation.result.summary,
    callout: automatic
      ? "结果来自项目内隔离工作树的固定目标运行；不包含自动发布，也不授予候选自执行权限。"
      : "此结果只验证结构和本地安全条件，未执行候选策略或提示词。",
  };
}

function verdictTitle(passed: boolean, automatic: boolean): string {
  if (passed) return automatic ? "隔离评测通过" : "结构预检通过";
  return automatic ? "隔离评测未通过" : "结构预检未通过";
}

function verdictSummary(automatic: boolean): string {
  return automatic
    ? "候选通过固定目标的隔离运行，并达到配置的最低分数提升。"
    : "所有确定性检查均已通过，未出现否决项。";
}

/** Deterministic items pass on status, advisory items on verdict. */
export function evidenceItemPassed(item: {
  kind: "deterministic" | "advisory";
  status?: "pass" | "fail";
  verdict?: string;
}): boolean {
  return item.kind === "deterministic" ? item.status === "pass" : item.verdict === "approve";
}

export function EvidenceEmpty() {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-surface-3 text-muted [&_svg]:size-5">
        <FileCheck2 />
      </span>
      <strong className="text-sm font-medium text-ink-2">尚未运行结构预检</strong>
      <span className="text-xs text-muted">预检由服务端生成并绑定当前候选。</span>
    </Card>
  );
}

export function EvidenceHeader({ verdict }: { verdict: EvidenceVerdict }) {
  return (
    <Card className={cn("flex items-start gap-3 p-5", verdict.passed ? "bg-success-soft" : "bg-danger-soft")}>
      <span
        aria-hidden
        className={cn("mt-0.5 shrink-0 [&_svg]:size-5", verdict.passed ? "text-success-ink" : "text-danger-ink")}
      >
        {verdict.passed ? <CheckCircle2 /> : <CircleAlert />}
      </span>
      <div className="min-w-0">
        <strong className={cn("block text-base font-semibold", verdict.passed ? "text-success-ink" : "text-danger-ink")}>
          {verdict.title}
        </strong>
        <p className="m-0 mt-1 text-sm leading-relaxed text-ink-2">{verdict.summary}</p>
      </div>
    </Card>
  );
}

export function EvidenceCallout({ verdict }: { verdict: EvidenceVerdict }) {
  return (
    <Callout tone="info">
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
        {verdict.callout}
      </span>
    </Callout>
  );
}

export function EvidenceList({
  items,
}: {
  items: NonNullable<EvolutionProposal["evaluation"]>["evidence"]["items"];
}) {
  return (
    <Card className="overflow-hidden">
      <ul className="m-0 list-none p-0">
        {items.map((item, index) => (
          <EvidenceItemRow key={item.id} item={item} first={index === 0} />
        ))}
      </ul>
    </Card>
  );
}

function EvidenceItemRow({
  item,
  first,
}: {
  item: NonNullable<EvolutionProposal["evaluation"]>["evidence"]["items"][number];
  first: boolean;
}) {
  const passed = evidenceItemPassed(item);
  return (
    <li className={cn("flex items-start gap-3 px-4 py-3", !first && "bd-t")}>
      <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-4", passed ? "text-success" : "text-danger")}>
        {passed ? <CheckCircle2 /> : <CircleAlert />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <strong className="text-sm font-medium leading-snug text-ink">
          {evidenceItemSummary(item.id, item.summary, passed)}
        </strong>
        <code className="break-all text-2xs text-muted">{item.id}</code>
      </div>
      <Badge tone={passed ? "success" : "danger"}>{evidenceBadge(item)}</Badge>
    </li>
  );
}

function evidenceBadge(item: {
  kind: "deterministic" | "advisory";
  status?: "pass" | "fail";
  verdict?: string;
}): string {
  if (item.kind === "deterministic") return item.status === "pass" ? "通过" : "失败";
  return item.verdict ?? "咨询";
}
