import { Bot, Check, GitPullRequest, LockKeyhole, Network, PanelLeftOpen, ShieldCheck, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { strategyDisplayName } from "../../presentation";
import type { StrategyDefinition } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { SectionTitle } from "../../ui/card";
import { Tooltip } from "../../ui/tooltip";
import { DrawerHeader, DrawerPanel } from "./DrawerPanel";
import { topologyModeLabel } from "./draft";

export function LibraryPanel({
  open,
  compact,
  strategyNames,
  definitions,
  selectedName,
  planApproval,
  submitting,
  onSelect,
  onTogglePlanApproval,
  onClose,
}: {
  open: boolean;
  compact: boolean;
  strategyNames: string[];
  definitions: Record<string, StrategyDefinition>;
  selectedName: string;
  planApproval: boolean;
  submitting: boolean;
  onSelect(name: string): void;
  onTogglePlanApproval(): void;
  onClose(): void;
}) {
  return (
    <DrawerPanel side="left" open={open} compact={compact} label="策略库">
      <DrawerHeader
        icon={<PanelLeftOpen />}
        title="策略与阶段"
        subtitle={`${strategyNames.length} 个策略`}
        actions={
          <Tooltip label="关闭策略库">
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭策略库"><X /></Button>
          </Tooltip>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto text-xs">
        <div className="bd-b flex flex-col gap-1 p-2">
          {strategyNames.map((name) => {
            const item = definitions[name];
            if (!item) return null;
            const selected = name === selectedName;
            return (
              <Button
                key={name}
                variant="ghost"
                onClick={() => onSelect(name)}
                disabled={submitting}
                title={name}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "h-auto w-full flex-col items-start justify-center gap-1.5 whitespace-normal rounded-lg px-3 py-2.5 text-left",
                  selected && "bg-accent-soft text-ink shadow-[inset_0_0_0_1px_var(--accent-line)] hover:bg-accent-soft",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <Network className={cn(selected ? "text-accent-ink" : "text-muted")} />
                  <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{strategyDisplayName(name)}</strong>
                  {selected && <Check aria-hidden className="text-accent-ink" />}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={selected ? "active" : "neutral"}>
                    {topologyModeLabel(item.topology?.mode ?? item.compiledTopology.mode)}
                  </Badge>
                  <Badge tone={item.source === "custom" ? "info" : "neutral"}>
                    {item.source === "custom" ? "自定义蓝图" : "项目配置"}
                  </Badge>
                </span>
              </Button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          <SectionTitle>执行阶段</SectionTitle>
          <p className="m-0 mb-1 text-xs leading-relaxed text-muted">固定阶段由编排器保证，可选阶段可按需加入策略图。</p>
          <FixedStage icon={<Bot />} label="角色阶段" />
          <FixedStage icon={<Users />} label="执行池" />
          <FixedStage icon={<ShieldCheck />} label="质量门禁" />
          <Button
            variant="secondary"
            onClick={onTogglePlanApproval}
            aria-pressed={planApproval}
            disabled={submitting}
            className={cn(
              "h-10 w-full justify-between px-3 text-xs",
              planApproval && "bg-accent-soft text-accent-ink hover:bg-accent-soft",
            )}
          >
            <span className="flex items-center gap-2"><Check />计划审批</span>
            <small className={cn("text-2xs", planApproval ? "text-accent-ink" : "text-muted")}>{planApproval ? "已启用" : "可添加"}</small>
          </Button>
          <FixedStage icon={<GitPullRequest />} label="发布边界" />
        </div>
      </div>
    </DrawerPanel>
  );
}

function FixedStage({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="bd flex h-10 items-center justify-between gap-2 rounded-md bg-surface-2 px-3 text-xs text-ink-2">
      <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted">{icon}{label}</span>
      <LockKeyhole size={12} aria-label="固定阶段" className="text-muted" />
    </div>
  );
}
