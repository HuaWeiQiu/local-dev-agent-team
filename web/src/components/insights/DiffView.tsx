import { useState } from "react";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import type { TaskDiff } from "../../types";

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-muted";
  }
  if (line.startsWith("@@")) return "bg-info-soft text-info-ink";
  if (line.startsWith("+")) return "bg-success-soft text-success-ink";
  if (line.startsWith("-")) return "bg-danger-soft text-danger-ink";
  return "text-ink-2";
}

export function DiffBody({ diff }: { diff: TaskDiff }) {
  if (!diff.available || !diff.content) {
    return <p className="m-0 text-xs text-muted">{diff.detail ?? "没有可显示的改动"}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-2xs text-muted">
        {diff.changedFiles.length} 个文件 · {diff.source === "commit" ? "已提交" : "工作区暂存"}
        {diff.truncated ? " · 已截断" : ""}
      </p>
      <pre aria-label="任务改动" className="scroll-thin m-0 max-h-96 overflow-auto rounded-md bg-surface-2 p-0 font-mono text-2xs leading-relaxed">
        {diff.content.split("\n").map((line, index) => (
          <span key={index} className={cn("block whitespace-pre px-2", lineClass(line))}>{line || " "}</span>
        ))}
      </pre>
    </div>
  );
}

/** Loads the diff on demand so opening a task never costs a Git call. */
export function TaskDiffSection({ taskId, onLoad }: { taskId: string; onLoad(taskId: string): Promise<TaskDiff> }) {
  const [state, setState] = useState<{ diff?: TaskDiff; error?: string; loading: boolean; forTask?: string }>({ loading: false });
  const current = state.forTask === taskId ? state : { loading: false };

  const load = () => {
    setState({ loading: true, forTask: taskId });
    onLoad(taskId).then(
      (diff) => setState({ diff, loading: false, forTask: taskId }),
      (cause: unknown) => setState({ error: cause instanceof Error ? cause.message : String(cause), loading: false, forTask: taskId }),
    );
  };

  if (current.diff) return <DiffBody diff={current.diff} />;
  return (
    <div className="flex flex-col items-start gap-2">
      {current.error && <p role="alert" className="m-0 text-xs text-danger-ink">{current.error}</p>}
      <Button variant="secondary" size="sm" onClick={load} disabled={current.loading}>
        {current.loading ? "正在读取…" : "查看改动"}
      </Button>
    </div>
  );
}
