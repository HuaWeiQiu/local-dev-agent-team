import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  FileText,
  GitCompareArrows,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, memo, type ButtonHTMLAttributes } from "react";
import { formatBytes } from "../presentation";
import type { EvidenceFilePreview, RunEvidence, RunState } from "../types";
import { Card, SectionTitle } from "../ui/card";
import { cn } from "../ui/cn";
import { EmptyState } from "./EmptyState";
import { EvidenceTaskMatrix } from "./run/EvidenceTaskMatrix";

interface EvidenceCenterProps {
  run: RunState | undefined;
  evidence: RunEvidence | undefined;
  loading: boolean;
  onReadArtifact(path: string): Promise<EvidenceFilePreview>;
}

const readinessStyle = {
  ready: { icon: CheckCircle2, box: "bg-success-soft text-success-ink", mark: "bg-success/15 text-success" },
  attention: { icon: AlertTriangle, box: "bg-warning-soft text-warning-ink", mark: "bg-warning/20 text-warning" },
  "in-progress": { icon: CircleDashed, box: "bg-info-soft text-info-ink", mark: "bg-info/15 text-info" },
} as const;

const checkIcon = {
  pass: { icon: CheckCircle2, className: "text-success" },
  fail: { icon: AlertTriangle, className: "text-danger" },
  pending: { icon: CircleDashed, className: "text-warning" },
} as const;

