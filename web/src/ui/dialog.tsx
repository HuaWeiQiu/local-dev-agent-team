import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface ModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Centered modal on a blurred scrim. The title doubles as the accessible name (e2e selects it by heading). */
export function Modal({ open, onOpenChange, title, description, children, footer, className }: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
        <DialogPrimitive.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "bd fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,820px)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-surface shadow-modal outline-none data-[state=open]:animate-[pop-in_160ms_cubic-bezier(0.2,0.8,0.2,1)]",
            className,
          )}
        >
          <header className="bd-b flex items-start gap-3 px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title asChild>
                <h2 className="m-0 text-base font-semibold tracking-tight text-ink">{title}</h2>
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              aria-label="关闭"
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-ink focus-ring"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <footer className="bd-t flex items-center justify-end gap-2 px-5 py-3">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
