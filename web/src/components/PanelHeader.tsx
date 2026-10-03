import type { ReactNode } from "react";

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
    <div className="settings-panel-head">
      {icon}
      <div>
        <h2>{title}</h2>
        {subtitle && <small>{subtitle}</small>}
      </div>
      {actions}
    </div>
  );
}
