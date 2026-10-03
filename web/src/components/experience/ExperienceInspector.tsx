import { BookMarked, CheckCircle2, ChevronRight, Globe2, LoaderCircle, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatExperienceTag, summarizeGoal } from "../../presentation";
import type { ExperiencePlanningBundle } from "../../types";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import { Input } from "../../ui/form";
import { scopeLabel, shortPath } from "./model";

interface ExperienceInspectorProps {
  previewQuery: string;
  previewResult: ExperiencePlanningBundle | undefined;
  previewLoading: boolean;
  busy: boolean;
  projectPath: string;
  sharedPath: string;
  onPreviewQueryChange(value: string): void;
}

export function ExperienceInspector({
  previewQuery,
  previewResult,
  previewLoading,
  busy,
  projectPath,
  sharedPath,
  onPreviewQueryChange,
}: ExperienceInspectorProps) {
  const [pathsOpen, setPathsOpen] = useState(false);
  const hasQuery = Boolean(previewQuery.trim());

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <SectionTitle>检索预览</SectionTitle>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={previewQuery}
            disabled={busy}
            onChange={(event) => onPreviewQueryChange(event.target.value)}
            placeholder="输入目标文本"
            aria-label="检索预览"
            className="h-8 pl-8 text-xs"
          />
        </div>
        {hasQuery ? (
          previewLoading ? (
            <p className="m-0 inline-flex items-center gap-1.5 text-xs text-muted" role="status">
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
              检索中…
            </p>
          ) : previewResult && previewResult.items.length > 0 ? (
            <>
              <p className="m-0 text-xs text-muted">规划时将注入 {previewResult.items.length} 条已验证经验</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {previewResult.items.map((item) => (
                  <li key={item.id} className="bd flex flex-col gap-0.5 rounded-md bg-surface-2 px-2.5 py-2">
                    <strong title={item.summary} className="text-xs font-semibold leading-snug text-ink">
                      {summarizeGoal(item.summary, 48)}
                    </strong>
                    <small className="text-2xs text-muted">
                      {scopeLabel(item.scope)} · 命中 {item.hitCount}
                      {item.tags.length > 0
                        ? ` · ${item.tags.slice(0, 3).map(formatExperienceTag).join(" / ")}`
                        : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="m-0 text-xs text-muted">无匹配的已验证经验</p>
          )
        ) : (
          <p className="m-0 text-xs text-muted">预览启动新运行时注入规划的经验</p>
        )}
      </section>

      <Card className="flex flex-col gap-2.5 bg-surface-2 p-3 shadow-none">
        <HelpRow icon={<CheckCircle2 />}>
          <strong className="font-medium text-ink">晋升</strong>后才进规划
        </HelpRow>
        <HelpRow icon={<Globe2 />}>
          <strong className="font-medium text-ink">共享</strong>写入公共库
        </HelpRow>
        <HelpRow icon={<BookMarked />}>
          <strong className="font-medium text-ink">新项目</strong>自动带上已验证
        </HelpRow>
      </Card>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setPathsOpen((open) => !open)}
          aria-expanded={pathsOpen}
          className="-ml-1 flex w-fit cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 py-1 text-xs text-muted hover:text-ink focus-ring"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", pathsOpen && "rotate-90")} />
          存储路径
        </button>
        {pathsOpen && (
          <dl className="m-0 flex flex-col gap-2.5">
            <PathRow label="本项目" path={projectPath} />
            <PathRow label="公共" path={sharedPath} />
          </dl>
        )}
      </section>
    </div>
  );
}

function HelpRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-accent-ink">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function PathRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="m-0 min-w-0">
        <code title={path} className="break-all font-mono text-2xs text-ink-2">{shortPath(path)}</code>
      </dd>
    </div>
  );
}
