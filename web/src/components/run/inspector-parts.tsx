import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { humanizeFailure } from "../../presentation";
import type { RunState } from "../../types";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { Callout } from "../../ui/form";

export function InspectorSection({ icon: Icon, title, children, className }: { icon?: LucideIcon; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("bd-b px-4 py-4", className)}>
      <h4 className="m-0 mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink">
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />}
        {title}
      </h4>
      {children}
    </section>
  );
}

export function DefinitionList({ children }: { children: ReactNode }) {
  return <dl className="m-0 flex flex-col gap-2.5">{children}</dl>;
}

export function Definition({ term, children, title }: { term: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-xs">
      <dt className="text-muted">{term}</dt>
      <dd {...(title ? { title } : {})} className="m-0 min-w-0 break-words text-right text-ink">{children}</dd>
    </div>
  );
}

export function InspectorCode({ children }: { children: ReactNode }) {
  return <code className="break-all text-2xs text-ink-2">{children}</code>;
}

export function InlineError({ children }: { children: ReactNode }) {
  return <Callout tone="danger" className="mx-4 my-3 break-words">{children}</Callout>;
}

export function Verdict({ label, verdict, summary }: { label: string; verdict: string; summary: string }) {
  const passing = ["approve", "ready"].includes(verdict);
  return (
    <div className="relative mt-2 overflow-hidden rounded-md bg-surface-2 py-2.5 pl-4 pr-3 first:mt-0">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", passing ? "bg-success" : "bg-danger")} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <Badge tone={passing ? "success" : "danger"} className="uppercase">{verdict}</Badge>
      </div>
      <p className="m-0 mt-1.5 break-words text-xs leading-relaxed text-ink-2">{summary}</p>
    </div>
  );
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

export function describeRunFailure(run: RunState): string {
  const failed = run.finalQuality?.commands?.find((command) => command.exitCode !== 0);
  const detail = [failed?.stderr, failed?.stdout].find((chunk) => chunk?.trim());
  if (run.error?.startsWith("Integration quality commands failed") || (run.finalQuality && !run.finalQuality.passed)) {
    const hint = detail?.replace(/\s+/g, " ").trim();
    if (hint) {
      return `任务已合并，集成质量门失败：${hint.slice(0, 240)}`;
    }
    return "任务已合并，集成质量门失败（请检查 integration worktree 是否缺依赖）";
  }
  return humanizeFailure(run.error);
}
