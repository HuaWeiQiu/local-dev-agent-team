import { useState, type ReactElement } from "react";
import type { RunInsights } from "../hooks/useRunInsights";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { EmptyState } from "./EmptyState";
import { CostView } from "./insights/CostView";
import { ReplayView } from "./insights/ReplayView";
import { TranscriptView } from "./insights/TranscriptView";
import { WhyView } from "./insights/WhyView";

type InsightView = "why" | "cost" | "talk" | "replay";

const views: Array<{ value: InsightView; label: string }> = [
  { value: "why", label: "为什么" },
  { value: "cost", label: "成本" },
  { value: "talk", label: "对话" },
  { value: "replay", label: "回放" },
];

/** One body per tab: the view's data when it is there, the pending state otherwise. */
const viewBodies: Record<InsightView, (insights: RunInsights, loading: boolean) => ReactElement> = {
  why: ({ explanation }, loading) =>
    explanation ? <WhyView explanation={explanation} /> : <Pending loading={loading} />,
  cost: ({ usage }, loading) => (usage ? <CostView usage={usage} /> : <Pending loading={loading} />),
  talk: ({ transcripts, loadTranscript }, loading) =>
    transcripts ? (
      <TranscriptView transcripts={transcripts} onLoad={loadTranscript} />
    ) : (
      <Pending loading={loading} />
    ),
  replay: ({ replay }, loading) =>
    replay ? <ReplayView steps={replay} /> : <Pending loading={loading} />,
};

function InsightTabs({ view, onSelect }: { view: InsightView; onSelect(view: InsightView): void }) {
  return (
    <Tabs
      value={view}
      onValueChange={(value) => onSelect(value as InsightView)}
      className="px-4 pt-2 md:px-6"
    >
      <TabsList role="tablist" aria-label="洞察视图">
        {views.map(({ value, label }) => (
          <TabsTrigger key={value} value={value}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function InsightsPanel({ insights }: { insights: RunInsights }) {
  const [view, setView] = useState<InsightView>("why");
  const { error, loading } = insights;
  return (
    <section aria-label="运行洞察" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <InsightTabs view={view} onSelect={setView} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {error && (
          <p role="alert" className="m-0 mb-3 text-xs text-danger-ink">
            {error}
          </p>
        )}
        {viewBodies[view](insights, loading)}
      </div>
    </section>
  );
}

function Pending({ loading }: { loading: boolean }) {
  return (
    <EmptyState
      size="inline"
      title={loading ? "正在汇总…" : "暂无数据"}
      {...(loading ? { role: "status" as const } : {})}
    />
  );
}
