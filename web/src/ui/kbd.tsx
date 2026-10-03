import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "bd inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-surface-2 px-1 font-sans text-2xs font-medium text-muted",
        className,
      )}
      {...props}
    />
  );
}
