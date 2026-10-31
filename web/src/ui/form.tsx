import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "bd w-full rounded-md bg-surface text-sm text-ink placeholder:text-muted/70 transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:border-accent focus:outline-none focus-visible:outline-none! focus:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-55";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-9 px-3", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 resize-y px-3 py-2 leading-relaxed", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <span className="relative block">
      <select ref={ref} className={cn(control, "h-8 cursor-pointer appearance-none pl-2.5 pr-7 text-xs", className)} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
    </span>
  );
});

export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">{label}</label>
      {children}
      {hint ? <p className="m-0 text-xs leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}

const alertTones = {
  danger: "bg-danger-soft text-danger-ink",
  warning: "bg-warning-soft text-warning-ink",
  info: "bg-info-soft text-info-ink",
  success: "bg-success-soft text-success-ink",
} as const;

export function Callout({ tone = "info", role, children, className }: { tone?: keyof typeof alertTones; role?: "alert" | "status"; children: ReactNode; className?: string }) {
  const Icon = tone === "danger" || tone === "warning" ? AlertTriangle : Info;
  return (
    <div role={role} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed", alertTones[tone], className)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
