import {
  BookMarked,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Globe2,
  RefreshCw,
  Search,
  Share2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getExperience,
  promoteExperience,
  rejectExperience,
  shareExperience,
} from "../api";
import {
  errorMessage,
  formatExperienceCondition,
  formatExperienceTag,
  formatTimestamp,
  shortRunId,
  summarizeGoal,
} from "../presentation";
import type {
  ExperienceEntry,
  ExperienceSnapshot,
  ExperienceStatus,
  ProjectScope,
} from "../types";

interface ExperienceWorkbenchProps {
  scope: ProjectScope;
}

type ExperienceFilter = "all" | ExperienceStatus | "shared" | "project";
type ActionMode = "promote" | "reject" | "share";

const statusLabels: Record<ExperienceStatus, string> = {
  candidate: "候选",
  verified: "已验证",
  rejected: "已拒绝",
  retired: "已退役",
};

const statusTone: Record<ExperienceStatus, string> = {
  candidate: "warning",
  verified: "success",
  rejected: "danger",
  retired: "neutral",
};

export function ExperienceWorkbench({ scope }: ExperienceWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<ExperienceSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<ExperienceFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pathsOpen, setPathsOpen] = useState(false);
  const [action, setAction] = useState<{ mode: ActionMode; experienceId: string }>();
  const [reason, setReason] = useState("");
  const [suiteDigest, setSuiteDigest] = useState("");
  const [forceWithoutSuite, setForceWithoutSuite] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

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
    void refresh();
  }, [refresh]);

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
      <section className="experience-boot" aria-label="经验工作台">
        {loading ? (
          <>
            <RefreshCw className="is-spinning" size={24} />
            <span>加载中…</span>
          </>
        ) : (
          <>
            <CircleAlert size={24} />
            <strong>加载失败</strong>
            <span>{error}</span>
            <button className="button secondary" onClick={() => void refresh()}>
              重试
            </button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="experience-workbench is-compact" aria-label="经验工作台">
      <header className="experience-banner experience-banner-compact">
        <div className="experience-banner-main">
          <span className="experience-banner-icon">
            <BookMarked size={16} />
          </span>
          <div>
            <strong>经验</strong>
            <span>
              候选需晋升 · 已验证进规划 · 共享后跨项目
              {snapshot.enabled ? "" : " · 已关闭"}
            </span>
          </div>
        </div>
        <div className="experience-banner-metrics" aria-label="经验统计">
          <span className="experience-metric-chip">
            候选 <strong>{snapshot.counts.candidate}</strong>
          </span>
          <span className="experience-metric-chip">
            已验证 <strong>{snapshot.counts.verified}</strong>
          </span>
          <span className="experience-metric-chip">
            公共 <strong>{snapshot.counts.shared}</strong>
          </span>
        </div>
        <button
          className="icon-button"
          onClick={() => void refresh()}
          disabled={loading || busy}
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
        </button>
      </header>

      <aside className="experience-rail">
        <div className="experience-rail-tools">
          <label className="experience-search">
            <Search size={15} />
            <input
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索"
              aria-label="搜索经验"
            />
          </label>
          <select
            value={filter}
            disabled={busy}
            onChange={(event) => setFilter(event.target.value as ExperienceFilter)}
            aria-label="筛选"
          >
            <option value="all">全部</option>
            <option value="candidate">候选</option>
            <option value="verified">已验证</option>
            <option value="shared">公共</option>
            <option value="project">本项目</option>
            <option value="rejected">已拒绝</option>
          </select>
        </div>
        <div className="experience-list">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === selectedId ? "is-selected" : ""}
              disabled={busy}
              onClick={() => setSelectedId(entry.id)}
            >
              <span className="experience-list-topline">
                <span className={`status-badge tone-${statusTone[entry.status]}`}>
                  {statusLabels[entry.status]}
                </span>
                <span className="experience-list-scope">
                  {entry.scope === "shared" ? "公共" : "项目"}
                </span>
              </span>
              <strong title={entry.summary}>{summarizeGoal(entry.summary, 56)}</strong>
              <small>
                命中 {entry.hitCount} · {formatTimestamp(entry.updatedAt)}
              </small>
            </button>
          ))}
          {entries.length === 0 && (
            <div className="experience-list-empty">
              <BookMarked size={22} />
              <span>
                {snapshot.entries.length === 0
                  ? "暂无经验。跑完任务后会出现候选。"
                  : "无匹配项"}
              </span>
            </div>
          )}
        </div>
      </aside>

      <main className="experience-detail">
        {selected ? (
          <ExperienceDetail
            entry={selected}
            busy={busy}
            onPromote={() => {
              setAction({ mode: "promote", experienceId: selected.id });
              setReason("确认可作为已验证经验");
              setSuiteDigest("");
              setForceWithoutSuite(false);
              setDialogError(undefined);
            }}
            onReject={() => {
              setAction({ mode: "reject", experienceId: selected.id });
              setReason("");
              setDialogError(undefined);
            }}
            onShare={() => {
              setAction({ mode: "share", experienceId: selected.id });
              setReason("跨项目可复用");
              setDialogError(undefined);
            }}
          />
        ) : (
          <div className="experience-detail-empty">
            <BookMarked size={26} />
            <strong>选一条经验</strong>
            <span>晋升 / 共享 / 拒绝</span>
          </div>
        )}
        {error && (
          <p className="experience-inline-error" role="alert">
            {error}
          </p>
        )}
      </main>

      <aside className="experience-inspector">
        <section className="experience-help experience-help-compact">
          <div>
            <CheckCircle2 size={15} />
            <span>
              <strong>晋升</strong>后才进规划
            </span>
          </div>
          <div>
            <Globe2 size={15} />
            <span>
              <strong>共享</strong>写入公共库
            </span>
          </div>
          <div>
            <BookMarked size={15} />
            <span>
              <strong>新项目</strong>自动带上已验证
            </span>
          </div>
        </section>
        <button
          type="button"
          className="experience-paths-toggle"
          onClick={() => setPathsOpen((open) => !open)}
          aria-expanded={pathsOpen}
        >
          {pathsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          存储路径
        </button>
        {pathsOpen && (
          <section className="experience-paths">
            <dl className="detail-list">
              <div>
                <dt>本项目</dt>
                <dd>
                  <code title={snapshot.projectPath}>{shortPath(snapshot.projectPath)}</code>
                </dd>
              </div>
              <div>
                <dt>公共</dt>
                <dd>
                  <code title={snapshot.sharedPath}>{shortPath(snapshot.sharedPath)}</code>
                </dd>
              </div>
            </dl>
          </section>
        )}
      </aside>

      {action && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !busy && setAction(undefined)}
        >
          <div
            className="experience-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="experience-action-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="section-kicker">
                  {action.mode === "promote"
                    ? "晋升"
                    : action.mode === "share"
                      ? "共享"
                      : "拒绝"}
                </span>
                <h2 id="experience-action-title">
                  {action.mode === "promote"
                    ? "晋升为已验证"
                    : action.mode === "share"
                      ? "写入公共库"
                      : "拒绝"}
                </h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setAction(undefined)}
                disabled={busy}
                aria-label="关闭"
              >
                <X size={17} />
              </button>
            </header>
            <label className="experience-reason-field">
              <span>原因</span>
              <textarea
                value={reason}
                disabled={busy}
                rows={3}
                onChange={(event) => setReason(event.target.value)}
                placeholder="简短说明"
              />
            </label>
            {action.mode === "promote" && (
              <div className="experience-promote-evidence">
                <label className="experience-reason-field">
                  <span>
                    评测 suiteDigest
                    {snapshot.requireSuiteForPromote ? "（推荐/必填）" : "（可选）"}
                  </span>
                  <input
                    value={suiteDigest}
                    disabled={busy}
                    onChange={(event) => setSuiteDigest(event.target.value)}
                    placeholder="64 位 hex，来自 EvaluationSuite"
                    spellCheck={false}
                  />
                </label>
                {snapshot.requireSuiteForPromote && (
                  <label className="experience-force-suite">
                    <input
                      type="checkbox"
                      checked={forceWithoutSuite}
                      disabled={busy}
                      onChange={(event) => setForceWithoutSuite(event.target.checked)}
                    />
                    无评测，强制晋升
                  </label>
                )}
              </div>
            )}
            {dialogError && (
              <p className="experience-inline-error" role="alert">
                {dialogError}
              </p>
            )}
            <footer>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setAction(undefined)}
              >
                取消
              </button>
              <button
                className={action.mode === "reject" ? "button danger-quiet" : "button primary"}
                disabled={busy || !reason.trim()}
                onClick={() => void submitAction()}
              >
                {busy ? "提交中…" : "确认"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}

