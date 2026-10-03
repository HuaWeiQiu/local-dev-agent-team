import { RotateCcw, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { agentRoleLabel, orderedRoles, profileDisplayName, strategyDisplayName } from "../../presentation";
import type { PublicConfig, StrategyDefinition } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import { Field, Input, Select } from "../../ui/form";
import { Toggle } from "../../ui/toggle";
import { Tooltip } from "../../ui/tooltip";
import { DrawerHeader, DrawerPanel } from "./DrawerPanel";
import type { DraftUpdater, StrategyDraft } from "./draft";

type NumericField =
  | "maxReworkAttempts"
  | "maxAgentInvocations"
  | "executionTimeoutSeconds"
  | "approvalTimeoutSeconds"
  | "maxProcessOutputBytes"
  | "maxArtifactBytes";

export function InspectorPanel({
  open,
  compact,
  config,
  definition,
  selectedName,
  draft,
  blueprintName,
  submitting,
  onBlueprintNameChange,
  onDraft,
  onReset,
  onDelete,
  onClose,
}: {
  open: boolean;
  compact: boolean;
  config: PublicConfig;
  definition: StrategyDefinition;
  selectedName: string;
  draft: StrategyDraft;
  blueprintName: string;
  submitting: boolean;
  onBlueprintNameChange(name: string): void;
  onDraft: DraftUpdater;
  onReset(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const nameId = useId();
  const sequential = draft.mode === "sequential";
  const custom = definition.source === "custom";
  const roleNames = orderedRoles(Object.keys(config.roles));
  const setNumber = (field: NumericField) => (value: number) =>
    onDraft((current) => ({ ...current, [field]: value }));

  return (
    <DrawerPanel side="right" open={open} compact={compact} label="策略属性">
      <DrawerHeader
        icon={<SlidersHorizontal />}
        title="策略属性"
        subtitle={
          <>
            <span className="truncate">{strategyDisplayName(selectedName)}</span>
            <Badge tone={custom ? "info" : "neutral"}>{custom ? "自定义" : "只读配置"}</Badge>
          </>
        }
        actions={
          <>
            <Tooltip label="重置策略草稿">
              <Button variant="ghost" size="icon-sm" onClick={onReset} aria-label="重置策略草稿" disabled={submitting}>
                <RotateCcw />
              </Button>
            </Tooltip>
            {custom && (
              <Tooltip label="删除自定义策略">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    if (window.confirm(`删除自定义策略 ${selectedName}？`)) onDelete();
                  }}
                  disabled={submitting}
                  aria-label="删除自定义策略"
                  className="text-danger-ink hover:bg-danger-soft hover:text-danger-ink"
                >
                  <Trash2 />
                </Button>
              </Tooltip>
            )}
            <Tooltip label="关闭策略设置">
              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭策略设置"><X /></Button>
            </Tooltip>
          </>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto text-xs">
        <InspectorSection title="蓝图">
          <Field
            label="蓝图名称"
            htmlFor={nameId}
            hint={custom ? "自定义策略，可原名更新" : "配置策略只读，将另存为自定义蓝图"}
          >
            <Input
              id={nameId}
              value={blueprintName}
              onChange={(event) => onBlueprintNameChange(event.target.value)}
              aria-label="策略蓝图名称"
              spellCheck={false}
              disabled={submitting}
              className="text-sm!"
            />
          </Field>
        </InspectorSection>

        <InspectorSection title="执行拓扑">
          <div role="group" aria-label="执行拓扑" className="bd grid grid-cols-2 gap-0.5 rounded-lg bg-surface-3 p-0.5 font-medium">
            <ModeButton
              selected={draft.mode === "parallel-dag"}
              disabled={submitting}
              onClick={() => onDraft((current) => ({ ...current, mode: "parallel-dag" }))}
            >并行 DAG</ModeButton>
            <ModeButton
              selected={sequential}
              disabled={submitting}
              onClick={() => onDraft((current) => ({ ...current, mode: "sequential", maxParallel: 1 }))}
            >串行</ModeButton>
          </div>
          <p className="m-0 text-xs leading-relaxed text-muted">
            {sequential ? "任务逐个依次完成，并行上限固定为 1。" : "按依赖关系并行调度任务波次。"}
          </p>
        </InspectorSection>

        <InspectorSection title="并发与限额">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <NumberField
              label="并行上限"
              value={sequential ? 1 : draft.maxParallel}
              min={1}
              max={32}
              disabled={submitting || sequential}
              onChange={(value) => onDraft((current) => ({
                ...current,
                maxParallel: value,
                swarmMaxConcurrency: Math.min(current.swarmMaxConcurrency, value),
              }))}
            />
            <NumberField
              label="Swarm 并发"
              value={sequential ? 1 : Math.min(draft.swarmMaxConcurrency, draft.maxParallel)}
              min={1}
              max={32}
              disabled={submitting || sequential}
              onChange={(value) => onDraft((current) => ({
                ...current,
                swarmMaxConcurrency: Math.min(value, current.maxParallel),
              }))}
            />
            <NumberField label="返工上限" value={draft.maxReworkAttempts} min={0} max={10} disabled={submitting} onChange={setNumber("maxReworkAttempts")} />
            <NumberField label="角色调用" value={draft.maxAgentInvocations} min={1} max={1000} disabled={submitting} onChange={setNumber("maxAgentInvocations")} />
            <NumberField label="执行超时（秒）" value={draft.executionTimeoutSeconds} min={60} max={172_800} disabled={submitting} onChange={setNumber("executionTimeoutSeconds")} />
            <NumberField label="审批超时（秒）" value={draft.approvalTimeoutSeconds} min={60} max={604_800} disabled={submitting} onChange={setNumber("approvalTimeoutSeconds")} />
            <NumberField label="输出上限（字节）" value={draft.maxProcessOutputBytes} min={65_536} max={104_857_600} disabled={submitting} onChange={setNumber("maxProcessOutputBytes")} />
            <NumberField label="产物上限（字节）" value={draft.maxArtifactBytes} min={1_048_576} max={10_737_418_240} disabled={submitting} onChange={setNumber("maxArtifactBytes")} />
          </div>
        </InspectorSection>

        <InspectorSection title="能力与门禁">
          <div className="-my-1 flex flex-col">
            <Toggle
              className="relative"
              label="代码探索"
              hint="架构前只读 explore（Kimi 形态）"
              checked={draft.exploreEnabled}
              onChange={(event) => onDraft((current) => ({ ...current, exploreEnabled: event.target.checked }))}
              disabled={submitting}
            />
            <Toggle
              className="relative"
              label="架构顾问"
              hint="同一错误重复、交付前按需召唤架构角色（只读）"
              checked={draft.advisorEnabled}
              onChange={(event) => onDraft((current) => ({ ...current, advisorEnabled: event.target.checked }))}
              disabled={submitting}
            />
            {draft.advisorEnabled && (
              <div className="bd-l my-1 ml-4 pl-4">
                <NumberField
                  label="顾问次数上限（每次运行）"
                  value={draft.advisorMaxConsultations}
                  min={1}
                  max={10}
                  disabled={submitting}
                  onChange={(value) => onDraft((current) => ({ ...current, advisorMaxConsultations: value }))}
                />
              </div>
            )}
            <Toggle
              className="relative"
              label="计划审批"
              hint="执行波次前暂停"
              checked={draft.planApproval}
              onChange={(event) => onDraft((current) => ({ ...current, planApproval: event.target.checked }))}
              disabled={submitting}
            />
          </div>
        </InspectorSection>

        <InspectorSection title="角色配置" last>
          {roleNames.length === 0 ? (
            <p className="m-0 text-xs text-muted">当前项目没有可配置的角色。</p>
          ) : (
            <div className="role-policy-list flex flex-col gap-2.5">
              {roleNames.map((role) => {
                const policy = config.roles[role];
                if (!policy) return null;
                const override = draft.roleProfiles[role];
                return (
                  <label key={role} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-2">
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", override ? "bg-accent" : "bg-transparent")} />
                      <span className="truncate">{agentRoleLabel(role)}</span>
                    </span>
                    <Select
                      value={override ?? ""}
                      disabled={submitting}
                      onChange={(event) => onDraft((current) => {
                        const roleProfiles = { ...current.roleProfiles };
                        if (event.target.value) roleProfiles[role] = event.target.value;
                        else delete roleProfiles[role];
                        return { ...current, roleProfiles };
                      })}
                    >
                      <option value="">策略默认（{profileDisplayName(policy.defaultProfile, config.profiles[policy.defaultProfile])}）</option>
                      {policy.allowedProfiles.map((profile) => (
                        <option key={profile} value={profile}>
                          {profileDisplayName(profile, config.profiles[profile])}
                        </option>
                      ))}
                    </Select>
                  </label>
                );
              })}
            </div>
          )}
        </InspectorSection>
      </div>
    </DrawerPanel>
  );
}

function InspectorSection({ title, last = false, children }: { title: string; last?: boolean; children: ReactNode }) {
  return (
    <section className={cn("flex flex-col gap-3 px-4 py-4", !last && "bd-b")}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function ModeButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn("h-7 rounded-md", selected && "bg-surface text-accent-ink shadow-card hover:bg-surface hover:text-accent-ink")}
    >
      {children}
    </Button>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} className="min-w-0">
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        title={`${min.toLocaleString()} – ${max.toLocaleString()}`}
        disabled={disabled}
        className="h-8 px-2.5 tabular-nums"
        onChange={(event) => {
          const valueAsNumber = event.target.valueAsNumber;
          if (Number.isFinite(valueAsNumber)) onChange(Math.min(max, Math.max(min, valueAsNumber)));
        }}
      />
    </Field>
  );
}
