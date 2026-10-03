import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

/** Labelled checkbox rendered as a switch. The native input stays in the DOM so it keeps checkbox semantics. */
export function Toggle({
  label,
  hint,
  className,
  ...props
}: { label: ReactNode; hint?: ReactNode; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return (
    <label
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-lg px-1 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55",
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        aria-hidden
        className="relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full bg-line-strong transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3.5 after:rounded-full after:bg-surface after:shadow-card after:transition-transform peer-checked:bg-accent peer-checked:after:translate-x-3.5 peer-focus-visible:shadow-[var(--focus-ring)]"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-sm font-medium text-ink">{label}</strong>
        {hint ? <small className="text-xs leading-relaxed text-muted">{hint}</small> : null}
      </span>
    </label>
  );
}
