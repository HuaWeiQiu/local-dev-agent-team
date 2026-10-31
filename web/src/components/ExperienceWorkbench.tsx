import { BookMarked, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getEvolution,
  getExperience,
  promoteExperience,
  rejectExperience,
  retireExperience,
  retrieveExperience,
  shareExperience,
} from "../api";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { errorMessage } from "../presentation";
import type { ExperiencePlanningBundle, ExperienceSnapshot, ProjectScope } from "../types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Callout } from "../ui/form";
import { Tooltip } from "../ui/tooltip";
import { ExperienceActionDialog } from "./experience/ExperienceActionDialog";
import { ExperienceDetail, ExperienceEmpty } from "./experience/ExperienceDetail";
import { ExperienceInspector } from "./experience/ExperienceInspector";
import { ExperienceList } from "./experience/ExperienceList";
import type { ActionMode, ExperienceFilter, LatestEvaluation } from "./experience/model";

interface ExperienceWorkbenchProps {
  scope: ProjectScope;
}

export function ExperienceWorkbench({ scope }: ExperienceWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<ExperienceSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<ExperienceFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<{ mode: ActionMode; experienceId: string }>();
  const [reason, setReason] = useState("");
  const [suiteDigest, setSuiteDigest] = useState("");
  const [forceWithoutSuite, setForceWithoutSuite] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [latestEvaluation, setLatestEvaluation] = useState<LatestEvaluation>();
  const [previewQuery, setPreviewQuery] = useState("");
  const [previewResult, setPreviewResult] = useState<ExperiencePlanningBundle>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const wide = useMediaQuery("(min-width: 1280px)");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getExperience(scope);
      setSnapshot(next);
      setSelectedId((current) =>
        current && next.entries.some((entry) => entry.id === current)
          ? current
          : next.entries[0]?.id,
      );
      setError(undefined);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setSnapshot(undefined);
    setSelectedId(undefined);
    setAction(undefined);
    setError(undefined);
    setLatestEvaluation(undefined);
    void refresh();
  }, [refresh]);

  // 晋升弹窗打开时拉取最近一次评测套件身份（无评测记录时隐藏一键填入）
  const loadLatestEvaluation = useCallback(async () => {
    try {
      const evolution = await getEvolution(scope);
      setLatestEvaluation(evolution.automation.lastEvaluation ?? undefined);
    } catch {
      setLatestEvaluation(undefined);
    }
  }, [scope]);

  // 检索预览：防抖只读调用（preview=1 不计命中、不写审计）
  useEffect(() => {
    const text = previewQuery.trim();
    if (!text) {
      setPreviewResult(undefined);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      retrieveExperience(scope, text, { preview: true })
        .then((bundle) => setPreviewResult(bundle))
        .catch(() => setPreviewResult(undefined))
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [previewQuery, scope]);

  const entries = useMemo(() => {
    if (!snapshot) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return snapshot.entries.filter((entry) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "shared" && entry.scope === "shared") ||
        (filter === "project" && entry.scope === "project") ||
        entry.status === filter;
      if (!matchesFilter) return false;
      if (!normalized) return true;
      return [
        entry.summary,
        entry.conditions.join(" "),
        entry.tags.join(" "),
        entry.sourceRunId,
        entry.project,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [filter, query, snapshot]);

  const selected = snapshot?.entries.find((entry) => entry.id === selectedId);

  const submitAction = async () => {
    if (!action || !reason.trim()) {
      setDialogError("请填写原因");
      return;
    }
    if (
      action.mode === "promote" &&
      snapshot?.requireSuiteForPromote &&
      !suiteDigest.trim() &&
      !forceWithoutSuite
    ) {
      setDialogError("需要填写 suiteDigest，或勾选强制晋升");
      return;
    }
    if (action.mode === "promote" && suiteDigest.trim() && !/^[a-f0-9]{64}$/.test(suiteDigest.trim())) {
      setDialogError("suiteDigest 须为 64 位十六进制 SHA-256");
      return;
    }
    setBusy(true);
    setDialogError(undefined);
    setError(undefined);
    try {
      if (action.mode === "promote") {
        await promoteExperience(scope, action.experienceId, reason.trim(), {
          ...(suiteDigest.trim() ? { suiteDigest: suiteDigest.trim() } : {}),
          ...(forceWithoutSuite ? { forceWithoutSuite: true } : {}),
        });
      } else if (action.mode === "reject") {
        await rejectExperience(scope, action.experienceId, reason.trim());
      } else if (action.mode === "retire") {
        await retireExperience(scope, action.experienceId, reason.trim());
      } else {
        await shareExperience(scope, action.experienceId, reason.trim());
      }
      setAction(undefined);
      setReason("");
      setSuiteDigest("");
      setForceWithoutSuite(false);
      await refresh();
    } catch (requestError) {
      setDialogError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <section aria-label="经验工作台" className="grid h-full place-items-center px-6">
        {loading ? (
          <div role="status" className="flex flex-col items-center gap-3 text-sm text-muted">
            <LoaderCircle aria-hidden className="size-6 animate-spin text-accent" />
            <span>加载中…</span>
          </div>
        ) : (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <strong className="text-base font-semibold text-ink">加载失败</strong>
            <Callout tone="danger" role="alert" className="w-full text-left">{error}</Callout>
            <Button onClick={() => void refresh()}>
              <RefreshCw />
              重试
            </Button>
          </div>
        )}
      </section>
    );
  }

  const openAction = (mode: ActionMode, experienceId: string, initialReason: string) => {
    setAction({ mode, experienceId });
    setReason(initialReason);
    setDialogError(undefined);
  };

  const inspector = (
    <ExperienceInspector
      previewQuery={previewQuery}
      previewResult={previewResult}
      previewLoading={previewLoading}
      busy={busy}
      projectPath={snapshot.projectPath}
      sharedPath={snapshot.sharedPath}
      onPreviewQueryChange={setPreviewQuery}
    />
  );

  return (
    <section aria-label="经验工作台" className="flex h-full min-h-0 flex-col bg-background">
      <header className="bd-b flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-4 py-2.5">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
            <BookMarked className="size-4" />
          </span>
          <div className="min-w-0">
            <strong className="block text-sm font-semibold text-ink">经验</strong>
            <span className="block truncate text-xs text-muted">
              候选需晋升 · 已验证进规划 · 共享后跨项目
              {snapshot.enabled ? "" : " · 已关闭"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2" aria-label="经验统计" role="group">
          <Metric label="候选" value={snapshot.counts.candidate} tone="text-warning-ink" />
          <Metric label="已验证" value={snapshot.counts.verified} tone="text-success-ink" />
          <Metric label="公共" value={snapshot.counts.shared} tone="text-info-ink" />
          <Tooltip label="刷新">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refresh()}
              disabled={loading || busy}
              aria-label="刷新"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </Tooltip>
        </div>
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden xl:grid-cols-[300px_minmax(0,1fr)_280px]">
        <ExperienceList
          entries={entries}
          total={snapshot.entries.length}
          selectedId={selectedId}
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
            {selected ? (
              <ExperienceDetail
                entry={selected}
                busy={busy}
                onPromote={() => {
                  openAction("promote", selected.id, "确认可作为已验证经验");
                  setSuiteDigest("");
                  setForceWithoutSuite(false);
                  void loadLatestEvaluation();
                }}
                onReject={() => openAction("reject", selected.id, "")}
                onShare={() => openAction("share", selected.id, "跨项目可复用")}
                onRetire={() => openAction("retire", selected.id, "不再适用于后续规划")}
              />
            ) : (
              <ExperienceEmpty />
            )}
            {error && <Callout tone="danger" role="alert">{error}</Callout>}
            {!wide && <div className="bd-t pt-5">{inspector}</div>}
          </div>
        </div>

        {wide && (
          <aside className="scroll-thin bd-l min-h-0 min-w-0 overflow-y-auto bg-surface p-4">
            {inspector}
          </aside>
        )}
      </div>

      <ExperienceActionDialog
        mode={action?.mode}
        busy={busy}
        reason={reason}
        suiteDigest={suiteDigest}
        forceWithoutSuite={forceWithoutSuite}
        requireSuite={Boolean(snapshot.requireSuiteForPromote)}
        latestEvaluation={latestEvaluation}
        error={dialogError}
        onReasonChange={setReason}
        onSuiteDigestChange={setSuiteDigest}
        onForceChange={setForceWithoutSuite}
        onUseLatestEvaluation={(evaluation) => {
          setSuiteDigest(evaluation.suiteDigest);
          setForceWithoutSuite(false);
          setDialogError(undefined);
        }}
        onClose={() => setAction(undefined)}
        onSubmit={() => void submitAction()}
      />
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="bd inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-2xs text-muted">
      {label}
      <strong className={cn("text-xs font-semibold tabular-nums", tone)}>{value}</strong>
    </span>
  );
}
