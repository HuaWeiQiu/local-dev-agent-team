import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  FileText,
  GitCompareArrows,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { EvidenceFilePreview, RunEvidence, RunState } from "../types";

interface EvidenceCenterProps {
  run: RunState | undefined;
  evidence: RunEvidence | undefined;
  loading: boolean;
  onReadArtifact(path: string): Promise<EvidenceFilePreview>;
}

export function EvidenceCenter({ run, evidence, loading, onReadArtifact }: EvidenceCenterProps) {
  const [file, setFile] = useState<EvidenceFilePreview>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string>();

  useEffect(() => {
    setFile(undefined);
    setFileError(undefined);
  }, [evidence?.runId]);

  if (!run) {
    return <div className="evidence-empty"><ShieldCheck size={28} /><strong>选择运行后查看交付证据</strong></div>;
  }
  if (loading && !evidence) {
    return <div className="evidence-empty"><CircleDashed className="spin" size={28} /><strong>正在汇总本地证据</strong></div>;
  }
  if (!evidence) {
    return <div className="evidence-empty"><AlertTriangle size={28} /><strong>交付证据暂不可用</strong></div>;
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

  return (
    <div className="evidence-center" aria-label="交付证据中心">
      <header className="evidence-overview">
        <div className={`readiness readiness-${evidence.readiness}`}>
          {evidence.readiness === "ready" ? <CheckCircle2 size={21} /> : evidence.readiness === "attention" ? <AlertTriangle size={21} /> : <CircleDashed size={21} />}
          <span><small>DELIVERY READINESS</small><strong>{readinessLabel(evidence.readiness)}</strong></span>
        </div>
        <div className="evidence-checks">
          {evidence.checks.map((check) => (
            <div key={check.id} className={`evidence-check is-${check.status}`}>
              {check.status === "pass" ? <CheckCircle2 size={15} /> : check.status === "fail" ? <AlertTriangle size={15} /> : <CircleDashed size={15} />}
              <span><strong>{check.label}</strong><small>{check.detail}</small></span>
            </div>
          ))}
        </div>
      </header>

      <div className="evidence-body">
        <aside className="evidence-index" aria-label="证据索引">
          <button className={!file ? "is-selected" : ""} onClick={() => { setFile(undefined); setFileError(undefined); }}>
            <GitCompareArrows size={15} /><span><strong>集成差异</strong><small>{evidence.diff.changedFiles.length} 个变更文件</small></span>
          </button>
          <div className="evidence-index-heading"><span>运行产物</span><small>{evidence.artifacts.length} 项 · {formatBytes(evidence.artifactBytes)}</small></div>
          <div className="artifact-list">
            {evidence.artifacts.map((artifact) => (
              <button
                key={artifact.path}
                disabled={!artifact.previewable || fileLoading}
                className={file?.path === artifact.path ? "is-selected" : ""}
                onClick={() => void openArtifact(artifact.path)}
                title={artifact.previewable ? artifact.path : "该文件不支持文本预览"}
              >
                {artifact.kind === "quality" ? <ShieldCheck size={14} /> : artifact.kind === "context" ? <FileCode2 size={14} /> : <FileText size={14} />}
                <span><strong>{artifact.path}</strong><small>{artifactLabel(artifact.kind)} · {formatBytes(artifact.size)}</small></span>
              </button>
            ))}
            {evidence.artifacts.length === 0 && <p>当前运行尚无本地产物</p>}
          </div>
        </aside>

        <main className="evidence-preview">
          <header>
            <div><span className="section-kicker">{file ? "ARTIFACT" : "INTEGRATION DIFF"}</span><h2>{previewTitle}</h2></div>
            {!file && evidence.diff.targetCommit && <code>{evidence.diff.baseCommit.slice(0, 8)}..{evidence.diff.targetCommit.slice(0, 8)}</code>}
            {file && <small>{formatBytes(file.size)}{file.truncated ? " · 已截断" : ""}</small>}
          </header>
          {fileError ? <p className="evidence-notice is-error">{fileError}</p> : previewContent !== undefined ? (
            <pre className="evidence-code">{previewContent || "没有文本差异"}</pre>
          ) : (
            <div className="evidence-notice"><GitCompareArrows size={22} /><strong>{evidence.diff.detail ?? "集成差异尚不可用"}</strong><span>运行到达持久化 Git 检查点后会自动显示。</span></div>
          )}
        </main>
      </div>

      <section className="task-evidence">
        <header><div><span className="section-kicker">TASK EVIDENCE</span><h2>任务交付矩阵</h2></div><small>{evidence.tasks.length} 个任务</small></header>
        <div className="task-evidence-table" role="table" aria-label="任务交付矩阵">
          <div className="task-evidence-row table-heading" role="row"><span>任务</span><span>质量</span><span>审查</span><span>测试</span><span>提交</span></div>
          {evidence.tasks.map((task) => (
            <div className="task-evidence-row" role="row" key={task.id}>
              <span><strong>{task.title}</strong><small>{task.id} · {task.status}</small></span>
              <EvidenceValue value={task.qualityPassed === undefined ? "待执行" : task.qualityPassed ? "通过" : "失败"} passing={task.qualityPassed} />
              <EvidenceValue value={task.reviewVerdict ?? "待执行"} passing={task.reviewVerdict === "approve" ? true : task.reviewVerdict ? false : undefined} />
              <EvidenceValue value={task.testVerdict ?? "待执行"} passing={task.testVerdict === "approve" ? true : task.testVerdict ? false : undefined} />
              <code>{task.commit?.slice(0, 9) ?? "-"}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function EvidenceValue({ value, passing }: { value: string; passing: boolean | undefined }) {
  return <span className={passing === true ? "value-pass" : passing === false ? "value-fail" : "value-pending"}>{value}</span>;
}

function readinessLabel(readiness: RunEvidence["readiness"]): string {
  return readiness === "ready" ? "可交付" : readiness === "attention" ? "需要处理" : "证据生成中";
}

function artifactLabel(kind: RunEvidence["artifacts"][number]["kind"]): string {
  return { context: "上下文", "agent-output": "Agent 输出", quality: "质量命令", review: "代码审查", test: "测试审查", other: "其他" }[kind];
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
