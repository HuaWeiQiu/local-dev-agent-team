import {
  ArrowLeft,
  Ban,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileText,
  GitCompareArrows,
  History,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  confirmEvolutionPromotion,
  confirmEvolutionRollback,
  evaluateEvolutionProposal,
  getEvolution,
  previewEvolutionPromotion,
  previewEvolutionRollback,
  proposeEvolutionPrompt,
  proposeEvolutionStrategy,
  reconcileEvolutionProposal,
  rejectEvolutionProposal,
} from "../api";
import {
  evolutionLocked,
  evolutionStatusLabels,
  proposalTarget,
  proposalTitle,
  proposalProgress,
  proposalStatusLabel,
  proposalStatusTone,
  utf8ToBase64,
  visibleEvolutionProposals,
  type EvolutionFilter,
} from "../evolution";
import { errorMessage } from "../presentation";
import type {
  EvolutionAuditRecord,
  EvolutionCompletedApplication,
  EvolutionProposal,
  EvolutionSnapshot,
  ProjectScope,
  PublicConfig,
} from "../types";
import { EvolutionDecisionDialog, type EvolutionDecision } from "./EvolutionDecisionDialog";
import { EvolutionProposalDialog, type EvolutionProposalInput } from "./EvolutionProposalDialog";

interface EvolutionWorkbenchProps {
  scope: ProjectScope;
  config: PublicConfig;
}

