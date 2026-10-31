import type { ReactNode } from "react";
import { cn } from "../ui/cn";

/** First paint: waiting for the workspace, or reporting why it failed. */
export function AppLoadingShell({ error }: { error: string | undefined }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="size-9 rounded-xl motion-safe:animate-pulse"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        />
        <strong className="text-base font-semibold tracking-tight text-ink">Agent Team</strong>
        <span className="max-w-sm text-sm text-muted" role="status">
          {error ?? "连接控制服务…"}
        </span>
      </div>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="flex items-center justify-center gap-2 bg-info-soft px-3 py-1 text-xs text-info-ink">
      正在查看内置演示数据，所有操作只发生在浏览器内存里。
      <a className="font-medium underline" href={`${window.location.pathname}`}>
        退出演示
      </a>
    </div>
  );
}

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss(): void;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "bd fixed bottom-4 right-4 z-[70] flex max-w-md items-start gap-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-ink shadow-pop motion-safe:animate-[rise-in_160ms_ease-out]",
      )}
    >
      <span className="flex-1 leading-snug">{message}</span>
      <button
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-base leading-none text-danger-ink"
        onClick={onDismiss}
        aria-label="关闭错误"
      >
        ×
      </button>
    </div>
  );
}

export function LoadingPane() {
  return (
    <div className="grid h-full place-items-center text-sm text-muted" role="status" aria-live="polite">
      正在加载…
    </div>
  );
}

export type { ReactNode };
