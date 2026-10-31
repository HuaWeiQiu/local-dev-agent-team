import { Braces, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { agentRoleLabel, strategyDisplayName } from "../../../presentation";
import { cn } from "../../../ui/cn";
import { Field, Input, Select, Textarea } from "../../../ui/form";
import { ActionButton } from "../controls";
import type { Draft, ProposalKind, Topology } from "./model";
import { MAX_PROMPT_BYTES, byteLengthOf, isValidTargetName } from "./model";

export function KindSwitch({
  kind,
  frozen,
  promptsAvailable,
  onChange,
}: {
  kind: ProposalKind;
  frozen: boolean;
  promptsAvailable: boolean;
  onChange(kind: ProposalKind): void;
}) {
  return (
    <div role="group" aria-label="候选类型" className="bd grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
      <KindOption active={kind === "strategy"} disabled={frozen} onClick={() => onChange("strategy")} icon={<Braces />} label="执行策略" />
      <KindOption
        active={kind === "prompt"}
        disabled={frozen || !promptsAvailable}
        onClick={() => onChange("prompt")}
        icon={<FileText />}
        label="角色提示词"
      />
    </div>
  );
}

function KindOption({
  active,
  disabled,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  disabled: boolean;
  onClick(): void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <ActionButton
      variant="ghost"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn("h-8", active && "bg-surface text-ink shadow-card hover:bg-surface")}
    >
      <span aria-hidden className="inline-flex">{icon}</span>
      {label}
    </ActionButton>
  );
}

export function StrategyFields({
  draft,
  strategyNames,
  frozen,
  onChange,
}: {
  draft: Draft;
  strategyNames: string[];
  frozen: boolean;
  onChange(patch: Partial<Draft>): void;
}) {
  const nameInvalid = !isValidTargetName(draft.targetName) && draft.targetName.length > 0;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field label="基于已有策略" htmlFor="evolution-source" className="sm:col-span-3">
        <Select
          id="evolution-source"
          value={draft.sourceName}
          disabled={frozen}
          onChange={(event) => onChange({ sourceName: event.target.value })}
          className="h-9"
        >
          {strategyNames.map((name) => (
            <option value={name} key={name}>{strategyDisplayName(name)}</option>
          ))}
        </Select>
      </Field>
      <Field
        label="候选策略名称"
        htmlFor="evolution-target"
        className="sm:col-span-3"
        hint={nameInvalid
          ? <span className="text-danger-ink">名称需以字母或数字开头，只能包含字母、数字、点、下划线和连字符。</span>
          : "新策略会以该名称保存为本地自定义执行策略。"}
      >
        <Input
          id="evolution-target"
          data-autofocus
          value={draft.targetName}
          maxLength={64}
          disabled={frozen}
          aria-invalid={nameInvalid}
          onChange={(event) => onChange({ targetName: event.target.value })}
          className={cn(nameInvalid && "border-danger!")}
        />
      </Field>
      <Field label="执行拓扑" htmlFor="evolution-topology">
        <Select
          id="evolution-topology"
          value={draft.topology}
          disabled={frozen}
          onChange={(event) => onChange({ topology: event.target.value as Topology })}
          className="h-9"
        >
          <option value="parallel-dag">依赖并行</option>
          <option value="sequential">顺序执行</option>
        </Select>
      </Field>
      <Field label="最大并行数" htmlFor="evolution-max-parallel">
        <Input
          id="evolution-max-parallel"
          type="number"
          min={1}
          max={32}
          value={draft.maxParallel}
          disabled={frozen}
          onChange={(event) => onChange({ maxParallel: Number(event.target.value) })}
        />
      </Field>
      <Field label="最多返工次数" htmlFor="evolution-max-rework">
        <Input
          id="evolution-max-rework"
          type="number"
          min={0}
          max={10}
          value={draft.maxReworkAttempts}
          disabled={frozen}
          onChange={(event) => onChange({ maxReworkAttempts: Number(event.target.value) })}
        />
      </Field>
    </div>
  );
}

export function PromptFields({
  draft,
  promptRoles,
  frozen,
  onChange,
}: {
  draft: Draft;
  promptRoles: Array<{ role: string }>;
  frozen: boolean;
  onChange(patch: Partial<Draft>): void;
}) {
  const bytes = byteLengthOf(draft.content);
  return (
    <div className="flex flex-col gap-4">
      <Field label="角色" htmlFor="evolution-role">
        <Select
          id="evolution-role"
          aria-label="提示词角色"
          value={draft.role}
          disabled={frozen}
          onChange={(event) => onChange({ role: event.target.value })}
          className="h-9"
        >
          {promptRoles.map((item) => (
            <option value={item.role} key={item.role}>{agentRoleLabel(item.role)}</option>
          ))}
        </Select>
      </Field>
      <Field
        label="提示词内容"
        htmlFor="evolution-content"
        hint={
          <span className={cn("block text-right tabular-nums", bytes > MAX_PROMPT_BYTES && "text-danger-ink")}>
            {bytes.toLocaleString("zh-CN")} / 262,144 字节
          </span>
        }
      >
        <Textarea
          id="evolution-content"
          rows={12}
          value={draft.content}
          disabled={frozen}
          autoFocus
          spellCheck={false}
          onChange={(event) => onChange({ content: event.target.value })}
          className="min-h-56 font-mono! text-xs! leading-relaxed"
        />
      </Field>
    </div>
  );
}
