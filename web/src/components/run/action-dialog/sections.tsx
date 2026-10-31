import { Callout, Field, Input, Textarea } from "../../../ui/form";
import { completenessBarCopy } from "../../../plan-completeness";
import type { ApprovalRequest } from "../../../types";

export function ApprovalBanner({ approval }: { approval: ApprovalRequest }) {
  return (
    <div className="rounded-lg bg-warning-soft px-3 py-2.5 text-warning-ink">
      <strong className="block text-sm font-medium">{approval.summary}</strong>
      <span className="text-xs opacity-80">
        截止 {new Date(approval.expiresAt).toLocaleString("zh-CN")}
      </span>
    </div>
  );
}

export function CompletenessPanel({
  completeness,
  acknowledged,
  onAcknowledge,
}: {
  completeness: NonNullable<ReturnType<typeof import("./model").completenessOf>>;
  acknowledged: boolean;
  onAcknowledge(next: boolean): void;
}) {
  const copy = completenessBarCopy(completeness);
  const incomplete = completeness.status !== "complete";
  return (
    <Callout tone={copy.tone}>
      <strong className="block font-medium">{copy.title}</strong>
      {completeness.issues.length > 0 ? (
        <ul className="m-0 mt-1 list-disc pl-4">
          {completeness.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : (
        <span>目标编号已覆盖。</span>
      )}
      {incomplete ? (
        <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--danger)]"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          我知道计划不完整
        </label>
      ) : null}
    </Callout>
  );
}

export function IdentityFields({
  actor,
  reason,
  onActor,
  onReason,
}: {
  actor: string;
  reason: string;
  onActor(value: string): void;
  onReason(value: string): void;
}) {
  return (
    <>
      <Field label="操作者" htmlFor="action-actor">
        <Input
          id="action-actor"
          data-autofocus
          value={actor}
          onChange={(event) => onActor(event.target.value)}
          maxLength={200}
          required
        />
      </Field>
      <Field label="理由" htmlFor="action-reason">
        <Textarea
          id="action-reason"
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          rows={4}
          maxLength={2_000}
          required
        />
      </Field>
    </>
  );
}
