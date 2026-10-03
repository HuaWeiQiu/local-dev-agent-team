import { Bot, CircleHelp, Hand, Send, Square, User } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { buildAgentFeed, type FeedEntry } from "../agent-feed";
import type { LiveAgentControls } from "../hooks/useLiveAgents";
import { agentRoleLabel, formatTimestamp } from "../presentation";
import type { LiveAgent, LiveAgentQuestion, RunEvent } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Callout, Input } from "../ui/form";
import { EmptyState } from "./EmptyState";

interface AgentsPanelProps {
  events: RunEvent[];
  controls: LiveAgentControls;
  runActive: boolean;
}

export function AgentsPanel({ events, controls, runActive }: AgentsPanelProps) {
  const { agents, actor, setActor, error } = controls;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2" htmlFor="operator-name">
          操作者
          <Input
            id="operator-name"
            className="w-48"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            maxLength={200}
            placeholder="用于审计记录"
          />
        </label>
        <p className="m-0 min-w-0 flex-1 basis-64 text-xs leading-relaxed text-muted">
          实时对话仅对支持会话的智能体开放（Codex、Claude）。引导会注入当前轮次；中断后可附带新指令让它接着做。
        </p>
      </div>
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {agents.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title={runActive ? "当前没有运行中的智能体" : "运行未在执行"}
          hint={runActive ? "智能体启动后会出现在这里，你可以引导、中断或回答它的提问。" : "运行结束后可在活动日志中回看每个智能体的输出。"}
        />
      ) : (
        agents.map((agent) => <AgentCard key={agent.id} agent={agent} events={events} controls={controls} />)
      )}
    </div>
  );
}

