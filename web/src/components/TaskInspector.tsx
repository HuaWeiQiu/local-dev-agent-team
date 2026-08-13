import { CheckCircle2, Clock3, FileCode2, Gauge, GitBranch, History, ShieldAlert, TerminalSquare, UserRound } from "lucide-react";
import { memo } from "react";
import {
  acceptanceSummary,
  completenessBarCopy,
  planCompletenessForRun,
  taskKind,
  taskKindLabel,
} from "../plan-completeness";
import { agentRoleLabel, formatBytes, humanizeFailure, profileDisplayName, strategyDisplayName } from "../presentation";
import type { RunState, TaskRunState } from "../types";
import { RunStatusBadge, TaskStatusBadge } from "./StatusBadge";

interface TaskInspectorProps {
  run: RunState | undefined;
  task: TaskRunState | undefined;
}

export const TaskInspector = memo(function TaskInspector({ run, task }: TaskInspectorProps) {
  return (
    <aside className="task-inspector" aria-label="任务详情">
      <div className="section-heading inspector-heading">
        <div>
          <span className="section-kicker">详情</span>
          <h2>{task ? "任务详情" : "运行详情"}</h2>
        </div>
        {task ? <TaskStatusBadge status={task.status} /> : run ? <RunStatusBadge status={run.status} /> : null}
      </div>
      {task && run ? <TaskDetail task={task} run={run} /> : task ? <TaskDetail task={task} /> : run ? <RunDetail run={run} /> : <div className="inspector-empty">未选择运行</div>}
    </aside>
  );
});

