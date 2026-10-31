import { useMemo, useState, type ReactNode } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { ProjectScope } from "../types";
import { Callout } from "../ui/form";
import { ExperienceActionDialog } from "./experience/ExperienceActionDialog";
import { ExperienceDetail, ExperienceEmpty } from "./experience/ExperienceDetail";
import { ExperienceInspector } from "./experience/ExperienceInspector";
import { ExperienceList } from "./experience/ExperienceList";
import type { ExperienceFilter } from "./experience/model";
import {
  useExperienceActions,
  useExperienceData,
  useExperiencePreview,
  useLatestEvaluation,
} from "./experience/workbench/hooks";
import { filterEntries, keepSelection, selectedEntry } from "./experience/workbench/model";
import {
  InspectorAside,
  WorkbenchFailure,
  WorkbenchHeader,
  WorkbenchLoading,
} from "./experience/workbench/sections";

interface ExperienceWorkbenchProps {
  scope: ProjectScope;
}

export function ExperienceWorkbench({ scope }: ExperienceWorkbenchProps) {
  const data = useExperienceData(scope);
  const preview = useExperiencePreview(scope);
  const evaluation = useLatestEvaluation(scope);
  const wide = useMediaQuery("(min-width: 1280px)");
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<ExperienceFilter>("all");
  const [query, setQuery] = useState("");

  const entries = useMemo(
    () => filterEntries(data.snapshot, filter, query),
    [data.snapshot, filter, query],
  );
  const actions = useExperienceActions({
    scope,
    requireSuite: Boolean(data.snapshot?.requireSuiteForPromote),
    onDone: async () => {
      await data.refresh();
    },
  });

  if (!data.snapshot) {
    return <ExperienceUnavailable data={data} />;
  }

  const snapshot = data.snapshot;
  const activeId = keepSelection(snapshot.entries, selectedId);
  const selected = selectedEntry(snapshot, activeId);
  const busy = data.busy || actions.busy;
  const inspector = (
    <ExperienceInspector
      previewQuery={preview.query}
      previewResult={preview.result}
      previewLoading={preview.loading}
      busy={busy}
      projectPath={snapshot.projectPath}
      sharedPath={snapshot.sharedPath}
      onPreviewQueryChange={preview.setQuery}
    />
  );

  return (
    <section aria-label="经验工作台" className="flex h-full min-h-0 flex-col bg-background">
      <WorkbenchHeader
        snapshot={snapshot}
        loading={data.loading}
        busy={busy}
        onRefresh={() => void data.refresh()}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden xl:grid-cols-[300px_minmax(0,1fr)_280px]">
        <ExperienceList
          entries={entries}
          total={snapshot.entries.length}
          selectedId={selected?.id}
          query={query}
          filter={filter}
          busy={busy}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onSelect={setSelectedId}
          onResetFilters={() => {
            setQuery("");
            setFilter("all");
          }}
        />
        <div className="scroll-thin min-h-0 min-w-0 md:overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 md:p-6">
            <DetailBody
              selected={selected}
              busy={busy}
              {...detailActions(actions, evaluation, selected?.id)}
            />
            {data.error && <Callout tone="danger" role="alert">{data.error}</Callout>}
            {!wide && <InspectorAside wide={false}>{inspector}</InspectorAside>}
          </div>
        </div>
        {wide && <InspectorAside wide>{inspector}</InspectorAside>}
      </div>
      <ExperienceDialog
        actions={actions}
        latestEvaluation={evaluation.latest}
        requireSuite={Boolean(snapshot.requireSuiteForPromote)}
      />
    </section>
  );
}

function ExperienceDialog({
  actions,
  latestEvaluation,
  requireSuite,
}: {
  actions: ReturnType<typeof useExperienceActions>;
  latestEvaluation: ReturnType<typeof useLatestEvaluation>["latest"];
  requireSuite: boolean;
}) {
  return (
    <ExperienceActionDialog
      mode={actions.action?.mode}
      busy={actions.busy}
      reason={actions.reason}
      suiteDigest={actions.suiteDigest}
      forceWithoutSuite={actions.forceWithoutSuite}
      requireSuite={requireSuite}
      latestEvaluation={latestEvaluation}
      error={actions.dialogError}
      onReasonChange={actions.setReason}
      onSuiteDigestChange={actions.setSuiteDigest}
      onForceChange={actions.setForceWithoutSuite}
      onUseLatestEvaluation={(latest) => {
        actions.setSuiteDigest(latest.suiteDigest);
        actions.setForceWithoutSuite(false);
        actions.setDialogError(undefined);
      }}
      onClose={actions.close}
      onSubmit={() => void actions.submit()}
    />
  );
}

/** Entry actions, bound to the currently selected experience. */
function detailActions(
  actions: ReturnType<typeof useExperienceActions>,
  evaluation: ReturnType<typeof useLatestEvaluation>,
  experienceId: string | undefined,
): {
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
} {
  const open = (mode: "promote" | "reject" | "share" | "retire", reason: string): void => {
    if (experienceId) actions.open(mode, experienceId, reason);
  };
  return {
    onPromote: () => {
      open("promote", "确认可作为已验证经验");
      void evaluation.load();
    },
    onReject: () => open("reject", ""),
    onShare: () => open("share", "跨项目可复用"),
    onRetire: () => open("retire", "不再适用于后续规划"),
  };
}

function ExperienceUnavailable({ data }: { data: ReturnType<typeof useExperienceData> }) {
  if (data.loading) {
    return (
      <section aria-label="经验工作台">
        <WorkbenchLoading />
      </section>
    );
  }
  return (
    <section aria-label="经验工作台">
      <WorkbenchFailure error={data.error} onRetry={() => void data.refresh()} />
    </section>
  );
}

function DetailBody({
  selected,
  busy,
  onPromote,
  onReject,
  onShare,
  onRetire,
}: {
  selected: ReturnType<typeof selectedEntry>;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
}): ReactNode {
  if (!selected) return <ExperienceEmpty />;
  return (
    <ExperienceDetail
      entry={selected}
      busy={busy}
      onPromote={onPromote}
      onReject={onReject}
      onShare={onShare}
      onRetire={onRetire}
    />
  );
}