function AgentCard({ agent, events, controls }: { agent: LiveAgent; events: RunEvent[]; controls: LiveAgentControls }) {
  const feed = useMemo(() => buildAgentFeed(events, agent), [events, agent]);
  const [steerText, setSteerText] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [note, setNote] = useState("");
  const { capabilities } = agent;

  const submitSteer = async (event: FormEvent) => {
    event.preventDefault();
    if (!steerText.trim()) return;
    if (await controls.steer(agent, steerText.trim())) setSteerText("");
  };
  const submitInterrupt = async () => {
    if (await controls.interrupt(agent, note)) {
      setRedirecting(false);
      setNote("");
    }
  };

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4" aria-label={`${agentRoleLabel(agent.role)}智能体`}>
      <header className="flex flex-wrap items-center gap-2">
        <Bot aria-hidden className="size-4 text-accent" />
        <strong className="text-sm text-ink">{agentRoleLabel(agent.role)}</strong>
        {agent.taskId ? <Badge tone="neutral">任务 {agent.taskId}</Badge> : null}
        <Badge tone={agent.status === "awaiting-answer" ? "warning" : "active"}>
          {agent.status === "awaiting-answer" ? "等待回答" : "执行中"}
        </Badge>
        <span className="text-xs text-muted">{agent.adapter} · {agent.model} · {agent.profile}</span>
        <span className="ml-auto flex gap-1">
          <Capability enabled={capabilities.steer} label="可引导" />
          <Capability enabled={capabilities.interrupt} label="可中断" />
          <Capability enabled={capabilities.askUser} label="可提问" />
        </span>
      </header>

      <Conversation feed={feed} />

      {agent.questions.map((question) => (
        <QuestionForm key={question.questionId} question={question} pending={controls.pending} onAnswer={(answer) => controls.answer(agent, question.questionId, answer)} />
      ))}

      {capabilities.steer ? (
        <form onSubmit={(event) => void submitSteer(event)} className="flex gap-2">
          <Input
            aria-label={`引导${agentRoleLabel(agent.role)}`}
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            placeholder="给它补充一条指令，立即注入当前轮次"
            maxLength={8_000}
          />
          <Button type="submit" variant="primary" disabled={controls.pending || !steerText.trim()}>
            <Send />引导
          </Button>
        </form>
      ) : (
        <Callout tone="info">该智能体使用一次性调用，无法中途引导；如需干预请取消运行。</Callout>
      )}

      {capabilities.interrupt ? (
        redirecting ? (
          <div className="flex flex-col gap-2 rounded-md bg-warning-soft p-3">
            <label className="text-xs font-medium text-warning-ink" htmlFor={`note-${agent.id}`}>
              中断并改道（留空则直接结束本次尝试，任务进入返工）
            </label>
            <Input id={`note-${agent.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="新的指令（可选）" maxLength={8_000} />
            <div className="flex gap-2">
              <Button variant="warning" disabled={controls.pending} onClick={() => void submitInterrupt()}>
                <Square />{note.trim() ? "中断并改道" : "中断并结束尝试"}
              </Button>
              <Button variant="ghost" onClick={() => setRedirecting(false)}>取消</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="warning" size="sm" onClick={() => setRedirecting(true)}>
              <Hand />中断…
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}

function Capability({ enabled, label }: { enabled: boolean; label: string }) {
  return <Badge tone={enabled ? "success" : "neutral"} className={cn(!enabled && "opacity-60")}>{label}</Badge>;
}

const feedStyles: Record<FeedEntry["kind"], { label: string; className: string }> = {
  output: { label: "智能体", className: "bg-surface-2 text-ink" },
  steer: { label: "引导", className: "bg-accent-soft text-accent-ink" },
  interrupt: { label: "中断", className: "bg-warning-soft text-warning-ink" },
  question: { label: "提问", className: "bg-info-soft text-info-ink" },
  answer: { label: "回答", className: "bg-accent-soft text-accent-ink" },
};

function Conversation({ feed }: { feed: FeedEntry[] }) {
  if (feed.length === 0) {
    return <p className="m-0 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">暂无输出，智能体正在准备。</p>;
  }
  return (
    <ol className="scroll-thin m-0 flex max-h-72 list-none flex-col gap-1.5 overflow-auto p-0" aria-label="对话记录">
      {feed.slice(-40).map((entry) => (
        <li key={entry.id} className={cn("rounded-md px-3 py-2 text-xs leading-relaxed", feedStyles[entry.kind].className)}>
          <div className="mb-0.5 flex items-center gap-1.5 text-2xs font-medium opacity-80">
            {entry.kind === "output" ? <Bot className="size-3" aria-hidden /> : <User className="size-3" aria-hidden />}
            {feedStyles[entry.kind].label}
            {entry.actor ? ` · ${entry.actor}` : ""}
            <span className="ml-auto font-normal">{formatTimestamp(entry.at)}</span>
          </div>
          <pre className="m-0 whitespace-pre-wrap break-words font-[inherit]">{entry.text}</pre>
        </li>
      ))}
    </ol>
  );
}

function QuestionForm({
  question,
  pending,
  onAnswer,
}: {
  question: LiveAgentQuestion;
  pending: boolean;
  onAnswer(answer: string): Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");
  const submit = async (value: string) => {
    if (await onAnswer(value)) setAnswer("");
  };
  return (
    <div role="group" aria-label="智能体提问" className="flex flex-col gap-2 rounded-md border border-solid border-warning/40 bg-warning-soft p-3">
      <strong className="flex items-center gap-1.5 text-sm text-warning-ink">
        <CircleHelp className="size-4" aria-hidden />{question.prompt}
      </strong>
      {question.options && question.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <Button key={option} variant="secondary" size="sm" disabled={pending} onClick={() => void submit(option)}>{option}</Button>
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) void submit(answer.trim());
        }}
      >
        <Input
          aria-label="你的回答"
          type={question.secret ? "password" : "text"}
          autoComplete="off"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={question.secret ? "保密回答，不会写入记录" : "输入回答"}
          maxLength={8_000}
        />
        <Button type="submit" variant="primary" disabled={pending || !answer.trim()}>回答</Button>
      </form>
    </div>
  );
}
