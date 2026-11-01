import type { OnboardingStatus } from "../types";
import { Modal } from "../ui/dialog";
import { Callout } from "../ui/form";
import { formatCommand, parseCommandLine, selectedCommands } from "./onboarding/commands";
import type { CommandSpec } from "./onboarding/commands";
import { CliPanel, CommandPanel, RepoPanel, WizardFooter } from "./onboarding/panels";
import { useCommandPicks } from "./onboarding/picks";

export { formatCommand, parseCommandLine };

interface OnboardingWizardProps {
  open: boolean;
  status: OnboardingStatus | undefined;
  busy: boolean;
  error: string | undefined;
  /** 写入 agent-team.yaml 并使用所选质量门禁 */
  onSave(commands: CommandSpec[]): Promise<boolean>;
  /** 先使用检测到的默认值，不写文件；之后不再自动弹出 */
  onSkip(): void;
}

/** 首次运行向导：展示检测到的 CLI 与质量命令，用户确认后才写 agent-team.yaml。 */
export function OnboardingWizard({ open, status, busy, error, onSave, onSkip }: OnboardingWizardProps) {
  const { picked, toggle, custom, setCustom } = useCommandPicks(open, status);

  if (!status) return null;
  const extra = parseCommandLine(custom);

  const submit = () => {
    void onSave(selectedCommands(status.detection, picked, extra));
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onSkip()}
      title="开始使用 Agent 团队"
      description="已根据本机 CLI 与仓库自动生成默认配置，无需 agent-team.yaml 即可运行。确认质量门禁后，可选择保存。"
      className="w-[min(640px,calc(100vw-32px))]"
      locked={busy}
      footer={<WizardFooter busy={busy} onSkip={onSkip} onSubmit={submit} />}
    >
      <div className="flex flex-col gap-5">
        <RepoPanel projectName={status.projectName} detection={status.detection} />
        <CliPanel clis={status.clis} recommendedCli={status.recommendedCli} />
        <CommandPanel
          detection={status.detection}
          picked={picked}
          onToggle={toggle}
          custom={custom}
          onCustomChange={setCustom}
        />

        <p className="m-0 text-xs leading-relaxed text-muted">
          选择「先用默认值」不会写入任何文件；保存后会在仓库根目录生成 <code>agent-team.yaml</code>，之后可直接编辑它以获得完整的高级配置。
        </p>
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </div>
    </Modal>
  );
}
