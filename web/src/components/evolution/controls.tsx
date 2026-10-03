import { forwardRef } from "react";
import { Button, type ButtonProps } from "../../ui/button";
import { cn } from "../../ui/cn";

/** Kit button for a tree without preflight: non-bordered variants must drop the UA button border. */
export const ActionButton = forwardRef<HTMLButtonElement, ButtonProps>(function ActionButton(
  { variant, className, ...props },
  ref,
) {
  const flat = variant !== undefined && variant !== null && variant !== "secondary";
  return <Button ref={ref} variant={variant} className={cn(flat && "border-0", className)} {...props} />;
});

export function Kicker({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("block text-2xs font-semibold uppercase leading-none tracking-wider text-muted", className)}>
      {children}
    </span>
  );
}
