import type { ReactNode } from "react";
import { cn } from "../../ui/cn";

export function DrawerPanel({
  side,
  open,
  compact,
  label,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  compact: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "bd absolute z-20 flex min-h-0 flex-col overflow-hidden bg-surface shadow-modal transition-[transform,opacity,visibility] duration-200 ease-out motion-reduce:transition-none",
        compact
          ? "inset-x-2 inset-y-2 rounded-xl"
          : cn("inset-y-3 rounded-xl", side === "left" ? "left-3 w-72" : "right-3 w-[360px]"),
        open
          ? "visible translate-x-0 translate-y-0 opacity-100"
          : cn(
              "pointer-events-none invisible opacity-0",
              compact ? "translate-y-[110%]" : side === "left" ? "-translate-x-[calc(100%+24px)]" : "translate-x-[calc(100%+24px)]",
            ),
      )}
    >
      {children}
    </aside>
  );
}

export function DrawerHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="bd-b flex shrink-0 items-center gap-3 px-4 py-3">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-base font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle ? <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
    </header>
  );
}
