import { Check, GitBranch, ShieldCheck } from "lucide-react";
import type { DetectedCommand, OnboardingStatus } from "../../types";
import { Button } from "../../ui/button";
import { Callout, Field, Input } from "../../ui/form";
import { formatCommand } from "./commands";
import { cliLabel, roleLabel } from "./labels";

type DetectedCli = OnboardingStatus["clis"][number];

/** The repository line: name, branch and ecosystems, whichever of them exist. */
export function RepoPanel({
  projectName,
  detection,
}: {
  projectName: string;
  detection: OnboardingStatus["detection"];
}) {
  return (
    <section aria-label="仓库" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
      <strong className="text-ink">{projectName}</strong>
      {detection.defaultBranch && (
        <span className="inline-flex items-center gap-1 text-muted"><GitBranch className="size-3.5" />{detection.defaultBranch}</span>
      )}
      {detection.ecosystems.length > 0 && (
        <span className="text-muted">{detection.ecosystems.join(" / ")}</span>
      )}
    </section>
  );
}

/** The chips that qualify one CLI: its version, why it may not run, and whether it is the default. */
function CliFlags({ cli, isRecommended }: { cli: DetectedCli; isRecommended: boolean }) {
  return (
    <>
      {cli.version && <span className="text-muted">{cli.version}</span>}
      {!cli.runtimeSupported && <span className="text-warning-ink">不可调用</span>}
      {cli.authStatus === "missing" && <span className="text-warning-ink">未登录</span>}
      {isRecommended && <span className="text-accent">默认使用</span>}
    </>
  );
}

/** One installed CLI. */
function CliBadge({ cli, isRecommended }: { cli: DetectedCli; isRecommended: boolean }) {
  return (
    <li className="bd flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-xs text-ink-2">
      <strong>{cliLabel(cli.id)}</strong>
      <CliFlags cli={cli} isRecommended={isRecommended} />
    </li>
  );
}

/** The installed CLIs, or the warning that none of them can be called. */
export function CliPanel({
  clis,
  recommendedCli,
}: {
  clis: OnboardingStatus["clis"];
  recommendedCli: string | undefined;
}) {
  const installed = clis.filter((cli) => cli.installed);
  return (
    <section aria-label="已检测到的 CLI" className="flex flex-col gap-2">
      <h3 className="m-0 text-xs font-medium text-ink-2">已检测到的 Agent CLI</h3>
      {installed.length === 0 ? (
        <Callout tone="warning">
          未检测到可用的 Codex / Claude / Kimi / Grok CLI。安装并登录其中任意一个后即可启动运行。
        </Callout>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {installed.map((cli) => (
            <CliBadge key={cli.id} cli={cli} isRecommended={recommendedCli === cli.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One detected quality command and its checkbox. */
function CommandRow({
  entry,
  checked,
  onToggle,
}: {
  entry: DetectedCommand;
  checked: boolean;
  onToggle(): void;
}) {
  return (
    <li>
      <label className="bd flex cursor-pointer items-start gap-2.5 rounded-lg bg-surface p-2.5 text-sm hover:bg-surface-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          onChange={onToggle}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <strong className="text-ink">{roleLabel(entry.role)}</strong>
            <code className="truncate text-xs text-ink-2">{formatCommand(entry.command)}</code>
          </span>
          <span className="text-xs text-muted">来自 {entry.source}</span>
        </span>
      </label>
    </li>
  );
}

/** The quality gate: the detected commands, plus the free-form extra line. */
export function CommandPanel({
  detection,
  picked,
  onToggle,
  custom,
  onCustomChange,
}: {
  detection: OnboardingStatus["detection"];
  picked: Set<number>;
  onToggle(index: number): void;
  custom: string;
  onCustomChange(value: string): void;
}) {
  return (
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
          <CommandRow
            key={`${entry.role}:${formatCommand(entry.command)}`}
            entry={entry}
            checked={picked.has(index)}
            onToggle={() => onToggle(index)}
          />
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
          onChange={(event) => onCustomChange(event.target.value)}
          placeholder="例如：make verify"
          spellCheck={false}
        />
      </Field>
    </section>
  );
}

/** The two ways out: keep the detected defaults, or write them to the yaml. */
export function WizardFooter({
  busy,
  onSkip,
  onSubmit,
}: {
  busy: boolean;
  onSkip(): void;
  onSubmit(): void;
}) {
  return (
    <>
      <Button onClick={onSkip} disabled={busy}>先用默认值</Button>
      <Button variant="primary" onClick={onSubmit} disabled={busy}>
        <Check />
        {busy ? "正在保存" : "保存到 agent-team.yaml"}
      </Button>
    </>
  );
}