type DetailTab = "overview" | "evidence" | "history";

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
  const [dialogError, setDialogError] = useState<string>();
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getEvolution(scope);
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
  }, [scope]);

  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setSelectedId(undefined);
    setDecision(undefined);
    setCreating(false);
    setError(undefined);
    setLoading(true);
    void getEvolution(scope)
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setSelectedId(window.innerWidth > 800 ? next.proposals[0]?.id : undefined);
      })
      .catch((requestError: unknown) => {
        if (active) setError(evolutionErrorMessage(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [scope]);

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

  if (!snapshot) {
    return (
      <section className="evolution-boot" aria-label="演进工作台">
        {loading ? <><RefreshCw className="is-spinning" size={24} /><span>正在加载演进控制面</span></> : <><LockKeyhole size={24} /><strong>无法进入演进工作台</strong><span>{error}</span><button className="button secondary" onClick={() => void refresh().catch(() => undefined)}>重试</button></>}
      </section>
    );
  }

  const proposalAudit = selected ? snapshot.auditRecords.filter((item) => item.proposalId === selected.id) : [];
  const completed = selected ? snapshot.completedApplications.filter((item) => item.proposalId === selected.id) : [];

  return (
    <section className={`evolution-workbench ${selected ? "has-selection" : ""}`} aria-label="演进工作台">
      {(snapshot.recoveryRequired || snapshot.pendingOperation) && (
        <div className="evolution-lock-banner" role="alert"><CircleAlert size={17} /><div><strong>演进操作已锁定</strong><span>{snapshot.recoveryRequired ? "本地状态需要先恢复，所有变更操作均已停用。" : "已有目标变更正在处理，请等待完成后刷新。"}</span></div></div>
      )}
      <aside className="evolution-rail">
        <header>
          <div><span className="section-kicker">CONTROLLED EVOLUTION</span><h1>演进候选</h1></div>
          <button className="button primary" onClick={() => { setCreating(true); setDialogError(undefined); }} disabled={locked} title="新建候选"><Plus size={16} /><span>新建</span></button>
        </header>
        <div className="evolution-rail-tools">
          <label className="evolution-search"><Search size={15} /><input value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="搜索候选" aria-label="搜索候选" /></label>
          <select value={filter} disabled={busy} onChange={(event) => setFilter(event.target.value as EvolutionFilter)} aria-label="候选状态筛选">
            <option value="open">待处理</option><option value="all">全部</option><option value="proposed">待预检</option><option value="evaluated">已预检</option><option value="promoted">已晋升</option><option value="rejected">已拒绝</option><option value="rolled-back">已回滚</option>
          </select>
        </div>
        <div className="evolution-proposal-list">
          {proposals.map((proposal) => (
            <button key={proposal.id} aria-current={proposal.id === selectedId ? "true" : undefined} className={proposal.id === selectedId ? "is-selected" : ""} disabled={busy} onClick={() => { setSelectedId(proposal.id); setTab("overview"); }}>
              <span className={`evolution-candidate-icon kind-${proposal.candidate.kind}`}>{proposal.candidate.kind === "strategy-blueprint" ? <Braces size={16} /> : <FileText size={16} />}</span>
              <span><strong>{proposalTitle(proposal)}</strong><small>{proposalTarget(proposal)}</small><time>{formatDate(proposal.createdAt)}</time></span>
              <span className={`status-badge tone-${proposalStatusTone(proposal)}`}>{proposalStatusLabel(proposal)}</span>
              <ChevronRight size={15} />
            </button>
          ))}
          {proposals.length === 0 && <div className="evolution-list-empty"><GitCompareArrows size={24} /><span>{snapshot.proposals.length ? "没有符合条件的候选" : "还没有演进候选"}</span></div>}
        </div>
      </aside>

      <main className="evolution-detail">
        {selected ? (
          <>
            <header className="evolution-detail-header">
              <button className="icon-button evolution-mobile-back" onClick={() => setSelectedId(undefined)} aria-label="返回候选列表"><ArrowLeft size={18} /></button>
              <span className={`evolution-candidate-icon kind-${selected.candidate.kind}`}>{selected.candidate.kind === "strategy-blueprint" ? <Braces size={18} /> : <FileText size={18} />}</span>
              <div><span className="section-kicker">{selected.candidate.kind === "strategy-blueprint" ? "STRATEGY" : "ROLE PROMPT"}</span><h1>{proposalTitle(selected)}</h1><small>{proposalTarget(selected)}</small></div>
              <span className={`status-badge tone-${proposalStatusTone(selected)}`}>{proposalStatusLabel(selected)}</span>
            </header>
            <ProposalProgress proposal={selected} />
            <div className="evolution-mobile-action">
              <ActionPanel proposal={selected} locked={locked} busy={busy} onEvaluate={() => void evaluate()} onPromote={() => void openPreview("promote")} onRollback={() => void openPreview("rollback")} onReject={() => openReasonDecision("reject")} onAdopt={() => openReasonDecision("adopt")} />
            </div>
            <nav className="evolution-tabs" role="tablist" aria-label="候选详情">
              <DetailTabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<GitCompareArrows size={15} />} label="概览" />
              <DetailTabButton active={tab === "evidence"} onClick={() => setTab("evidence")} icon={<FileCheck2 size={15} />} label="预检" />
              <DetailTabButton active={tab === "history"} onClick={() => setTab("history")} icon={<History size={15} />} label="记录" />
            </nav>
            <div className="evolution-detail-scroll">
              {tab === "overview" && <Overview proposal={selected} />}
              {tab === "evidence" && <Evidence proposal={selected} />}
              {tab === "history" && <HistoryView proposal={selected} audit={proposalAudit} completed={completed} />}
            </div>
          </>
        ) : <div className="evolution-detail-empty"><GitCompareArrows size={28} /><strong>选择一个候选</strong><span>查看变更、结构预检与审计记录</span></div>}
      </main>

      <aside className="evolution-inspector">
        <header><span className="section-kicker">NEXT STEP</span><h2>下一步</h2><button className="icon-button" onClick={() => void refresh().catch(() => undefined)} disabled={loading || busy} aria-label="刷新演进状态" title="刷新"><RefreshCw size={16} className={loading ? "is-spinning" : ""} /></button></header>
        {selected ? (
          <ActionPanel proposal={selected} locked={locked} busy={busy} onEvaluate={() => void evaluate()} onPromote={() => void openPreview("promote")} onRollback={() => void openPreview("rollback")} onReject={() => openReasonDecision("reject")} onAdopt={() => openReasonDecision("adopt")} />
        ) : <div className="evolution-inspector-empty">选择候选后显示可执行操作</div>}
        <section className="evolution-scope-note"><ShieldCheck size={16} /><div><strong>人工控制</strong><span>结构预检不会执行候选，也不会自动应用或发布。</span></div></section>
        {selected && <section className="evolution-metadata"><h3>目标信息</h3><dl className="detail-list"><div><dt>类型</dt><dd>{selected.candidate.kind === "strategy-blueprint" ? "执行策略" : "角色提示词"}</dd></div><div><dt>Catalog</dt><dd>修订 {snapshot.catalogRevision}</dd></div><div><dt>目标摘要</dt><dd><code>{shortDigest(selected.application?.afterTargetDigest ?? null)}</code></dd></div><div><dt>创建时间</dt><dd>{formatDate(selected.createdAt)}</dd></div></dl></section>}
        {error && <p className="evolution-inline-error" role="alert">{error}</p>}
      </aside>

      <EvolutionProposalDialog open={creating} config={config} snapshot={snapshot} busy={busy} {...(dialogError ? { error: dialogError } : {})} onClose={() => { if (!busy) { setCreating(false); setDialogError(undefined); } }} onSubmit={submitProposal} />
      <EvolutionDecisionDialog decision={decision} busy={busy} {...(dialogError ? { error: dialogError } : {})} onClose={() => { if (!busy) { setDecision(undefined); setDialogError(undefined); } }} onSubmit={submitDecision} />
    </section>
  );
}

function ActionPanel({ proposal, locked, busy, onEvaluate, onPromote, onRollback, onReject, onAdopt }: {
  proposal: EvolutionProposal;
  locked: boolean;
  busy: boolean;
  onEvaluate(): void;
  onPromote(): void;
  onRollback(): void;
  onReject(): void;
  onAdopt(): void;
}) {
  const disabled = locked || busy;
  if (proposal.status === "proposed") return <section className="evolution-next-action"><ShieldCheck size={22} /><h3>运行结构预检</h3><p>校验候选结构、信任边界和目标条件。</p><button className="button primary" onClick={onEvaluate} disabled={disabled}><ShieldCheck size={16} />开始预检</button></section>;
  if (proposal.status === "evaluating") return <section className="evolution-next-action"><RefreshCw size={22} /><h3>继续结构预检</h3><p>上次预检未完成，可以从当前候选安全重入。</p><button className="button primary" onClick={onEvaluate} disabled={disabled}><RefreshCw size={16} />继续预检</button></section>;
  if (proposal.status === "evaluated" && proposal.evaluation?.result.passed && proposal.evaluation.source === "server-structural-preflight-v1") {
    return <section className="evolution-next-action"><CheckCircle2 size={22} /><h3>检查精确变更</h3><p>先查看当前值与应用后的完整内容，再作人工决定。</p><button className="button primary" onClick={onPromote} disabled={disabled}><GitCompareArrows size={16} />查看并应用</button><button className="button danger-quiet" onClick={onReject} disabled={disabled}><Ban size={15} />拒绝候选</button></section>;
  }
  if (proposal.status === "evaluated") return <section className="evolution-next-action"><CircleAlert size={22} /><h3>{proposal.evaluation?.source === "external" ? "需要当前结构预检" : "预检未通过"}</h3><p>{proposal.evaluation?.result.summary ?? "候选没有可用于应用的服务端预检证据。"}</p><button className="button danger-quiet" onClick={onReject} disabled={disabled}><Ban size={15} />拒绝候选</button></section>;
  if (proposal.status === "promoted" && proposal.application?.rollbackSafe) return <section className="evolution-next-action"><RotateCcw size={22} /><h3>已受控应用</h3><p>可以预览并恢复到应用前的精确目标。</p><button className="button secondary" onClick={onRollback} disabled={disabled}><RotateCcw size={16} />预览回滚</button></section>;
  if (proposal.status === "promoted" && !proposal.application) return <section className="evolution-next-action"><LockKeyhole size={22} /><h3>登记旧版应用</h3><p>仅当当前目标逐字匹配候选时，采纳现状并建立应用记录。</p><button className="button secondary" onClick={onAdopt} disabled={disabled}><ShieldCheck size={16} />采纳当前目标</button></section>;
  return <section className="evolution-next-action is-complete"><CheckCircle2 size={22} /><h3>流程已结束</h3><p>该候选已进入只读审计状态。</p></section>;
}

function ProposalProgress({ proposal }: { proposal: EvolutionProposal }) {
  const { step, finalLabel } = proposalProgress(proposal);
  return <ol className="evolution-progress" aria-label="候选进度"><li className="is-done"><span>1</span>候选</li><li className={step >= 2 ? "is-done" : ""}><span>2</span>结构预检</li><li className={step >= 3 ? "is-done" : ""}><span>3</span>人工决定</li><li className={step >= 4 ? "is-done" : ""}><span>4</span>{finalLabel}</li></ol>;
}

function Overview({ proposal }: { proposal: EvolutionProposal }) {
  return <>
    <section className="evolution-section"><span className="section-kicker">CHANGE TARGET</span><h2>{proposalTarget(proposal)}</h2><p>{proposal.candidate.kind === "strategy-blueprint" ? "候选将更新一个本地自定义执行策略。应用前会再次比较目标摘要。" : "候选指向项目已配置的角色提示词。内容只在精确预览和本地对象存储中使用。"}</p></section>
    {proposal.candidate.kind === "strategy-blueprint" ? <section className="evolution-section"><h3>执行参数</h3><dl className="evolution-definition-grid"><div><dt>拓扑</dt><dd>{proposal.candidate.definition.topology?.mode === "sequential" ? "顺序执行" : "依赖并行"}</dd></div><div><dt>最大并行</dt><dd>{proposal.candidate.definition.maxParallel ?? "默认"}</dd></div><div><dt>最多返工</dt><dd>{proposal.candidate.definition.maxReworkAttempts ?? "默认"}</dd></div><div><dt>Agent 调用上限</dt><dd>{proposal.candidate.definition.maxAgentInvocations ?? "默认"}</dd></div><div><dt>执行超时</dt><dd>{proposal.candidate.definition.executionTimeoutSeconds ? `${proposal.candidate.definition.executionTimeoutSeconds} 秒` : "默认"}</dd></div><div><dt>人工门禁</dt><dd>{proposal.candidate.definition.approvalGates?.join("、") || "沿用默认"}</dd></div></dl></section> : <section className="evolution-section"><h3>材料摘要</h3><dl className="detail-list"><div><dt>仓库路径</dt><dd><code>{proposal.candidate.path}</code></dd></div><div><dt>SHA-256</dt><dd><code>{proposal.candidate.contentDigest}</code></dd></div></dl></section>}
    <section className="evolution-section"><h3>自动能力</h3><div className="evolution-capabilities"><span><LockKeyhole size={14} />不自动执行</span><span><LockKeyhole size={14} />不自动晋升</span><span><LockKeyhole size={14} />不网络发布</span><span><LockKeyhole size={14} />不存储秘密</span></div></section>
  </>;
}

function Evidence({ proposal }: { proposal: EvolutionProposal }) {
  if (!proposal.evaluation) return <div className="evolution-tab-empty"><FileCheck2 size={25} /><strong>尚未运行结构预检</strong><span>预检由服务端生成并绑定当前候选。</span></div>;
  return <>
    <section className={`evolution-evidence-summary ${proposal.evaluation.result.passed ? "is-pass" : "is-fail"}`}><span>{proposal.evaluation.result.passed ? <CheckCircle2 size={22} /> : <CircleAlert size={22} />}</span><div><strong>{proposal.evaluation.result.passed ? "结构预检通过" : "结构预检未通过"}</strong><p>{proposal.evaluation.result.passed ? "所有确定性检查均已通过，未出现否决项。" : proposal.evaluation.result.summary}</p></div></section>
    <p className="evolution-evidence-scope"><ShieldCheck size={15} />此结果只验证结构和本地安全条件，未执行候选策略或提示词。</p>
    <section className="evolution-evidence-list">{proposal.evaluation.evidence.items.map((item) => { const passed = item.kind === "deterministic" ? item.status === "pass" : item.verdict === "approve"; return <div key={item.id}><span className={passed ? "is-pass" : "is-fail"}>{passed ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}</span><div><strong>{evidenceItemSummary(item.id, item.summary, passed)}</strong><code>{item.id}</code></div><small>{item.kind === "deterministic" ? (item.status === "pass" ? "通过" : "失败") : item.verdict}</small></div>; })}</section>
  </>;
}

function HistoryView({ proposal, audit, completed }: { proposal: EvolutionProposal; audit: EvolutionAuditRecord[]; completed: EvolutionCompletedApplication[] }) {
  const rows = [
    { at: proposal.createdAt, label: "创建候选", detail: proposalTarget(proposal) },
    ...proposal.transitions.map((transition) => ({ at: transition.at, label: evolutionStatusLabels[transition.to], detail: `${evolutionStatusLabels[transition.from]} → ${evolutionStatusLabels[transition.to]}` })),
    ...audit.map((record) => ({ at: record.at, label: auditLabel(record.kind), detail: record.reason })),
    ...completed.map((record) => ({ at: record.completedAt, label: completedLabel(record.operation), detail: record.reason })),
  ].sort((left, right) => right.at.localeCompare(left.at));
  return <section className="evolution-history-list">{rows.map((row, index) => <div key={`${row.at}-${row.label}-${index}`}><span /><div><strong>{row.label}</strong><p>{row.detail}</p></div><time>{formatDate(row.at)}</time></div>)}</section>;
}

function DetailTabButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return <button role="tab" aria-selected={active} className={active ? "is-active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function evolutionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "本地控制会话尚未建立，请从服务启动时输出的地址重新打开应用。";
    if (error.code === "ORIGIN_DENIED") return "当前页面来源与控制服务不一致，请从控制服务地址打开应用。";
    if (error.code === "ACTIVE_RUN_CONFLICT") return "项目中仍有 Agent 操作正在进行，结束后可使用同一确认重新提交。";
    if (error.code === "RECOVERY_REQUIRED") return "本地演进状态需要恢复，当前操作已安全停止。";
  }
  return errorMessage(error);
}

