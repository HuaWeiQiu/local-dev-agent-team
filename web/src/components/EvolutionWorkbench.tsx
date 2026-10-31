import { CircleAlert, GitCompareArrows, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  archiveEvolutionProposal,
  confirmEvolutionPromotion,
  confirmEvolutionRollback,
  deleteEvolutionProposal,
  evaluateEvolutionProposal,
  getEvolution,
  previewEvolutionPromotion,
  previewEvolutionRollback,
  proposeEvolutionPrompt,
  proposeEvolutionStrategy,
  reconcileEvolutionProposal,
  rejectEvolutionProposal,
  startAutomaticEvolution,
  stopAutomaticEvolution,
  unarchiveEvolutionProposal,
} from "../api";
import { evolutionLocked, utf8ToBase64, visibleEvolutionProposals, type EvolutionFilter } from "../evolution";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { EvolutionSnapshot, ProjectScope, PublicConfig } from "../types";
import { cn } from "../ui/cn";
import { Callout } from "../ui/form";
import { ActionPanel } from "./evolution/ActionPanel";
import { AutomationBar } from "./evolution/AutomationBar";
import { ActionButton, Kicker } from "./evolution/controls";
import { evolutionErrorMessage, refreshRequiredEvolutionCodes } from "./evolution/format";
import { ProposalDetail, type DetailTab } from "./evolution/ProposalDetail";
import { ProposalRail } from "./evolution/ProposalRail";
import { ScopeNote, TargetMetadata } from "./evolution/TargetNotes";
import { EvolutionDecisionDialog, type EvolutionDecision } from "./EvolutionDecisionDialog";
import { EvolutionProposalDialog, type EvolutionProposalInput } from "./EvolutionProposalDialog";

interface EvolutionWorkbenchProps {
  scope: ProjectScope;
  config: PublicConfig;
}