function TaskDetail({ task, run }: { task: TaskRunState; run?: RunState }) {
  const kind = taskKind(task.task);
  return (
    <div className="inspector-scroll">
      <section className="detail-section">
        <code className="detail-id">{task.task.id}</code>
        <h3>{task.task.title}</h3>
        <p>{task.task.description}</p>
      </section>
      <section className="detail-section">
        <h4><FileCode2 size={15} />计划合同</h4>
        <dl className="detail-list">
          <div><dt>类型</dt><dd>{taskKindLabel(kind)}</dd></div>
          <div><dt>依赖</dt><dd>{task.task.dependsOn.length > 0 ? task.task.dependsOn.join(", ") : "无"}</dd></div>
          <div><dt>验收</dt><dd>{acceptanceSummary(task.task)}</dd></div>
          <div><dt>证据</dt><dd>{task.task.evidenceKind === "host-evidence" ? "实机证据" : "仓库命令 / 审查"}</dd></div>
        </dl>
      </section>
      <section className="detail-section">
        <h4><GitBranch size={15} />执行</h4>
        <dl className="detail-list">
          <div><dt>配置</dt><dd title={task.profile ?? task.task.profile ?? undefined}>{profileDisplayName(task.profile ?? task.task.profile ?? "策略分配")}</dd></div>
          {task.task.batchKey ? <div><dt>批次</dt><dd><code>{task.task.batchKey}</code></dd></div> : null}
          <div><dt>尝试次数</dt><dd>{task.attempts}</dd></div>
          {task.branch && <div><dt>分支</dt><dd><code>{task.branch}</code></dd></div>}
          {task.commit && <div><dt>提交</dt><dd><code>{task.commit.slice(0, 10)}</code></dd></div>}
        </dl>
      </section>
      <section className="detail-section">
        <h4><FileCode2 size={15} />负责路径</h4>
        <div className="code-list">{task.task.ownedPaths.map((item) => <code key={item}>{item}</code>)}</div>
      </section>
      <section className="detail-section">
        <h4><TerminalSquare size={15} />质量命令</h4>
        {task.quality ? (
          <div className="quality-list">
            {task.quality.commands.map((command, index) => (
              <div key={`${command.spec.command}-${index}`}>
                <span className={command.exitCode === 0 ? "quality-pass" : "quality-fail"}>
                  {command.exitCode === 0 ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                </span>
                <code>{[command.spec.command, ...command.spec.args].join(" ")}</code>
                <small>{command.durationMs} ms</small>
              </div>
            ))}
          </div>
        ) : <p className="muted">尚未执行</p>}
      </section>
      {(task.review || task.test) && (
        <section className="detail-section">
          <h4><ShieldAlert size={15} />审查结论</h4>
          {task.review && <Verdict label="代码审查" verdict={task.review.verdict} summary={task.review.summary} />}
          {task.test && <Verdict label="测试审查" verdict={task.test.verdict} summary={task.test.summary} />}
          {task.review?.findings.map((finding, index) => (
            <div className={`finding severity-${finding.severity}`} key={`${finding.path}-${index}`}>
              <strong>{finding.severity}</strong>
              <span>{finding.message}</span>
              <code>{finding.path}{finding.line ? `:${finding.line}` : ""}</code>
            </div>
          ))}
        </section>
      )}
      {task.error && <p className="inline-error">{humanizeFailure(task.error)}</p>}
      {run?.error && run.error !== task.error ? (
        <p className="inline-error">{describeRunFailure(run)}</p>
      ) : null}
    </div>
  );
}

function checkpointLabel(stage: string): string {
  return {
    "plan-ready": "计划完成",
    "task-wave-integrated": "任务波次已合并",
    "tasks-complete": "任务全部完成",
    "local-gates-passed": "本地门禁通过",
  }[stage] ?? stage;
}

function RunDetail({ run }: { run: RunState }) {
  const planReport = planCompletenessForRun(run);
  return (
    <div className="inspector-scroll">
      <section className="detail-section">
        <code className="detail-id">{run.id}</code>
        <h3>{run.goal}</h3>
        {run.plan && <p>{run.plan.summary}</p>}
      </section>
      {planReport ? (
        <section className="detail-section">
          <h4><CheckCircle2 size={15} />计划完备</h4>
          <p className={`completeness-inline tone-${completenessBarCopy(planReport).tone}`}>
            {completenessBarCopy(planReport).title}
          </p>
          {planReport.namedDeliverables.length > 0 && (
            <p className="muted">覆盖 {planReport.coveredDeliverables.join(", ") || "无"} / {planReport.namedDeliverables.join(", ")}</p>
          )}
          {planReport.issues.length > 0 && (
            <ul className="completeness-issues">
              {planReport.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </section>
      ) : null}
      {run.finalQuality && !run.finalQuality.passed ? (
        <section className="detail-section">
          <h4><ShieldAlert size={15} />集成质量门</h4>
          <p className="inline-error">{describeRunFailure(run)}</p>
        </section>
      ) : null}
      <section className="detail-section">
        <h4><GitBranch size={15} />策略</h4>
        <dl className="detail-list">
          <div><dt>名称</dt><dd title={run.strategy.name}>{strategyDisplayName(run.strategy.name)}</dd></div>
          <div><dt>并行上限</dt><dd>{run.strategy.maxParallel}</dd></div>
          <div><dt>Swarm 并发</dt><dd>{run.strategy.swarmMaxConcurrency ?? run.strategy.maxParallel}</dd></div>
          <div><dt>代码探索</dt><dd>{run.strategy.explore?.enabled ? "已启用" : "关闭"}</dd></div>
          <div><dt>返工上限</dt><dd>{run.strategy.maxReworkAttempts}</dd></div>
          {run.parentRunId && <div><dt>来源运行</dt><dd><code>{run.parentRunId}</code></dd></div>}
        </dl>
      </section>
      <section className="detail-section">
        <h4><CheckCircle2 size={15} />角色分配</h4>
        <dl className="detail-list">
          {Object.entries({ ...run.strategy.roleProfiles, ...run.profileOverrides }).map(([role, profile]) => {
            const binding = run.roleBindings?.[role];
            return (
              <div key={role}><dt>{agentRoleLabel(role)}</dt><dd title={profile}>
                {binding
                  ? `${binding.cli} · ${binding.model ?? "默认模型"}${binding.reasoning ? ` · ${binding.reasoning}` : ""}`
                  : profileDisplayName(profile)}
              </dd></div>
            );
          })}
          {Object.keys(run.strategy.roleProfiles).length === 0 && Object.keys(run.profileOverrides).length === 0 && (
            <div><dt>配置</dt><dd>使用角色默认值</dd></div>
          )}
        </dl>
        {run.roleBindings && Object.keys(run.roleBindings).length > 0 && (
          <small className="detail-hint">CLI 绑定：本次运行按全局/选型配置使用了上述 CLI 与模型</small>
        )}
      </section>
      {run.approvals && run.approvals.length > 0 && (
        <section className="detail-section">
          <h4><UserRound size={15} />人工审批</h4>
          <div className="approval-history">
            {[...run.approvals].reverse().map((approval) => (
              <div key={approval.id} className={`approval-record is-${approval.status}`}>
                <div>
                  <strong>{approval.gate === "plan" ? "执行计划" : "交付结果"}</strong>
                  <span>{approval.status === "pending" ? "待处理" : approval.status === "approved" ? "已批准" : "已拒绝"}</span>
                </div>
                <p>{approval.summary}</p>
                {approval.response ? (
                  <small>{approval.response.actor} · {approval.response.reason}</small>
                ) : (
                  <small><Clock3 size={11} />{new Date(approval.expiresAt).toLocaleString("zh-CN")}</small>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {run.checkpoints && run.checkpoints.length > 0 && (
        <section className="detail-section">
          <h4><History size={15} />恢复边界</h4>
          <dl className="detail-list">
            <div><dt>阶段</dt><dd>{checkpointLabel(run.checkpoints.at(-1)!.stage)}</dd></div>
            <div><dt>集成提交</dt><dd><code>{run.checkpoints.at(-1)!.integrationCommit.slice(0, 10)}</code></dd></div>
            <div><dt>已完成任务</dt><dd>{run.checkpoints.at(-1)!.completedTaskIds.length}</dd></div>
            <div><dt>恢复次数</dt><dd>{run.resumeCount ?? 0}</dd></div>
          </dl>
        </section>
      )}
      <section className="detail-section">
        <h4><Gauge size={15} />资源与追踪</h4>
        <dl className="detail-list">
          <div><dt>角色调用</dt><dd>{run.usage?.agentInvocations ?? 0} / {run.strategy.maxAgentInvocations ?? 64}</dd></div>
          <div><dt>角色耗时</dt><dd>{formatDuration(run.usage?.agentDurationMs ?? 0)}</dd></div>
          <div><dt>输出捕获</dt><dd>{formatBytes(run.usage?.processOutputBytes ?? 0)}</dd></div>
          <div><dt>运行产物</dt><dd>{formatBytes(run.usage?.artifactBytes ?? 0)} / {formatBytes(run.strategy.maxArtifactBytes ?? 1_073_741_824)}</dd></div>
          <div><dt>截断流</dt><dd>{run.usage?.truncatedStreams ?? 0}</dd></div>
          {(run.usage?.inputTokens !== undefined || run.usage?.outputTokens !== undefined) && (
            <div><dt>已报告 Token</dt><dd>{(run.usage.inputTokens ?? 0).toLocaleString()} 入 / {(run.usage.outputTokens ?? 0).toLocaleString()} 出</dd></div>
          )}
          {run.usage?.reportedCostUsd !== undefined && (
            <div><dt>已报告成本</dt><dd>${run.usage.reportedCostUsd.toFixed(4)}</dd></div>
          )}
          <div><dt>Trace ID</dt><dd><code>{run.traceId ?? "加载事件后生成"}</code></dd></div>
        </dl>
      </section>
      {run.finalDecision && (
        <section className="detail-section">
          <h4><ShieldAlert size={15} />最终判定</h4>
          <Verdict label={run.finalDecision.decision} verdict={run.finalDecision.decision} summary={run.finalDecision.reason} />
        </section>
      )}
      {run.error && <p className="inline-error">{humanizeFailure(run.error)}</p>}
    </div>
  );
}

function describeRunFailure(run: RunState): string {
  const failed = run.finalQuality?.commands?.find((command) => command.exitCode !== 0);
  const detail = [failed?.stderr, failed?.stdout].find((chunk) => chunk?.trim());
  if (run.error?.startsWith("Integration quality commands failed") || (run.finalQuality && !run.finalQuality.passed)) {
    const hint = detail?.replace(/\s+/g, " ").trim();
    if (hint) {
      return `任务已合并，集成质量门失败：${hint.slice(0, 240)}`;
    }
    return "任务已合并，集成质量门失败（请检查 integration worktree 是否缺依赖）";
  }
  return humanizeFailure(run.error);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function Verdict({ label, verdict, summary }: { label: string; verdict: string; summary: string }) {
  const passing = ["approve", "ready"].includes(verdict);
  return (
    <div className={`verdict ${passing ? "is-passing" : "is-failing"}`}>
      <span>{label}</span>
      <strong>{verdict}</strong>
      <p>{summary}</p>
    </div>
  );
}
