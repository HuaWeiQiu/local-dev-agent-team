import { Check, GitBranch, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { OnboardingStatus } from "../types";
import { Button } from "../ui/button";
import { Modal } from "../ui/dialog";
import { Callout, Field, Input } from "../ui/form";

type CommandSpec = { command: string; args: string[] };

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

const ROLE_LABEL: Record<string, string> = {
  typecheck: "类型检查",
  lint: "Lint",
  test: "测试",
  build: "构建",
};

const CLI_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  kimi: "Kimi",
  grok: "Grok",
};

export function formatCommand(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

/** 空白切分；不解析引号，也永远不会交给 shell 执行。 */
export function parseCommandLine(text: string): CommandSpec | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = parts;
  return command ? { command, args } : undefined;
}

/** 首次运行向导：展示检测到的 CLI 与质量命令，用户确认后才写 agent-team.yaml。 */
export function OnboardingWizard({ open, status, busy, error, onSave, onSkip }: OnboardingWizardProps) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!open || !status) return;
    const configured = new Set(status.current.commands.map(formatCommand));
    const useCurrent = status.source === "file" && configured.size > 0;
    setPicked(
      new Set(
        status.detection.commands.flatMap((entry, index) =>
          (useCurrent ? configured.has(formatCommand(entry.command)) : entry.selected) ? [index] : [],
        ),
      ),
    );
    setCustom("");
  }, [open, status]);

  if (!status) return null;
  const { detection } = status;
  const installed = status.clis.filter((cli) => cli.installed);
  const extra = parseCommandLine(custom);
  const toggle = (index: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const submit = () => {
    const commands = [
      ...detection.commands.filter((_, index) => picked.has(index)).map((entry) => entry.command),
      ...(extra ? [extra] : []),
    ];
    void onSave(commands);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onSkip()}
      title="开始使用 Agent 团队"
      description="已根据本机 CLI 与仓库自动生成默认配置，无需 agent-team.yaml 即可运行。确认质量门禁后，可选择保存。"
      className="w-[min(640px,calc(100vw-32px))]"
      locked={busy}
      footer={
        <>
          <Button onClick={onSkip} disabled={busy}>先用默认值</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            <Check />
            {busy ? "正在保存" : "保存到 agent-team.yaml"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section aria-label="仓库" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
          <strong className="text-ink">{status.projectName}</strong>
          {detection.defaultBranch && (
            <span className="inline-flex items-center gap-1 text-muted"><GitBranch className="size-3.5" />{detection.defaultBranch}</span>
          )}
          {detection.ecosystems.length > 0 && (
            <span className="text-muted">{detection.ecosystems.join(" / ")}</span>
          )}
        </section>

        <section aria-label="已检测到的 CLI" className="flex flex-col gap-2">
          <h3 className="m-0 text-xs font-medium text-ink-2">已检测到的 Agent CLI</h3>
          {installed.length === 0 ? (
            <Callout tone="warning">
              未检测到可用的 Codex / Claude / Kimi / Grok CLI。安装并登录其中任意一个后即可启动运行。
            </Callout>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {installed.map((cli) => (
                <li key={cli.id} className="bd flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-xs text-ink-2">
                  <strong>{CLI_LABEL[cli.id] ?? cli.id}</strong>
                  {cli.version && <span className="text-muted">{cli.version}</span>}
                  {!cli.runtimeSupported && <span className="text-warning-ink">不可调用</span>}
                  {cli.authStatus === "missing" && <span className="text-warning-ink">未登录</span>}
                  {status.recommendedCli === cli.id && <span className="text-accent">默认使用</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="质量命令" className="flex flex-col gap-2">
          <h3 className="m-0 inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <ShieldCheck className="size-3.5" />
            质量门禁（确定性命令，失败会否决 LLM 的通过判断）
          </h3>
          {detection.commands.length === 0 && (
            <Callout tone="info">没有从仓库中检测到测试 / Lint 命令，可在下方手动添加。</Callout>
          )}
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {detection.commands.map((entry, index) => (
              <li key={`${entry.role}:${formatCommand(entry.command)}`}>
                <label className="bd flex cursor-pointer items-start gap-2.5 rounded-lg bg-surface p-2.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.has(index)}
                    onChange={() => toggle(index)}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <strong className="text-ink">{ROLE_LABEL[entry.role] ?? entry.role}</strong>
                      <code className="truncate text-xs text-ink-2">{formatCommand(entry.command)}</code>
                    </span>
                    <span className="text-xs text-muted">来自 {entry.source}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <Field
            label="额外命令"
            htmlFor="onboarding-custom"
            hint="以空格分隔参数，直接执行，不经过 shell。"
          >
            <Input
              id="onboarding-custom"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="例如：make verify"
              spellCheck={false}
            />
          </Field>
        </section>

        <p className="m-0 text-xs leading-relaxed text-muted">
          选择「先用默认值」不会写入任何文件；保存后会在仓库根目录生成 <code>agent-team.yaml</code>，之后可直接编辑它以获得完整的高级配置。
        </p>
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </div>
    </Modal>
  );
}