export function EvolutionWorkbench({ scope, config }: EvolutionWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<EvolutionSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<EvolutionFilter>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [creating, setCreating] = useState(false);
  const [decision, setDecision] = useState<EvolutionDecision>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [dialogError, setDialogError] = useState<string>();
  const [requestedCycles, setRequestedCycles] = useState(3);
  const [automationStartIntent, setAutomationStartIntent] = useState<{
    commandId: string;
    maxCycles: number;
  }>();
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const twoPane = useMediaQuery("(min-width: 801px)");
  const wide = useMediaQuery("(min-width: 1180px)");

  // 只有「已归档」视图才向服务端请求归档候选；其余视图服务端默认不含
  const includeArchived = filter === "archived";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getEvolution(scope, { includeArchived });
      setSnapshot(next);
      setSelectedId((current) => current && next.proposals.some((item) => item.id === current)
        ? current
        : window.innerWidth > 800 ? next.proposals[0]?.id : undefined);
      setError(undefined);
      return next;
    } catch (requestError) {
      setError(evolutionErrorMessage(requestError));
      throw requestError;
    } finally {
      setLoading(false);
    }
  }, [scope, includeArchived]);

  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setSelectedId(undefined);
    setDecision(undefined);
    setCreating(false);
    setError(undefined);
    setPollError(undefined);
    setAutomationStartIntent(undefined);
    setLoading(true);
    void getEvolution(scope, { includeArchived })
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setPollError(undefined);
        setRequestedCycles(Math.min(3, next.automation.configuredMaxCycles));
        setSelectedId(window.innerWidth > 800 ? next.proposals[0]?.id : undefined);
      })
      .catch((requestError: unknown) => {
        if (active) setError(evolutionErrorMessage(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
    // includeArchived has its own refetch effect below; this one runs per project scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 切换是否查看归档候选时重新拉取（归档项由服务端按需返回）
  useEffect(() => {
    if (!snapshot) return;
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  const automationStatus = snapshot?.automation.status;
  useEffect(() => {
    if (automationStatus !== "running" && automationStatus !== "stopping") return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getEvolution(scope, { includeArchived });
        if (!active) return;
        setSnapshot(next);
        setPollError(undefined);
        if (next.automation.status !== "running" && next.automation.status !== "stopping") {
          return;
        }
      } catch (requestError) {
        if (active) setPollError(evolutionErrorMessage(requestError));
      }
      if (active) timer = window.setTimeout(() => void poll(), 1_500);
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [automationStatus, scope, includeArchived]);

  const proposals = useMemo(
    () => visibleEvolutionProposals(snapshot?.proposals ?? [], filter, query),
    [filter, query, snapshot?.proposals],
  );
  const selected = snapshot?.proposals.find((proposal) => proposal.id === selectedId);
  const locked = snapshot ? evolutionLocked(snapshot) : true;

  useEffect(() => {
    if (busy || loading) return;
    if (!selectedId || proposals.some((proposal) => proposal.id === selectedId)) return;
    setSelectedId(window.innerWidth > 800 ? proposals[0]?.id : undefined);
  }, [busy, loading, proposals, selectedId]);

  useEffect(() => {
    if (!decision || decision.proposalId === selectedId) return;
    setDecision(undefined);
    setDialogError(undefined);
  }, [decision, selectedId]);

  const mutate = async (operation: () => Promise<unknown>, options: { closeDecision?: boolean } = {}) => {
    setBusy(true);
    setError(undefined);
    setDialogError(undefined);
    try {
      await operation();
    } catch (requestError) {
      const message = evolutionErrorMessage(requestError);
      if (decision || creating) setDialogError(message);
      else setError(message);
      if (requestError instanceof ApiError && refreshRequiredEvolutionCodes.has(requestError.code ?? "")) {
        setDecision(undefined);
        await refresh().catch(() => undefined);
        setError(requestError.code === "RECOVERY_REQUIRED"
          ? "本地演进状态需要先恢复，所有变更操作均已停用。"
          : "目标或修订已经变化，请重新查看预览后再确认。");
      }
      setBusy(false);
      return;
    }
    if (options.closeDecision) setDecision(undefined);
    try {
      await refresh();
    } catch {
      setError("操作已由服务端接收，但最新状态读取失败。请刷新后核对，勿重复创建新命令。");
    } finally {
      setBusy(false);
    }
  };

  const submitProposal = async (input: EvolutionProposalInput) => {
    let createdProposalId: string | undefined;
    await mutate(async () => {
      const result = input.kind === "strategy"
        ? await proposeEvolutionStrategy(scope, { name: input.name, definition: input.definition }, input.commandId)
        : await proposeEvolutionPrompt(scope, {
            role: input.role,
            encoding: "base64",
            content: utf8ToBase64(input.content),
          }, input.commandId);
      createdProposalId = result.proposal.id;
      setCreating(false);
    });
    if (createdProposalId) setSelectedId(createdProposalId);
  };

  const evaluate = async () => {
    if (!selected) return;
    await mutate(() => evaluateEvolutionProposal(scope, selected.id));
  };

  const openPreview = async (mode: "promote" | "rollback") => {
    if (!selected || !snapshot) return;
    setBusy(true);
    setError(undefined);
    try {
      const preview = mode === "promote"
        ? await previewEvolutionPromotion(scope, selected.id, snapshot.catalogRevision)
        : await previewEvolutionRollback(scope, selected.id, snapshot.catalogRevision);
      if (selectedIdRef.current !== selected.id) return;
      setDecision({ mode, proposalId: selected.id, commandId: crypto.randomUUID(), preview });
      setDialogError(undefined);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        await refresh().catch(() => undefined);
        setError("候选或目标状态已经变化，请核对最新状态后重新预览。");
      } else {
        setError(evolutionErrorMessage(requestError));
      }
    } finally {
      setBusy(false);
    }
  };

  const openReasonDecision = (mode: "reject" | "adopt") => {
    if (!selected) return;
    setDecision({ mode, proposalId: selected.id, commandId: crypto.randomUUID() });
    setDialogError(undefined);
  };

  const submitDecision = async (reason: string) => {
    if (!decision || !snapshot) return;
    const submittedReason = decision.submittedReason ?? reason;
    if (decision.mode !== "reject" && decision.submittedReason === undefined) {
      setDecision((current) => current?.commandId === decision.commandId
        ? { ...current, submittedReason }
        : current);
    }
    await mutate(async () => {
      if (decision.mode === "reject") {
        await rejectEvolutionProposal(scope, decision.proposalId, submittedReason);
        return;
      }
      if (decision.mode === "adopt") {
        await reconcileEvolutionProposal(scope, decision.proposalId, {
          expectedRevision: snapshot.catalogRevision,
          reason: submittedReason,
        }, decision.commandId);
        return;
      }
      if (decision.mode === "delete") {
        await deleteEvolutionProposal(scope, decision.proposalId, { reason: submittedReason }, decision.commandId);
        return;
      }
      const preview = decision.preview;
      if (!preview || Date.parse(preview.preview.expiresAt) <= Date.now()) {
        throw new Error("预览已经过期，请关闭后重新查看。");
      }
      const input = {
        expectedRevision: preview.preview.catalogRevision,
        token: preview.preview.token,
        reason: submittedReason,
      };
      if (decision.mode === "promote") {
        await confirmEvolutionPromotion(scope, decision.proposalId, input, decision.commandId);
      } else {
        await confirmEvolutionRollback(scope, decision.proposalId, input, decision.commandId);
      }
    }, { closeDecision: true });
  };

  const startAutomation = async () => {
    const intent = automationStartIntent ?? {
      commandId: crypto.randomUUID(),
      maxCycles: requestedCycles,
    };
    setAutomationStartIntent(intent);
    setBusy(true);
    setError(undefined);
    try {
      await startAutomaticEvolution(scope, intent.maxCycles, intent.commandId);
      await refresh();
      setAutomationStartIntent(undefined);
    } catch (requestError) {
      const message = evolutionErrorMessage(requestError);
      try {
        const latest = await refresh();
        setAutomationStartIntent(undefined);
        if (latest.automation.status === "idle") setError(message);
      } catch {
        setError("启动结果暂时无法确认。请使用同一按钮重试，系统不会重复启动同一循环。");
      }
    } finally {
      setBusy(false);
    }
  };

  const stopAutomation = async () => {
    await mutate(() => stopAutomaticEvolution(scope));
  };

  const archiveProposal = async () => {
    if (!selected) return;
    await mutate(() => archiveEvolutionProposal(scope, selected.id, {}, crypto.randomUUID()));
  };

  const unarchiveProposal = async () => {
    if (!selected) return;
    await mutate(() => unarchiveEvolutionProposal(scope, selected.id, {}, crypto.randomUUID()));
  };

  const openDeleteDecision = () => {
    if (!selected) return;
    setDecision({ mode: "delete", proposalId: selected.id, commandId: crypto.randomUUID() });
    setDialogError(undefined);
  };

  if (!snapshot) {
    return (
      <section aria-label="演进工作台" className="grid h-full place-items-center bg-background px-6">
        {loading ? (
          <div role="status" className="flex flex-col items-center gap-3 text-sm text-muted">
            <RefreshCw className="size-6 animate-spin text-accent" />
            <span>正在加载演进控制面</span>
          </div>
        ) : (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-danger-soft text-danger-ink [&_svg]:size-5">
              <LockKeyhole />
            </span>
            <strong className="text-base font-semibold text-ink">无法进入演进工作台</strong>
            <span className="break-words text-sm leading-relaxed text-muted">{error}</span>
            <ActionButton onClick={() => void refresh().catch(() => undefined)}><RefreshCw />重试</ActionButton>
          </div>
        )}
      </section>
    );
  }

  const proposalAudit = selected ? snapshot.auditRecords.filter((item) => item.proposalId === selected.id) : [];
  const completed = selected ? snapshot.completedApplications.filter((item) => item.proposalId === selected.id) : [];
  const mutationLocked = snapshot.recoveryRequired || snapshot.pendingOperation !== null;
  const visibleError = error ?? pollError;

  const actionPanel = selected ? (
    <ActionPanel
      proposal={selected}
      locked={locked}
      busy={busy}
      compact={!wide}
      onEvaluate={() => void evaluate()}
      onPromote={() => void openPreview("promote")}
      onRollback={() => void openPreview("rollback")}
      onReject={() => openReasonDecision("reject")}
      onAdopt={() => openReasonDecision("adopt")}
      onArchive={() => void archiveProposal()}
      onUnarchive={() => void unarchiveProposal()}
      onDelete={() => openDeleteDecision()}
    />
  ) : null;

  return (
    <section
      aria-label="演进工作台"
      className={cn(
        "flex h-full min-h-0 flex-col bg-background text-sm text-ink",
        twoPane ? "overflow-hidden" : "scroll-thin overflow-y-auto overflow-x-hidden",
      )}
    >
      <AutomationBar
        automation={snapshot.automation}
        requestedCycles={requestedCycles}
        busy={busy}
        startIntentPending={automationStartIntent !== undefined}
        mutationLocked={mutationLocked}
        onCyclesChange={setRequestedCycles}
        onStart={() => void startAutomation()}
        onStop={() => void stopAutomation()}
      />
      {(snapshot.recoveryRequired || snapshot.pendingOperation) && (
        <div className="bd-b shrink-0 bg-warning-soft px-4 py-2.5 md:px-6">
          <div role="alert" className="flex items-start gap-2.5 text-warning-ink">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <strong className="text-xs font-semibold">演进操作已锁定</strong>
              <span className="text-xs">
                {snapshot.recoveryRequired ? "本地状态需要先恢复，所有变更操作均已停用。" : "已有目标变更正在处理，请等待完成后刷新。"}
              </span>
            </div>
          </div>
        </div>
      )}
      {visibleError && (
        <div className="shrink-0 px-4 pt-3 md:px-6">
          <Callout tone="danger" role="alert">{visibleError}</Callout>
        </div>
      )}

      <div className={cn("flex flex-1", twoPane ? "min-h-0 flex-row" : "flex-col")}>
        <ProposalRail
          proposals={proposals}
          totalCount={snapshot.proposals.length}
          selectedId={selectedId}
          query={query}
          filter={filter}
          busy={busy}
          loading={loading}
          createDisabled={locked}
          singlePane={!twoPane}
          className={cn(twoPane && "w-[300px] shrink-0 xl:w-[320px]", !twoPane && selected && "hidden")}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onSelect={(id) => { setSelectedId(id); setTab("overview"); }}
          onCreate={() => { setCreating(true); setDialogError(undefined); }}
          onRefresh={() => void refresh().catch(() => undefined)}
        />

        {selected ? (
          <ProposalDetail
            proposal={selected}
            audit={proposalAudit}
            completed={completed}
            tab={tab}
            scrollable={twoPane}
            actions={wide ? null : actionPanel}
            notes={wide ? null : (
              <div className="flex flex-col gap-3">
                <ScopeNote proposal={selected} />
                <TargetMetadata proposal={selected} catalogRevision={snapshot.catalogRevision} />
              </div>
            )}
            onTabChange={setTab}
            onBack={twoPane ? undefined : () => setSelectedId(undefined)}
          />
        ) : twoPane ? (
          <main className="grid min-w-0 flex-1 place-items-center bg-background p-6">
            <div className="flex max-w-xs flex-col items-center gap-2 text-center">
              <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-surface-3 text-muted [&_svg]:size-5">
                <GitCompareArrows />
              </span>
              <strong className="text-sm font-semibold text-ink-2">选择一个候选</strong>
              <span className="text-xs leading-relaxed text-muted">查看变更、结构预检与审计记录</span>
            </div>
          </main>
        ) : null}

        {wide && (
          <aside className="bd-l scroll-thin flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto bg-surface-2 p-4">
            <div>
              <Kicker>操作</Kicker>
              <h2 className="m-0 mt-1.5 text-base font-semibold leading-none tracking-tight text-ink">下一步</h2>
            </div>
            {actionPanel ?? <p className="m-0 py-4 text-xs text-muted">选择候选后显示可执行操作</p>}
            <ScopeNote proposal={selected} />
            {selected && <TargetMetadata proposal={selected} catalogRevision={snapshot.catalogRevision} />}
          </aside>
        )}
      </div>

      <EvolutionProposalDialog open={creating} config={config} snapshot={snapshot} busy={busy} {...(dialogError ? { error: dialogError } : {})} onClose={() => { if (!busy) { setCreating(false); setDialogError(undefined); } }} onSubmit={submitProposal} />
      <EvolutionDecisionDialog decision={decision} busy={busy} {...(dialogError ? { error: dialogError } : {})} onClose={() => { if (!busy) { setDecision(undefined); setDialogError(undefined); } }} onSubmit={submitDecision} />
    </section>
  );
}
