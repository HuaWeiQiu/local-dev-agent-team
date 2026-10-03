import { Cpu, LoaderCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getConfig, probeJev } from "../api";
import { errorMessage, jevProbeSummary, jevStatusLabel } from "../presentation";
import type { JevProbeResult, JevSettings, ProjectScope } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Callout } from "../ui/form";
import { PanelHeader, SettingsSection } from "./PanelHeader";

const CONFIG_HINT = `jev:
  enabled: true
  baseUrl: http://127.0.0.1:<端口>/v1
  model: <模型名>`;

export function JevPanel({ scope }: { scope: ProjectScope }) {
  const [jev, setJev] = useState<JevSettings | null>();
  const [loadError, setLoadError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<JevProbeResult>();
  const [probeError, setProbeError] = useState<string>();

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      setJev((await getConfig(scope)).jev ?? null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [scope]);

  useEffect(() => {
    setResult(undefined);
    setProbeError(undefined);
    void load();
  }, [load]);

  const test = async () => {
    setTesting(true);
    setResult(undefined);
    setProbeError(undefined);
    try {
      setResult(await probeJev(scope));
    } catch (error) {
      setProbeError(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const status = jevStatusLabel(jev);
  const statusTone = status.tone === "on" ? "success" : status.tone === "off" ? "warning" : "neutral";

  return (
    <SettingsSection aria-label="Jev 本地分流模型">
      <PanelHeader
        icon={<Cpu />}
        title="Jev 本地分流模型"
        subtitle="任务失败后判断「直接重试」还是「先问架构顾问」；只给建议，不能放行失败的检查"
        actions={<Badge tone={statusTone}>{status.label}</Badge>}
      />

      {loadError && <Callout tone="danger">{loadError}</Callout>}

      {jev ? (
        <>
          <dl className="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="地址" mono>{jev.baseUrl}</Row>
            <Row label="协议">{jev.protocol === "laya" ? "Laya 决策模型" : "OpenAI 兼容对话"}</Row>
            <Row label="模型" mono>{jev.model}</Row>
            <Row label="超时">{jev.timeoutMs} ms</Row>
            <Row label="置信度阈值">{jev.minConfidence.toFixed(2)}（低于它按确定性规则处理）</Row>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void test()} disabled={testing}>
              {testing ? <LoaderCircle className="animate-spin" /> : <Zap />}
              <span>{testing ? "测试中…" : "测试连接"}</span>
            </Button>
            <small className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
              用一条模拟失败请求模型，检查接口、输出格式与耗时；不会改动任何运行。
              {!jev.enabled && "当前未启用，把 agent-team.yaml 中 jev.enabled 改为 true 后生效。"}
            </small>
          </div>
          {result && (
            <Callout tone={result.ok ? "success" : "danger"} role="status">
              {jevProbeSummary(result)}
            </Callout>
          )}
          {probeError && <Callout tone="danger" role="status">{probeError}</Callout>}
        </>
      ) : (
        jev === null && (
          <div className="flex flex-col gap-2 text-sm text-ink-2">
            <p className="m-0">当前项目的 agent-team.yaml 没有 jev 配置。要接入本机 OpenAI 兼容模型，加入：</p>
            <pre className="m-0 overflow-x-auto rounded-lg bg-[var(--terminal-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--terminal-ink)]">{CONFIG_HINT}</pre>
            <small className="text-xs text-muted">地址只允许 localhost / 127.x / ::1；不保存任何密钥。</small>
          </div>
        )
      )}
    </SettingsSection>
  );
}

function Row({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("m-0 min-w-0 break-all text-ink", mono && "font-mono text-xs")}>{children}</dd>
    </div>
  );
}
