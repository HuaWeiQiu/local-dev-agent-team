import { useCallback, useEffect, useState } from "react";
import { getOnboarding, saveOnboardingQuality } from "../api";
import { runActionErrorMessage } from "../presentation";
import type { OnboardingStatus, ProjectScope } from "../types";

const DISMISS_PREFIX = "agent-team:onboarding-dismissed:";

export function dismissKey(scope: ProjectScope): string {
  return `${DISMISS_PREFIX}${scope.mode}:${scope.projectId}`;
}

/** A browser that refuses storage simply never remembers the dismissal. */
export function readDismissed(scope: ProjectScope): boolean {
  try {
    return window.localStorage.getItem(dismissKey(scope)) === "1";
  } catch {
    return false;
  }
}

export function markDismissed(scope: ProjectScope): void {
  try {
    window.localStorage.setItem(dismissKey(scope), "1");
  } catch {
    // 无法持久化时，本次会话内关闭即可。
  }
}

/** Whether the wizard should open for a freshly loaded status. */
export function shouldOpenWizard(scope: ProjectScope | undefined, status: OnboardingStatus): boolean {
  return Boolean(scope) && status.needsSetup && !readDismissed(scope!);
}

/** Saving either yields the new status or the copy to show. */
export async function saveQuality(
  scope: ProjectScope,
  commands: Array<{ command: string; args: string[] }>,
): Promise<{ status: OnboardingStatus } | { error: string }> {
  try {
    return { status: await saveOnboardingQuality(scope, commands) };
  } catch (requestError) {
    return { error: runActionErrorMessage(requestError) };
  }
}

/**
 * 首次运行向导的数据与状态：项目仍在使用内存默认值（无 agent-team.yaml）时自动弹出；
 * 已有配置文件的项目只能从命令面板手动打开；「先用默认值」按项目记住，不写文件。
 */
export function useOnboarding(scope: ProjectScope | undefined) {
  const [status, setStatus] = useState<OnboardingStatus>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;

  useEffect(() => {
    setStatus(undefined);
    setOpen(false);
    setError(undefined);
    if (!scope) return;
    let cancelled = false;
    getOnboarding(scope)
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setOpen(shouldOpenWizard(scope, next));
      })
      .catch(() => {
        // 向导是增强功能；服务端不支持或暂不可用时静默跳过。
      });
    return () => {
      cancelled = true;
    };
    // scope 对象每次渲染可能是新引用，用 scopeKey 判定项目切换。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const skip = useCallback(() => {
    if (scope) markDismissed(scope);
    setOpen(false);
    setError(undefined);
  }, [scope]);

  const save = useCallback(
    async (commands: Array<{ command: string; args: string[] }>): Promise<boolean> => {
      if (!scope) return false;
      setBusy(true);
      setError(undefined);
      const saved = await saveQuality(scope, commands);
      if ("error" in saved) {
        setError(saved.error);
        setBusy(false);
        return false;
      }
      setStatus(saved.status);
      setOpen(false);
      setBusy(false);
      return true;
    },
    [scope],
  );

  const reopen = useCallback(() => {
    setError(undefined);
    setOpen(true);
  }, []);

  return { status, open, busy, error, skip, save, reopen };
}
