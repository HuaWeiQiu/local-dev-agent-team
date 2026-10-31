import { ChevronLeft, Menu } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

interface TopBarProps {
  title: string;
  hint?: string;
  onBack?: () => void;
  backLabel?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  navOpen: boolean;
  onOpenNav(): void;
}

export function TopBar({ title, hint, onBack, backLabel = "返回看板", leading, actions, navOpen, onOpenNav }: TopBarProps) {
  return (
    <header className="bd-b sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 bg-surface px-3 md:px-5">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航" aria-expanded={navOpen} onClick={onOpenNav}>
        <Menu />
      </Button>
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} aria-label={backLabel} className="-ml-1 gap-0.5 pl-1.5 text-muted">
          <ChevronLeft />
          <span className="hidden sm:inline">看板</span>
        </Button>
      )}
      <div className="flex min-w-0 items-baseline gap-2.5">
        {leading}
        <h1 className="m-0 truncate text-base font-semibold tracking-tight text-ink">{title}</h1>
        {hint && <span className="hidden truncate text-xs text-muted lg:inline">{hint}</span>}
      </div>
      <div className="top-actions ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
    </header>
  );
}
