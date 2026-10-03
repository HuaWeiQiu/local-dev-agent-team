import { useCallback, useEffect, useState } from "react";
import { getOnboarding, saveOnboardingQuality } from "../api";
import { runActionErrorMessage } from "../presentation";
import type { OnboardingStatus, ProjectScope } from "../types";

const DISMISS_PREFIX = "agent-team:onboarding-dismissed:";

function dismissKey(scope: ProjectScope): string {
  return `${DISMISS_PREFIX}${scope.mode}:${scope.projectId}`;
}

function readDismissed(scope: ProjectScope): boolean {
  try {
    return window.localStorage.getItem(dismissKey(scope)) === "1";
  } catch {
    return false;
  }
}

/**
 * 首次运行向导的数据与状态：项目仍在使用内存默认值（无 agent-team.yaml）
 * 或没有任何质量命令时自动弹出；「先用默认值」按项目记住，不写文件。
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
        setOpen(next.needsSetup && !readDismissed(scope));
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
    if (scope) {
      try {
        window.localStorage.setItem(dismissKey(scope), "1");
      } catch {
        // 无法持久化时，本次会话内关闭即可。
      }
    }
    setOpen(false);
    setError(undefined);
  }, [scope]);

  const save = useCallback(
    async (commands: Array<{ command: string; args: string[] }>): Promise<boolean> => {
      if (!scope) return false;
      setBusy(true);
      setError(undefined);
      try {
        setStatus(await saveOnboardingQuality(scope, commands));
        setOpen(false);
        return true;
      } catch (requestError) {
        setError(runActionErrorMessage(requestError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [scope],
  );

  const reopen = useCallback(() => {
    setError(undefined);
    setOpen(true);
  }, []);

  return { status, open, busy, error, skip, save, reopen };
}
