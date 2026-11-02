import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { cn } from "../../ui/cn";
import type { ReplayStep } from "../../types";
import { EmptyState } from "../EmptyState";
import { formatDuration, toneDot, toneText } from "./format";

const PLAY_INTERVAL_MS = 450;

function NodeStatusList({ nodes }: { nodes: Array<[string, string]> }) {
  if (nodes.length === 0) return null;
  return (
    <ul aria-label="阶段状态" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {nodes.map(([node, status]) => (
        <li key={node} className="rounded-full bg-surface-3 px-2 py-0.5 text-2xs text-ink-2">
          {node} · {status}
        </li>
      ))}
    </ul>
  );
}

function ReplayControls({
  playing,
  position,
  steps,
  current,
  onToggle,
  onSeek,
}: {
  playing: boolean;
  position: number;
  steps: ReplayStep[];
  current: ReplayStep | undefined;
  onToggle(): void;
  onSeek(position: number): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label={playing ? "暂停回放" : "开始回放"}
        onClick={onToggle}
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </Button>
      <input
        type="range"
        aria-label="回放进度"
        min={0}
        max={steps.length}
        value={position}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <small className="shrink-0 text-xs tabular-nums text-muted">
        {position}/{steps.length}
        {current ? ` · +${formatDuration(current.offsetMs)}` : ""}
      </small>
    </div>
  );
}

function ReplayStepRow({
  step,
  index,
  position,
}: {
  step: ReplayStep;
  index: number;
  position: number;
}) {
  return (
    <li
      aria-current={index === position - 1 ? "step" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-1.5 transition-opacity",
        index >= position && "opacity-35",
        index === position - 1 && "bg-accent-soft",
      )}
    >
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot[step.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("m-0 text-xs leading-snug", toneText[step.tone])}>
          {step.taskId ? <code className="mr-1.5 text-2xs text-accent-ink">{step.taskId}</code> : null}
          {step.title}
        </p>
        {step.detail && (
          <p className="m-0 mt-0.5 break-words text-2xs leading-relaxed text-muted">{step.detail}</p>
        )}
      </div>
      <small className="shrink-0 text-2xs tabular-nums text-muted">
        +{formatDuration(step.offsetMs)}
      </small>
    </li>
  );
}

function ReplayStepList({
  steps,
  position,
}: {
  steps: ReplayStep[];
  position: number;
}) {
  return (
    <Card className="p-2">
      <ol aria-label="回放步骤" className="m-0 flex list-none flex-col p-0">
        {steps.map((step, index) => (
          <ReplayStepRow key={`${step.at}-${index}`} step={step} index={index} position={position} />
        ))}
      </ol>
    </Card>
  );
}

/** Node names and the status they last held while the replay walked through them. */
function useReplayNodes(steps: ReplayStep[], position: number): Array<[string, string]> {
  return useMemo(() => {
    const state = new Map<string, string>();
    for (const step of steps.slice(0, position)) {
      if (step.nodeId) state.set(step.nodeId, step.title.split(" ").at(-1) ?? "");
    }
    return [...state];
  }, [steps, position]);
}

export function ReplayView({ steps }: { steps: ReplayStep[] }) {
  const [position, setPosition] = useState(steps.length);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPosition(steps.length);
    setPlaying(false);
  }, [steps]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setPosition((current) => {
        if (current >= steps.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, steps.length]);

  const nodes = useReplayNodes(steps, position);

  if (steps.length === 0) {
    return (
      <EmptyState
        size="inline"
        title="还没有可回放的过程"
        hint="运行产生事件后，这里可以按时间回看每一步。"
      />
    );
  }
  const current = steps[Math.max(0, position - 1)];
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <ReplayControls
          playing={playing}
          position={position}
          steps={steps}
          current={current}
          onToggle={() => {
            if (!playing && position >= steps.length) setPosition(0);
            setPlaying((value) => !value);
          }}
          onSeek={(next) => {
            setPlaying(false);
            setPosition(next);
          }}
        />
        <NodeStatusList nodes={nodes} />
      </Card>
      <ReplayStepList steps={steps} position={position} />
    </div>
  );
}
