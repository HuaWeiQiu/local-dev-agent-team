import { useEffect, useMemo, useState } from "react";
import { runCommand } from "./desktop/launcher/commands";
import { initialStatus, launcherChecks, previewStatus } from "./desktop/launcher/model";
import {
  ChecksList,
  LauncherActions,
  LauncherFooter,
  LauncherHeader,
  LauncherHero,
  ProjectDock,
  TechnicalDetails,
} from "./desktop/launcher/sections";
import type { DesktopState, DesktopStatus } from "./desktop/launcher/types";
import { useLauncherActions } from "./desktop/launcher/useLauncherActions";
import { applyTheme, getInitialTheme } from "./theme";
import { errorMessage } from "./presentation";

export type { DesktopProjectEntry, DesktopState, DesktopStatus } from "./desktop/launcher/types";

interface DesktopLauncherProps {
  previewState?: DesktopState;
}

export default function DesktopLauncher({ previewState }: DesktopLauncherProps) {
  const [status, setStatus] = useState<DesktopStatus>(
    previewState ? previewStatus(previewState) : initialStatus,
  );
  const [busy, setBusy] = useState(!previewState);
  const ports = { setStatus, setBusy };
  const actions = useLauncherActions({ previewState, ports });
  const checks = useMemo(() => launcherChecks(status), [status]);

  useEffect(() => {
    applyTheme(getInitialTheme());
  }, []);

  useEffect(() => {
    if (previewState) return;
    void runCommand("desktop_boot", ports);
    // Boot once per mount: the ports are recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewState]);

  return (
    <div className="desktop-launcher">
      <LauncherHeader />
      <main className="launcher-main">
        <section className="launcher-content" aria-live="polite">
          <LauncherHero status={status} />
          <DesktopProjectDock status={status} busy={busy} actions={actions} />
          <LauncherActions
            status={status}
            busy={busy}
            onChoose={() => void safely(actions.chooseProject, setStatus, setBusy)}
            onInitialize={() => void actions.initialize()}
            onRetry={() => void actions.retry()}
          />
          <ChecksList checks={checks} />
          {status.technicalDetail && <TechnicalDetails detail={status.technicalDetail} />}
        </section>
      </main>
      <LauncherFooter />
    </div>
  );
}

function DesktopProjectDock({
  status,
  busy,
  actions,
}: {
  status: DesktopStatus;
  busy: boolean;
  actions: ReturnType<typeof useLauncherActions>;
}) {
  return (
    <ProjectDock
      status={status}
      busy={busy}
      onOpen={(path) => void actions.openProject(path)}
      onRelease={(project) => void actions.releaseLease(project)}
      onRemove={(project) => void actions.removeProject(project)}
    />
  );
}

/** A failed folder picker must not leave the launcher stuck on "busy". */
async function safely(
  action: () => Promise<void>,
  setStatus: (status: DesktopStatus) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    setBusy(false);
    setStatus({ state: "error", message: "无法选择这个项目", technicalDetail: errorMessage(error) });
  }
}
