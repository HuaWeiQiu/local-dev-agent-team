import { Check, CircleAlert, CircleDot, LoaderCircle, PanelLeftOpen, Play, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { strategyDisplayName } from "../../presentation";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Select } from "../../ui/form";
import { Tooltip } from "../../ui/tooltip";
import type { ComposerFeedback } from "./draft";

const toggleActive = "bg-accent-soft text-accent-ink hover:bg-accent-soft";
const collapsible = "@max-4xl:w-8 @max-4xl:px-0";

export function ComposerToolbar({
  strategyNames,
  selectedName,
  libraryOpen,
  inspectorOpen,
  submitting,
  dirty,
  canSubmit,
  feedback,
  onSelect,
  onToggleLibrary,
  onToggleInspector,
  onPreflight,
  onSave,
  onLaunch,
}: {
  strategyNames: string[];
  selectedName: string;
  libraryOpen: boolean;
  inspectorOpen: boolean;
  submitting: boolean;
  dirty: boolean;
  canSubmit: boolean;
  feedback: ComposerFeedback | undefined;
  onSelect(name: string): void;
  onToggleLibrary(): void;
  onToggleInspector(): void;
  onPreflight(): void;
  onSave(): void;
  onLaunch(): void;
}) {
  return (
    <header className="bd-b relative z-10 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 bg-surface px-3 py-2 text-sm @3xl:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Tooltip label="打开策略库">
          <Button
            onClick={onToggleLibrary}
            aria-pressed={libraryOpen}
            aria-label="策略库"
            className={cn(collapsible, libraryOpen && toggleActive)}
          >
            <PanelLeftOpen /><Label>策略库</Label>
          </Button>
        </Tooltip>
        <div className="min-w-0 flex-1 @3xl:max-w-64">
          <Select
            aria-label="策略模板"
            value={selectedName}
            onChange={(event) => onSelect(event.target.value)}
            disabled={submitting}
            className="h-8 text-sm! font-semibold!"
          >
            {strategyNames.map((name) => (
              <option key={name} value={name}>{strategyDisplayName(name)}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="order-last flex min-w-0 basis-full @3xl:order-none @3xl:basis-auto">
        <StatusPill feedback={feedback} dirty={dirty} submitting={submitting} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip label="策略设置">
          <Button
            onClick={onToggleInspector}
            aria-pressed={inspectorOpen}
            aria-label="策略设置"
            className={cn(collapsible, inspectorOpen && toggleActive)}
          >
            <SlidersHorizontal /><Label>策略设置</Label>
          </Button>
        </Tooltip>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
        <Tooltip label="预检策略">
          <Button onClick={onPreflight} disabled={submitting || !canSubmit} aria-label="预检" className={collapsible}>
            <ShieldCheck /><Label>预检</Label>
          </Button>
        </Tooltip>
        <Tooltip label="保存策略">
          <Button onClick={onSave} disabled={submitting || !canSubmit} aria-label="保存" className={collapsible}>
            <Save /><Label>保存</Label>
          </Button>
        </Tooltip>
        <Tooltip label={dirty ? "请先保存当前草稿" : "使用已保存策略启动运行"}>
          <span className="inline-flex">
            <Button variant="primary" onClick={onLaunch} disabled={submitting || dirty} aria-label="运行" className={collapsible}>
              <Play fill="currentColor" /><Label>运行</Label>
            </Button>
          </span>
        </Tooltip>
      </div>
    </header>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="hidden @4xl:inline">{children}</span>;
}

function StatusPill({
  feedback,
  dirty,
  submitting,
}: {
  feedback: ComposerFeedback | undefined;
  dirty: boolean;
  submitting: boolean;
}) {
  const failed = feedback?.kind === "error";
  const tone = failed ? "danger" : feedback ? "success" : dirty ? "warning" : "neutral";
  const text = failed ? "操作失败" : feedback?.message ?? (dirty ? "草稿待预检" : "已加载策略");
  const Icon = submitting ? LoaderCircle : failed ? CircleAlert : feedback ? Check : dirty ? CircleDot : Check;
  return (
    <Badge
      tone={tone}
      role="status"
      className="h-7 min-w-0 max-w-full gap-1.5 px-3 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <Icon aria-hidden className={cn(submitting && "motion-safe:animate-spin")} />
      <span className="truncate">{text}</span>
    </Badge>
  );
}
