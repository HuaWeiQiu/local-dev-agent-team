import { Play } from "lucide-react";
import type { PublicConfig, ProjectScope, RoleBindingInput, StartRunInput } from "../types";
import { Button } from "../ui/button";
import { Callout } from "../ui/form";
import { Modal } from "../ui/dialog";
import {
  AdvancedToggle,
  GoalField,
  RoleBindingGrid,
  StrategyPicker,
  TemplateField,
} from "./run-launcher/sections";
import { useRunLauncher } from "./run-launcher/useRunLauncher";

interface RunLauncherProps {
  open: boolean;
  config: PublicConfig;
  /** 有 scope 时目标输入区展示经验注入预览 */
  scope: ProjectScope | undefined;
  initialStrategy: string | undefined;
  initialGoal: string | undefined;
  busy: boolean;
  error: string | undefined;
  /** Global defaults + inventory for CLI picker */
  roleDefaults: Record<string, RoleBindingInput> | undefined;
  inventory: import("../types").CliInventory | undefined;
  /** 「设置」中的新建运行选型开关；关闭时角色区只读展示当前绑定 */
  showCliPicker?: boolean;
  onClose(): void;
  /** 返回是否启动成功；失败时保留目标文本与弹窗 */
  onSubmit(input: StartRunInput): Promise<boolean>;
}

const formId = "run-launcher-form";

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
  const model = useRunLauncher({
    open,
    config,
    scope,
    initialStrategy,
    initialGoal,
    busy,
    roleDefaults,
    inventory,
    showCliPicker,
    onSubmit,
  });

  if (!open) return null;

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
          <Button type="submit" form={formId} variant="primary" disabled={!model.canSubmit}>
            <Play fill="currentColor" />
            {busy ? "正在启动" : "启动运行"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void model.submit(event)} className="flex flex-col gap-5">
        <GoalField
          goal={model.goal}
          onGoalChange={model.setGoal}
          deliverables={model.deliverables}
          experienceItems={model.experienceItems}
        />
        <StrategyPicker config={config} strategy={model.strategy} onSelect={model.setStrategy} />
        <TemplateField template={model.template} onChange={model.setTemplate} />

        <div className="flex flex-col gap-3">
          <AdvancedToggle expanded={model.advanced} onToggle={model.toggleAdvanced} />
          {model.advanced && (
            <RoleBindingGrid
              roles={model.roles}
              config={config}
              bindings={model.bindings}
              fallback={model.fallback}
              inventory={model.inventory}
              strategyDefinition={model.strategyDefinition}
              useCliPicker={model.useCliPicker}
              showCliPicker={showCliPicker}
              onChange={model.updateBinding}
            />
          )}
        </div>
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
      </form>
    </Modal>
  );
}
