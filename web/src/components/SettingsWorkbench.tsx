import { LoaderCircle } from "lucide-react";
import type { ProjectScope } from "../types";
import { Callout } from "../ui/form";
import { JevPanel } from "./JevPanel";
import { SettingsSection } from "./PanelHeader";
import { RoleBindingEditor } from "./RoleBindingEditor";
import {
  CliDetectSection,
  CliInventorySection,
  RolesSectionHeader,
  SettingsHeader,
  SettingsTabs,
} from "./settings/sections";
import { useSettingsWorkbench } from "./settings/useSettingsWorkbench";

export function SettingsWorkbench({
  pane = "global",
  scope,
  projectName,
  onOpenProject,
  onOpenGlobal,
  onSaved,
}: {
  pane?: "global" | "project";
  scope?: ProjectScope;
  projectName?: string;
  onOpenProject?(): void;
  onOpenGlobal?(): void;
  onSaved?(): void;
}) {
  const model = useSettingsWorkbench({ pane, scope, onSaved });
  const isProject = pane === "project";

  if (model.loading) {
    return <SettingsLoading isProject={isProject} />;
  }

  return (
    <section
      className="scroll-thin h-full overflow-y-auto"
      aria-label={isProject ? "项目设置" : "全局设置"}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 md:px-8">
        <SettingsHeader
          isProject={isProject}
          projectName={projectName}
          scope={scope}
          scanning={model.scanning}
          saving={model.saving}
          onOpenProject={onOpenProject}
          onOpenGlobal={onOpenGlobal}
          onDetect={() => void model.rescan()}
          onSave={() => void model.save()}
        />

        <SettingsTabs
          isProject={isProject}
          scope={scope}
          onOpenProject={onOpenProject}
          onOpenGlobal={onOpenGlobal}
        />

        <SettingsSections model={model} isProject={isProject} scope={scope} />
      </div>
    </section>
  );
}

function SettingsLoading({ isProject }: { isProject: boolean }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-sm text-muted" role="status">
        <LoaderCircle className="size-6 animate-spin text-accent" />
        <strong className="font-medium text-ink-2">
          {isProject ? "正在加载项目设置" : "正在加载全局设置"}
        </strong>
      </div>
    </div>
  );
}

function CalloutOrNothing({
  error,
  message,
}: {
  error: string | undefined;
  message: string | undefined;
}) {
  const text = error ?? message;
  if (!text) return null;
  return (
    <Callout tone={error ? "danger" : "success"} role="status">
      {text}
    </Callout>
  );
}

function SettingsSections({
  model,
  isProject,
  scope,
}: {
  model: ReturnType<typeof useSettingsWorkbench>;
  isProject: boolean;
  scope: ProjectScope | undefined;
}) {
  return (
    <>
      <CalloutOrNothing error={model.error} message={model.message} />

      {!isProject && (
        <CliDetectSection
          ui={model.ui}
          saving={model.saving}
          scanning={model.scanning}
          onPatchUi={model.patchUi}
          onRescan={() => void model.rescan()}
        />
      )}

      {!isProject && (
        <CliInventorySection
          inventory={model.inventory}
          fromCache={model.fromCache}
          cacheReason={model.cacheReason}
          scanning={model.scanning}
          saving={model.saving}
          onRescan={() => void model.rescan()}
        />
      )}

      <SettingsSection>
        <RolesEditor
          model={model}
          isProject={isProject}
        />
      </SettingsSection>

      {isProject && scope && <JevPanel scope={scope} />}
    </>
  );
}

function RolesEditor({
  model,
  isProject,
}: {
  model: ReturnType<typeof useSettingsWorkbench>;
  isProject: boolean;
}) {
  return (
    <>
      <RolesSectionHeader
        isProject={isProject}
        adoptDisabled={adoptSuggestedDisabled(model)}
        onAdoptSuggested={model.adoptSuggested}
      />
      <RoleBindingEditor
        roles={isProject ? model.projectRoles : model.roles}
        roleNames={model.roleNames}
        disabled={model.saving || model.scanning}
        {...(model.inventory ? { inventory: model.inventory } : {})}
        {...(isProject ? { sources: model.projectSources, onClear: model.inheritGlobal } : {})}
        onChange={model.updateRole}
      />
    </>
  );
}

function adoptSuggestedDisabled(model: ReturnType<typeof useSettingsWorkbench>): boolean {
  if (model.saving || model.scanning) return true;
  return Object.keys(model.suggested).length === 0;
}
