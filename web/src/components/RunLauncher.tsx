import { ChevronDown, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { retrieveExperience } from "../api";
import { namedDeliverablesInGoal } from "../plan-completeness";
import {
  agentRoleLabel,
  morphologySummary,
  orderedRoles,
  profileDisplayName,
  strategyDisplayName,
  summarizeGoal,
} from "../presentation";
import type {
  CliId,
  CliInventory,
  ExperiencePlanningBundle,
  FlowTemplateChoice,
  ProjectScope,
  PublicConfig,
  RoleBindingInput,
  StartRunInput,
} from "../types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Modal } from "../ui/dialog";
import { Callout, Field, Select, Textarea } from "../ui/form";

interface RunLauncherProps {
  open: boolean;
  config: PublicConfig;
  /** 有 scope 时目标输入区展示经验注入预览 */
  scope?: ProjectScope;
  initialStrategy?: string;
  initialGoal?: string;
  busy: boolean;
  error: string | undefined;
  /** Global defaults + inventory for CLI picker */
  roleDefaults?: Record<string, RoleBindingInput>;
  inventory?: CliInventory;
  /** 「设置」中的新建运行选型开关；关闭时角色区只读展示当前绑定 */
  showCliPicker?: boolean;
  onClose(): void;
  /** 返回是否启动成功；失败时保留目标文本与弹窗 */
  onSubmit(input: StartRunInput): Promise<boolean>;
}

const TEMPLATE_OPTIONS: Array<{ id: FlowTemplateChoice; label: string; hint: string }> = [
  { id: "auto", label: "自动选择", hint: "根据目标规模自动选择流程，并在运行中展示理由。" },
  { id: "quick", label: "快速", hint: "直接实现并校验，重复失败时尽早停下，适合小改动。" },
  { id: "standard", label: "标准", hint: "规划 → 实现 → 评审 → 交付，适合多数需求。" },
  { id: "full", label: "完整", hint: "增加调研与更严格的评审，适合大改动或高风险变更。" },
];

const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export function RunLauncher({
  open,
  config,
  scope,
  initialStrategy,
  initialGoal,
  busy,
  error,
  roleDefaults,
  inventory,
  showCliPicker = true,
  onClose,
  onSubmit,
}: RunLauncherProps) {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState(config.strategies.default);
  const [template, setTemplate] = useState<FlowTemplateChoice>("auto");
  const [advanced, setAdvanced] = useState(true);
  const [bindings, setBindings] = useState<Record<string, RoleBindingInput>>({});
  const [useCliPicker, setUseCliPicker] = useState(true);
  const [experiencePreview, setExperiencePreview] = useState<ExperiencePlanningBundle>();

  const roles = useMemo(() => orderedRoles(Object.keys(config.roles)), [config.roles]);

  // 目标输入防抖预览：启动时将注入规划的已验证经验（只读 preview，不计命中）
  useEffect(() => {
    if (!scope) return;
    const text = goal.trim();
    if (!text) {
      setExperiencePreview(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      retrieveExperience(scope, text, { preview: true })
        .then((bundle) => setExperiencePreview(bundle))
        .catch(() => setExperiencePreview(undefined));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [goal, scope]);

  const clisById = useMemo(() => {
    const map = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
    return map;
  }, [inventory]);

  // 兜底绑定：优先第一个已安装且可调用的 CLI，避免选中「未安装」的禁用项
  const fallbackBinding = useMemo<RoleBindingInput>(() => {
    const usable = inventory?.clis.find((cli) => cli.installed && cli.runtimeSupported);
    if (usable) {
      return {
        cli: usable.id,
        ...(usable.defaultModel ? { model: usable.defaultModel } : {}),
        reasoning: usable.defaultReasoning ?? "high",
      };
    }
    return { cli: "grok" as CliId, model: "grok", reasoning: "high" };
  }, [inventory]);

  // 只在弹窗 open 由 false→true 时初始化一次；
  // 之后 roleDefaults / inventory 的晚到刷新（如焦点回归检测）不得覆盖用户编辑
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (initialGoal) setGoal(initialGoal);
    setTemplate("auto");
    setStrategy(
      initialStrategy && config.strategies.definitions[initialStrategy]
        ? initialStrategy
        : config.strategies.default,
    );
    const next: Record<string, RoleBindingInput> = {};
    for (const role of roles) {
      next[role] = roleDefaults?.[role] ?? fallbackBinding;
    }
    setBindings(next);
    setUseCliPicker(
      showCliPicker && Boolean(inventory && inventory.clis.some((c) => c.installed && c.runtimeSupported)),
    );
    // 仅在打开瞬间读取最新 props；deps 变化由 initializedRef 拦截
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  const strategyDefinition = config.strategies.definitions[strategy];

  const updateBinding = (role: string, patch: Partial<RoleBindingInput>) => {
    setBindings((current) => {
      const base = current[role] ?? fallbackBinding;
      const next = { ...base, ...patch };
      if (patch.cli) {
        const cli = clisById.get(patch.cli);
        const model = cli?.defaultModel ?? cli?.models[0]?.id;
        const reasoning = cli?.defaultReasoning
          ?? cli?.models[0]?.reasoningOptions?.[0]
          ?? next.reasoning
          ?? "high";
        if (model) next.model = model;
        next.reasoning = reasoning;
      }
      return { ...current, [role]: next };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) return;

    const roleBindings = useCliPicker
      ? Object.fromEntries(
          Object.entries(bindings).filter(([role]) => config.roles[role]),
        )
      : undefined;

    const succeeded = await onSubmit({
      goal: trimmedGoal,
      strategy,
      ...(template !== "auto" ? { template } : {}),
      profileOverrides: {},
      ...(roleBindings && Object.keys(roleBindings).length > 0 ? { roleBindings } : {}),
    });
    // 仅启动成功才清空目标文本；失败时保留输入与弹窗
    if (succeeded) setGoal("");
  };

  const formId = "run-launcher-form";
  const deliverables = namedDeliverablesInGoal(goal);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="启动 Agent 团队"
      description="描述目标，选择执行策略与各角色使用的 CLI / 模型。"
      className="w-[min(720px,calc(100vw-32px))]"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" form={formId} variant="primary" disabled={busy || !goal.trim()}>
            <Play fill="currentColor" />
            {busy ? "正在启动" : "启动运行"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <Field
          label="目标"
          htmlFor="run-goal"
          hint="大改动请列出 T1–Tn、路径和验收。只写「根据文档执行」通常只会得到一条读文档任务。"
        >
          <Textarea
            id="run-goal"
            data-autofocus
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：为订单模块增加幂等退款接口，并补齐测试"
            rows={4}
            required
          />
        </Field>
        {deliverables.length > 0 && (
          <Callout tone="info" className="-mt-2">将校验计划是否覆盖 {deliverables.join("、")}。</Callout>
        )}
        {experiencePreview && experiencePreview.items.length > 0 && (
          <Callout tone="success" className="-mt-2">
            将注入 {experiencePreview.items.length} 条已验证经验：
            {experiencePreview.items
              .slice(0, 3)
              .map((item) => summarizeGoal(item.summary, 24))
              .join("；")}
            {experiencePreview.items.length > 3 ? " …" : ""}
          </Callout>
        )}

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 text-xs font-medium text-ink-2">执行策略</legend>
          <div className="strategy-segments grid gap-2 sm:grid-cols-2">
            {Object.entries(config.strategies.definitions).map(([name, definition]) => (
              <label
                key={name}
                className={cn(
                  "bd relative flex cursor-pointer flex-col gap-1 rounded-lg bg-surface p-3 text-xs text-muted transition-colors outline-accent outline-offset-2 hover:border-line-strong hover:bg-surface-2 has-[:focus-visible]:outline-2",
                  strategy === name && "is-selected border-accent bg-accent-soft/60 text-ink-2 hover:bg-accent-soft/60",
                )}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="strategy"
                  value={name}
                  checked={strategy === name}
                  onChange={() => setStrategy(name)}
                />
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-3.5 place-items-center rounded-full border border-line-strong bg-surface",
                      strategy === name && "border-accent bg-accent",
                    )}
                  >
                    {strategy === name && <span className="size-1.5 rounded-full bg-on-accent" />}
                  </span>
                  <strong className="text-sm font-semibold text-ink" title={name}>{strategyDisplayName(name)}</strong>
                </span>
                <span>
                  并行 {definition.maxParallel ?? config.project.maxParallel} · 调用 ≤{definition.maxAgentInvocations ?? 64} · {formatDuration(definition.executionTimeoutSeconds ?? 14_400)}
                </span>
                <span>
                  返工 {definition.maxReworkAttempts ?? 0} · 审批 {definition.approvalGates?.includes("plan") ? "计划+交付" : "交付"}
                </span>
                <span>{morphologySummary(definition, config.project.maxParallel)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label="流程模板"
          htmlFor="run-template"
          hint={TEMPLATE_OPTIONS.find((option) => option.id === template)?.hint}
        >
          <Select
            id="run-template"
            value={template}
            onChange={(event) => setTemplate(event.target.value as FlowTemplateChoice)}
          >
            {TEMPLATE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </Select>
        </Field>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            className="-mx-1 flex w-fit cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs font-medium text-ink-2 hover:text-ink focus-ring"
            onClick={() => setAdvanced((value) => !value)}
            aria-expanded={advanced}
          >
            <ChevronDown className={cn("size-4 transition-transform", !advanced && "-rotate-90")} />
            角色与模型（CLI / 模型 / 思考深度）
          </button>
          {advanced && (
            <div className="role-binding-grid bd flex flex-col divide-y overflow-hidden rounded-lg bg-surface">
              {!useCliPicker && (
                <Callout tone="warning" className="rounded-none border-0">
                  {!showCliPicker
                    ? "已在「设置」中关闭新建运行选型，将使用项目 profile 默认配置；以下为当前默认绑定（只读）。"
                    : "未检测到可用全局 CLI 清单，将使用项目 profile 默认配置。可在「设置」中检索本机 CLI。"}
                </Callout>
              )}
              {roles.map((role) => {
                if (!config.roles[role]) return null;
                const binding = bindings[role] ?? fallbackBinding;
                const cli = clisById.get(binding.cli);
                const models = cli?.models ?? [];
                const reasoningOptions = models.find((m) => m.id === binding.model)?.reasoningOptions
                  ?? cli?.models[0]?.reasoningOptions
                  ?? ["low", "medium", "high"];
                return (
                  <div key={role} className="role-binding-card grid items-center gap-2 px-3 py-2.5 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
                    <strong className="text-sm font-semibold text-ink">{agentRoleLabel(role)}</strong>
                    <BindingSelect label="CLI">
                      <Select
                        value={binding.cli}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { cli: event.target.value as CliId })}
                      >
                        {(["codex", "grok", "claude", "kimi"] as CliId[]).map((id) => {
                          const item = clisById.get(id);
                          const disabled = !item?.installed || !item.runtimeSupported;
                          return (
                            <option key={id} value={id} disabled={disabled}>
                              {CLI_LABEL[id]}
                              {!item?.installed ? " · 未装" : !item.runtimeSupported ? " · 不可调用" : ""}
                            </option>
                          );
                        })}
                      </Select>
                    </BindingSelect>
                    <BindingSelect label="模型">
                      <Select
                        value={binding.model ?? ""}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { model: event.target.value })}
                      >
                        {(models.length > 0 ? models : [{ id: binding.model ?? "default", label: binding.model ?? "默认" }]).map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </Select>
                    </BindingSelect>
                    <BindingSelect label="思考">
                      <Select
                        value={binding.reasoning ?? "high"}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { reasoning: event.target.value })}
                      >
                        {reasoningOptions.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </Select>
                    </BindingSelect>
                    {!useCliPicker && (
                      <small className="text-xs text-muted">
                        策略默认（{profileDisplayName(strategyDefinition?.roleProfiles[role] || config.roles[role]!.defaultProfile)}）
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

function BindingSelect({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

function formatDuration(seconds: number): string {
  return seconds % 3_600 === 0 ? `单段 ${seconds / 3_600}h` : `单段 ${Math.round(seconds / 60)}m`;
}
