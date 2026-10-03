import type { ReactNode } from "react";

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
    <div className={`empty-state is-${size}`} {...(role ? { role, "aria-live": "polite" as const } : {})}>
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <strong>{title}</strong>
      {hint && <span className="empty-state-hint">{hint}</span>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
