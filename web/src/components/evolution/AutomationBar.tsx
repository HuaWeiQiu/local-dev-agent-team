import { Bot } from "lucide-react";
import { useState } from "react";
import type { AutomaticEvolutionSnapshot } from "../../types";
import { Badge } from "../../ui/badge";
import { StatusDot } from "../../ui/status";
import {
  isAutomationActive,
  automationNote,
  noteIsError,
  showFooter,
} from "./automation/model";
import {
  AutomationControls,
  AutomationFooter,
  AutomationMetrics,
} from "./automation/sections";
import { automationStatusLabel, automationStatusText, automationTone } from "./format";

interface AutomationBarProps {
  automation: AutomaticEvolutionSnapshot;
  requestedCycles: number;
  busy: boolean;
  startIntentPending: boolean;
  mutationLocked: boolean;
  onCyclesChange(value: number): void;
  onStart(): void;
  onStop(): void;
}

export function AutomationBar({
  automation,
  requestedCycles,
  busy,
  startIntentPending,
  mutationLocked,
  onCyclesChange,
  onStart,
  onStop,
}: AutomationBarProps) {
  const [cyclesOpen, setCyclesOpen] = useState(false);
  const tone = automationTone(automation.status);
  const note = automationNote(automation);

  return (
    <section aria-label="自动演进控制" className="bd-b shrink-0 bg-surface">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 md:px-6">
        <AutomationHeading automation={automation} tone={tone} />
        {automation.enabled && (
          <AutomationMetrics automation={automation} requestedCycles={requestedCycles} />
        )}
        <AutomationControls
          automation={automation}
          requestedCycles={requestedCycles}
          active={isAutomationActive(automation)}
          busy={busy}
          mutationLocked={mutationLocked}
          startIntentPending={startIntentPending}
          onCyclesChange={onCyclesChange}
          onStart={onStart}
          onStop={onStop}
        />
      </div>
      {showFooter(automation) && (
        <AutomationFooter
          automation={automation}
          note={note}
          isError={noteIsError(automation)}
          open={cyclesOpen}
          onToggle={() => setCyclesOpen((value) => !value)}
        />
      )}
    </section>
  );
}

function AutomationHeading({
  automation,
  tone,
}: {
  automation: AutomaticEvolutionSnapshot;
  tone: ReturnType<typeof automationTone>;
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink [&_svg]:size-[18px]">
        <Bot />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="text-sm font-semibold text-ink">自动演进</strong>
          <Badge tone={tone}>
            <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
            {automationStatusLabel(automation.status)}
          </Badge>
        </div>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {automation.enabled ? automationStatusText(automation) : "当前项目未启用"}
        </span>
      </div>
    </div>
  );
}