export const EvidenceCenter = memo(function EvidenceCenter({ run, evidence, loading, onReadArtifact }: EvidenceCenterProps) {
  const [file, setFile] = useState<EvidenceFilePreview>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string>();

  useEffect(() => {
    setFile(undefined);
    setFileError(undefined);
  }, [evidence?.runId]);

  if (!run) {
    return <EmptyState icon={<ShieldCheck />} title="选择运行后查看交付证据" />;
  }
  if (loading && !evidence) {
    return <EmptyState role="status" icon={<CircleDashed className="motion-safe:animate-spin" />} title="正在汇总本地证据" />;
  }
  if (!evidence) {
    return <EmptyState icon={<AlertTriangle />} title="交付证据暂不可用" hint="运行结束并生成证据后会显示在这里" />;
  }

  const openArtifact = async (artifactPath: string) => {
    setFileLoading(true);
    setFileError(undefined);
    try {
      setFile(await onReadArtifact(artifactPath));
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileLoading(false);
    }
  };
  const previewTitle = file?.path ?? "集成差异";
  const previewContent = file?.content ?? evidence.diff.content;
  const readiness = readinessStyle[evidence.readiness];
  const ReadinessIcon = readiness.icon;

  return (
    <section aria-label="交付证据中心" className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6 [&>*]:shrink-0">
      <Card className="grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className={cn("flex items-center gap-3 px-4 py-4", readiness.box)}>
          <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-full", readiness.mark)}>
            <ReadinessIcon className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <small className="text-2xs font-semibold uppercase tracking-wider opacity-75">Delivery readiness</small>
            <strong className="text-base font-semibold">{readinessLabel(evidence.readiness)}</strong>
          </span>
        </div>
        <div className="bd-t grid min-w-0 grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:border-t-0 xl:grid-cols-4">
          {evidence.checks.map((check) => {
            const { icon: CheckIcon, className } = checkIcon[check.status];
            return (
              <div key={check.id} className="flex min-w-0 items-start gap-2.5 bg-surface px-3.5 py-3">
                <CheckIcon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-xs font-semibold text-ink">{check.label}</strong>
                  <small className="line-clamp-2 text-2xs leading-snug text-muted" title={check.detail}>{check.detail}</small>
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:h-[clamp(380px,58vh,640px)] lg:grid-cols-[minmax(220px,264px)_minmax(0,1fr)]">
        <aside aria-label="证据索引" className="bd flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-surface shadow-card">
          <IndexButton selected={!file} onClick={() => { setFile(undefined); setFileError(undefined); }}>
            <GitCompareArrows aria-hidden className="size-4" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <strong className="truncate text-xs font-medium">集成差异</strong>
              <small className="text-2xs text-muted">{evidence.diff.changedFiles.length} 个变更文件</small>
            </span>
          </IndexButton>
          <div className="bd-t flex items-center justify-between gap-2 bg-surface-2 px-3 py-2">
            <SectionTitle>运行产物</SectionTitle>
            <small className="text-2xs text-muted">{evidence.artifacts.length} 项 · {formatBytes(evidence.artifactBytes)}</small>
          </div>
          <div className="artifact-list scroll-thin max-h-60 min-h-0 flex-1 overflow-y-auto lg:max-h-none">
            {evidence.artifacts.map((artifact) => (
              <IndexButton
                key={artifact.path}
                selected={file?.path === artifact.path}
                disabled={!artifact.previewable || fileLoading}
                onClick={() => void openArtifact(artifact.path)}
                title={artifact.previewable ? artifact.path : "该文件不支持文本预览"}
              >
                {artifact.kind === "quality" ? <ShieldCheck aria-hidden className="size-4" /> : artifact.kind === "context" ? <FileCode2 aria-hidden className="size-4" /> : <FileText aria-hidden className="size-4" />}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="truncate text-xs font-medium">{artifact.path}</strong>
                  <small className="text-2xs text-muted">{artifactLabel(artifact.kind)} · {formatBytes(artifact.size)}</small>
                </span>
              </IndexButton>
            ))}
            {evidence.artifacts.length === 0 && <p className="m-0 px-3 py-4 text-xs text-muted">当前运行尚无本地产物</p>}
          </div>
        </aside>

        <section aria-label="证据预览" className="flex h-[420px] min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-solid border-[var(--terminal-line)] bg-[var(--terminal-bg)] shadow-card lg:h-auto">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-solid border-[var(--terminal-line)] bg-[var(--terminal-raised)] px-3.5 py-2.5 text-[var(--terminal-ink)]">
            <div className="min-w-0">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-[var(--terminal-muted)]">{file ? "交付物" : "集成差异"}</span>
              <h2 className="m-0 mt-0.5 truncate text-xs font-medium" title={previewTitle}>{previewTitle}</h2>
            </div>
            {!file && evidence.diff.targetCommit && (
              <code className="shrink-0 text-2xs text-[var(--terminal-muted)]">{evidence.diff.baseCommit.slice(0, 8)}..{evidence.diff.targetCommit.slice(0, 8)}</code>
            )}
            {file && <small className="shrink-0 text-2xs text-[var(--terminal-muted)]">{formatBytes(file.size)}{file.truncated ? " · 已截断" : ""}</small>}
          </header>
          {fileError ? (
            <p className="m-0 flex flex-1 items-center justify-center p-5 text-center text-xs text-[color-mix(in_oklab,var(--danger)_60%,oklch(0.98_0_0))]">{fileError}</p>
          ) : previewContent !== undefined ? (
            <pre className="evidence-code scroll-thin m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-2xs leading-relaxed text-[var(--terminal-ink)]">{previewContent || "没有文本差异"}</pre>
          ) : (
            <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 p-5 text-center text-[var(--terminal-muted)]">
              <GitCompareArrows aria-hidden className="size-5" />
              <strong className="text-xs font-medium text-[var(--terminal-ink)]">{evidence.diff.detail ?? "集成差异尚不可用"}</strong>
              <span className="text-2xs">运行到达持久化 Git 检查点后会自动显示。</span>
            </div>
          )}
        </section>
      </div>

      <EvidenceTaskMatrix tasks={evidence.tasks} />
    </section>
  );
});

function IndexButton({ selected, className, children, ...props }: { selected: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <div
      className={cn(
        "bd-b transition-colors has-[:disabled]:opacity-50",
        selected ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-3 has-[:disabled]:hover:bg-transparent",
      )}
    >
      <button
        type="button"
        className={cn(
          "grid w-full min-w-0 cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-2 border-0 bg-transparent px-3 py-2.5 text-left focus-ring disabled:cursor-not-allowed [&>svg]:mt-0.5",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </div>
  );
}

function readinessLabel(readiness: RunEvidence["readiness"]): string {
  return readiness === "ready" ? "可交付" : readiness === "attention" ? "需要处理" : "证据生成中";
}

function artifactLabel(kind: RunEvidence["artifacts"][number]["kind"]): string {
  return { context: "上下文", "agent-output": "Agent 输出", quality: "质量命令", review: "代码审查", test: "测试审查", other: "其他" }[kind];
}
