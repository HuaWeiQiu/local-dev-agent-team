import type { ReactNode } from "react";
import { cn } from "../ui/cn";

interface EmptyStateProps {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  /** `block` fills its container; `inline` is a compact line inside a list. */
  size?: "block" | "inline";
  role?: "status";
}

/** Single empty/loading/placeholder pattern: optional icon, sentence title, muted hint, optional action. */
export function EmptyState({ title, hint, icon, action, size = "block", role }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-1.5 text-center text-muted",
        size === "block" ? "min-h-56 w-full flex-1 p-6" : "px-4 py-8",
      )}
      {...(role ? { role, "aria-live": "polite" as const } : {})}
    >
      {icon && (
        <span aria-hidden="true" className="mb-1 grid size-11 place-items-center rounded-full bg-surface-3 text-muted [&_svg]:size-5">
          {icon}
        </span>
      )}
      <strong className="text-sm font-medium text-ink-2">{title}</strong>
      {hint && <span className="max-w-sm text-xs leading-relaxed">{hint}</span>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
