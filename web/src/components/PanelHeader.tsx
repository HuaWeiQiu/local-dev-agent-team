import type { ReactNode } from "react";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";

interface PanelHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  /** Buttons or badges aligned to the end of the header. */
  actions?: ReactNode;
}

/** Shared header for settings-style panels: icon, title with muted subtitle, trailing actions. */
export function PanelHeader({ icon, title, subtitle, actions }: PanelHeaderProps) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-base font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle ? <small className="mt-0.5 block text-xs leading-relaxed text-muted">{subtitle}</small> : null}
      </div>
      {actions}
    </div>
  );
}

export function SettingsSection({ className, children, ...props }: { className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <Card className={cn("flex flex-col gap-4 p-5", className)} {...(props["aria-label"] ? { role: "region" } : {})} {...props}>
      {children}
    </Card>
  );
}
