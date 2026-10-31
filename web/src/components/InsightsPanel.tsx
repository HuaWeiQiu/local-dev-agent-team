import { useState } from "react";
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

export function InsightsPanel({ insights }: { insights: RunInsights }) {
  const [view, setView] = useState<InsightView>("why");
  const { explanation, usage, replay, transcripts, error, loading, loadTranscript } = insights;

  return (
    <section aria-label="运行洞察" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Tabs value={view} onValueChange={(value) => setView(value as InsightView)} className="px-4 pt-2 md:px-6">
        <TabsList role="tablist" aria-label="洞察视图">
          {views.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>{label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {error && <p role="alert" className="m-0 mb-3 text-xs text-danger-ink">{error}</p>}
        {view === "why" && (explanation ? <WhyView explanation={explanation} /> : <Pending loading={loading} />)}
        {view === "cost" && (usage ? <CostView usage={usage} /> : <Pending loading={loading} />)}
        {view === "talk" && (transcripts ? <TranscriptView transcripts={transcripts} onLoad={loadTranscript} /> : <Pending loading={loading} />)}
        {view === "replay" && (replay ? <ReplayView steps={replay} /> : <Pending loading={loading} />)}
      </div>
    </section>
  );
}

function Pending({ loading }: { loading: boolean }) {
  return <EmptyState size="inline" title={loading ? "正在汇总…" : "暂无数据"} {...(loading ? { role: "status" as const } : {})} />;
}
