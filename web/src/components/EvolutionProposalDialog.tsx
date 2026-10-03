import { Braces, FileText, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toBlueprintDefinition, utf8ByteLength } from "../evolution";
import { agentRoleLabel, strategyDisplayName } from "../presentation";
import type { EvolutionSnapshot, PublicConfig, StrategyBlueprintDefinition } from "../types";
import { cn } from "../ui/cn";
import { Modal } from "../ui/dialog";
import { Callout, Field, Input, Select, Textarea } from "../ui/form";
import { ActionButton } from "./evolution/controls";
import { useRestoreFocus } from "./evolution/useRestoreFocus";

export type EvolutionProposalInput =
  | { kind: "strategy"; name: string; definition: StrategyBlueprintDefinition; commandId: string }
  | { kind: "prompt"; role: string; content: string; commandId: string };

interface EvolutionProposalDialogProps {
  open: boolean;
  config: PublicConfig;
  snapshot: EvolutionSnapshot;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: EvolutionProposalInput): Promise<void>;
}

const formId = "evolution-proposal-form";
const maxPromptBytes = 262_144;

export function EvolutionProposalDialog({
  open,
  config,
  snapshot,
  busy,
  error,
  onClose,
  onSubmit,
}: EvolutionProposalDialogProps) {
  useRestoreFocus(open);
  const strategyNames = useMemo(() => Object.keys(config.strategies.definitions).sort(), [config]);
  const [kind, setKind] = useState<"strategy" | "prompt">("strategy");
  const [sourceName, setSourceName] = useState(config.strategies.default);
  const [targetName, setTargetName] = useState(`${config.strategies.default}-evolved`);
  const [topology, setTopology] = useState<"parallel-dag" | "sequential">("parallel-dag");
  const [maxParallel, setMaxParallel] = useState(2);
  const [maxReworkAttempts, setMaxReworkAttempts] = useState(2);
  const [role, setRole] = useState(snapshot.promptRoles[0]?.role ?? "");
  const [content, setContent] = useState("");
  const [commandId, setCommandId] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    const defaultName = config.strategies.default;
    const definition = config.strategies.definitions[defaultName];
    setKind("strategy");
    setSourceName(defaultName);
    setTargetName(`${defaultName}-evolved`);
    setTopology(definition?.topology?.mode ?? "parallel-dag");
    setMaxParallel(definition?.maxParallel ?? config.project.maxParallel);
    setMaxReworkAttempts(definition?.maxReworkAttempts ?? 2);
    setRole(snapshot.promptRoles[0]?.role ?? "");
    setContent("");
    setCommandId(crypto.randomUUID());
    setSubmitted(false);
  }, [config, open, snapshot.promptRoles]);

  const byteLength = utf8ByteLength(content);
  const targetNameValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(targetName);
  const strategyLimitsValid = Number.isInteger(maxParallel)
    && maxParallel >= 1
    && maxParallel <= 32
    && Number.isInteger(maxReworkAttempts)
    && maxReworkAttempts >= 0
    && maxReworkAttempts <= 10;
  const canSubmit = kind === "strategy"
    ? Boolean(targetNameValid && strategyLimitsValid && config.strategies.definitions[sourceName])
    : Boolean(role && content.trim() && byteLength <= maxPromptBytes);
  const frozen = busy || submitted;
  const nameInvalid = !targetNameValid && targetName.length > 0;

  const changeSource = (name: string) => {
    const definition = config.strategies.definitions[name];
    setSourceName(name);
    setTargetName(`${name}-evolved`);
    setTopology(definition?.topology?.mode ?? "parallel-dag");
    setMaxParallel(definition?.maxParallel ?? config.project.maxParallel);
    setMaxReworkAttempts(definition?.maxReworkAttempts ?? 2);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitted(true);
    if (kind === "prompt") {
      void onSubmit({ kind, role, content, commandId });
      return;
    }
    const source = config.strategies.definitions[sourceName];
    if (!source) return;
    const definition = toBlueprintDefinition(source);
    definition.topology = { mode: topology };
    definition.maxParallel = maxParallel;
    definition.maxReworkAttempts = maxReworkAttempts;
    void onSubmit({ kind, name: targetName.trim(), definition, commandId });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      locked={busy}
      title="新建演进候选"
      description="候选需先通过服务端结构预检，再由人工确认精确变更后才会生效。"
      className="w-[min(580px,calc(100vw-32px))] text-sm"
      footer={
        <>
          <ActionButton onClick={onClose} disabled={busy}>取消</ActionButton>
          <ActionButton type="submit" form={formId} variant="primary" disabled={busy || !canSubmit}>
            <Plus />
            {busy ? "提交中" : submitted ? "重试原候选" : "创建候选"}
          </ActionButton>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <div role="group" aria-label="候选类型" className="bd grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
          <KindOption active={kind === "strategy"} disabled={frozen} onClick={() => setKind("strategy")} icon={<Braces />} label="执行策略" />
          <KindOption
            active={kind === "prompt"}
            disabled={frozen || snapshot.promptRoles.length === 0}
            onClick={() => setKind("prompt")}
            icon={<FileText />}
            label="角色提示词"
          />
        </div>

        {kind === "strategy" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="基于已有策略" htmlFor="evolution-source" className="sm:col-span-3">
              <Select id="evolution-source" value={sourceName} disabled={frozen} onChange={(event) => changeSource(event.target.value)} className="h-9">
                {strategyNames.map((name) => <option value={name} key={name}>{strategyDisplayName(name)}</option>)}
              </Select>
            </Field>
            <Field
              label="候选策略名称"
              htmlFor="evolution-target"
              className="sm:col-span-3"
              hint={nameInvalid ? <span className="text-danger-ink">名称需以字母或数字开头，只能包含字母、数字、点、下划线和连字符。</span> : "新策略会以该名称保存为本地自定义执行策略。"}
            >
              <Input
                id="evolution-target"
                data-autofocus
                value={targetName}
                maxLength={64}
                disabled={frozen}
                aria-invalid={nameInvalid}
                onChange={(event) => setTargetName(event.target.value)}
                className={cn(nameInvalid && "border-danger!")}
              />
            </Field>
            <Field label="执行拓扑" htmlFor="evolution-topology">
              <Select id="evolution-topology" value={topology} disabled={frozen} onChange={(event) => setTopology(event.target.value as typeof topology)} className="h-9">
                <option value="parallel-dag">依赖并行</option>
                <option value="sequential">顺序执行</option>
              </Select>
            </Field>
            <Field label="最大并行数" htmlFor="evolution-max-parallel">
              <Input id="evolution-max-parallel" type="number" min={1} max={32} value={maxParallel} disabled={frozen} onChange={(event) => setMaxParallel(Number(event.target.value))} />
            </Field>
            <Field label="最多返工次数" htmlFor="evolution-max-rework">
              <Input id="evolution-max-rework" type="number" min={0} max={10} value={maxReworkAttempts} disabled={frozen} onChange={(event) => setMaxReworkAttempts(Number(event.target.value))} />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="角色" htmlFor="evolution-role">
              <Select id="evolution-role" aria-label="提示词角色" value={role} disabled={frozen} onChange={(event) => setRole(event.target.value)} className="h-9">
                {snapshot.promptRoles.map((item) => <option value={item.role} key={item.role}>{agentRoleLabel(item.role)}</option>)}
              </Select>
            </Field>
            <Field
              label="提示词内容"
              htmlFor="evolution-content"
              hint={
                <span className={cn("block text-right tabular-nums", byteLength > maxPromptBytes && "text-danger-ink")}>
                  {byteLength.toLocaleString("zh-CN")} / 262,144 字节
                </span>
              }
            >
              <Textarea
                id="evolution-content"
                rows={12}
                value={content}
                disabled={frozen}
                autoFocus
                spellCheck={false}
                onChange={(event) => setContent(event.target.value)}
                className="min-h-56 font-mono! text-xs! leading-relaxed"
              />
            </Field>
          </div>
        )}

        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

function KindOption({ active, disabled, onClick, icon, label }: {
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