const refreshRequiredEvolutionCodes = new Set(["STALE_PREVIEW", "STALE_CATALOG_REVISION", "TARGET_DRIFTED", "ACTIVE_TARGET_CONFLICT", "RECOVERY_REQUIRED"]);
const formatDate = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const shortDigest = (digest: string | null) => digest ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : "尚未应用";
const auditLabel = (kind: EvolutionAuditRecord["kind"]) => kind === "promotion" ? "晋升审计" : kind === "rollback" ? "回滚审计" : "拒绝审计";
const completedLabel = (operation: EvolutionCompletedApplication["operation"]) => operation === "promote-and-apply" ? "应用完成" : operation === "rollback-applied" ? "回滚完成" : "登记完成";
function evidenceItemSummary(id: string, fallback: string, passed: boolean): string {
  if (!passed) return fallback;
  if (id === "server-candidate-trust-v1") return "当前项目信任边界与受限能力检查通过；候选未执行";
  if (id === "server-strategy-preflight-v1") return "策略结构、拓扑、角色配置与目录条件检查通过；候选未执行";
  if (id === "server-prompt-object-integrity-v1") return "提示词对象摘要、大小、权限与 UTF-8 检查通过；候选未执行";
  if (id === "server-prompt-target-trust-v1") return "提示词目标路径、内容与 Git 跟踪条件检查通过；候选未执行";
  return fallback;
}