function ExperienceDetail({
  entry,
  busy,
  onPromote,
  onReject,
  onShare,
}: {
  entry: ExperienceEntry;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
}) {
  const canPromote = entry.scope === "project" && entry.status === "candidate";
  const canShare =
    entry.scope === "project" &&
    entry.status === "verified" &&
    entry.sensitivity === "low" &&
    entry.portability === "cross-project";
  const canReject = entry.status === "candidate" || entry.status === "verified";
  const conditions = entry.conditions.slice(0, 5).map(formatExperienceCondition);
  const tags = entry.tags.slice(0, 6).map(formatExperienceTag);

  return (
    <>
      <header className="experience-detail-header">
        <div>
          <div className="experience-detail-badges">
            <span className={`status-badge tone-${statusTone[entry.status]}`}>
              {statusLabels[entry.status]}
            </span>
            <span className="experience-pill">
              {entry.scope === "shared" ? "公共" : "项目"}
            </span>
            <span className="experience-pill">
              {entry.portability === "cross-project" ? "可跨项目" : "仅本项目"}
            </span>
          </div>
          <h1 title={entry.summary}>{entry.summary}</h1>
        </div>
      </header>

      <div className="experience-actions">
        {canPromote && (
          <button className="button primary" disabled={busy} onClick={onPromote}>
            <CheckCircle2 size={16} />
            晋升
          </button>
        )}
        {canShare && (
          <button className="button secondary" disabled={busy} onClick={onShare}>
            <Share2 size={16} />
            共享
          </button>
        )}
        {canReject && (
          <button className="button danger-quiet" disabled={busy} onClick={onReject}>
            拒绝
          </button>
        )}
        {!canPromote && !canShare && !canReject && (
          <span className="experience-action-hint">只读</span>
        )}
      </div>

      <section className="experience-section">
        <h3>条件</h3>
        {conditions.length === 0 ? (
          <p className="experience-muted">无</p>
        ) : (
          <ul className="experience-chip-list">
            {conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        )}
      </section>

      {tags.length > 0 && (
        <section className="experience-section">
          <h3>标签</h3>
          <ul className="experience-chip-list">
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="experience-section experience-meta-compact">
        <span>
          来源 <code title={entry.sourceRunId}>{shortRunId(entry.sourceRunId)}</code>
        </span>
        <span>
          命中 {entry.hitCount}
        </span>
        <span>{formatTimestamp(entry.updatedAt)}</span>
        {entry.failureReason ? <span className="is-error">拒绝：{entry.failureReason}</span> : null}
      </section>
    </>
  );
}

function shortPath(value: string): string {
  if (value.length <= 48) return value;
  return `…${value.slice(-44)}`;
}
