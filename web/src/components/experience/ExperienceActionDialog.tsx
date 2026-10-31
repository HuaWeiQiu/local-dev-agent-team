import { Sparkles } from "lucide-react";
import type { FormEvent } from "react";
import { formatTimestamp } from "../../presentation";
import { Button } from "../../ui/button";
import { Callout, Field, Input, Textarea } from "../../ui/form";
import { Modal } from "../../ui/dialog";
import { Toggle } from "../../ui/toggle";
import { actionDescriptions, actionTitles, type ActionMode, type LatestEvaluation } from "./model";

const FORM_ID = "experience-action-form";

interface ExperienceActionDialogProps {
  mode: ActionMode | undefined;
  busy: boolean;
  reason: string;
  suiteDigest: string;
  forceWithoutSuite: boolean;
  requireSuite: boolean;
  latestEvaluation: LatestEvaluation | undefined;
  error: string | undefined;
  onReasonChange(value: string): void;
  onSuiteDigestChange(value: string): void;
  onForceChange(value: boolean): void;
  onUseLatestEvaluation(evaluation: LatestEvaluation): void;
  onClose(): void;
  onSubmit(): void;
}

export function ExperienceActionDialog({
  mode,
  busy,
  reason,
  suiteDigest,
  forceWithoutSuite,
  requireSuite,
  latestEvaluation,
  error,
  onReasonChange,
  onSuiteDigestChange,
  onForceChange,
  onUseLatestEvaluation,
  onClose,
  onSubmit,
}: ExperienceActionDialogProps) {
  const destructive = mode === "reject" || mode === "retire";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Modal
      open={mode !== undefined}
      onOpenChange={(next) => !next && !busy && onClose()}
      title={mode ? actionTitles[mode] : ""}
      {...(mode ? { description: actionDescriptions[mode] } : {})}
      locked={busy}
      className="w-[min(480px,calc(100vw-32px))]"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant={destructive ? "danger" : "primary"}
            disabled={busy || !reason.trim()}
          >
            {busy ? "提交中…" : "确认"}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4">
        <Field label="原因" htmlFor="experience-action-reason">
          <Textarea
            id="experience-action-reason"
            data-autofocus
            value={reason}
            disabled={busy}
            rows={3}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder="简短说明"
          />
        </Field>

        {mode === "promote" && (
          <div className="flex flex-col gap-3">
            <Field
              label={`评测 suiteDigest${requireSuite ? "（推荐/必填）" : "（可选）"}`}
              htmlFor="experience-action-suite"
            >
              <Input
                id="experience-action-suite"
                value={suiteDigest}
                disabled={busy}
                onChange={(event) => onSuiteDigestChange(event.target.value)}
                placeholder="64 位 hex，来自 EvaluationSuite"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            {latestEvaluation && (
              <Button
                disabled={busy}
                onClick={() => onUseLatestEvaluation(latestEvaluation)}
                className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs"
              >
                <Sparkles />
                <span className="min-w-0">
                  使用最近评测：{latestEvaluation.suiteName} · {formatTimestamp(latestEvaluation.completedAt)}
                </span>
              </Button>
            )}
            {requireSuite && (
              <Toggle
                label="无评测，强制晋升"
                checked={forceWithoutSuite}
                disabled={busy}
                onChange={(event) => onForceChange(event.target.checked)}
                className="-mx-1"
              />
            )}
          </div>
        )}

        {mode === "retire" && (
          <Callout tone="warning">
            退役后保留在目录中供审计，但不再注入规划或返工上下文；当前审计模型不支持恢复。
          </Callout>
        )}

        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </form>
    </Modal>
  );
}
