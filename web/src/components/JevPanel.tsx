import { Cpu, LoaderCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getConfig, probeJev } from "../api";
import { errorMessage, jevProbeSummary, jevStatusLabel } from "../presentation";
import type { JevProbeResult, JevSettings, ProjectScope } from "../types";

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

  return (
    <section className="settings-panel jev-panel" aria-label="Jev 本地分流模型">
      <div className="settings-panel-head">
        <Cpu size={18} />
        <div>
          <h2>Jev 本地分流模型</h2>
          <small>任务失败后判断「直接重试」还是「先问架构顾问」；只给建议，不能放行失败的检查</small>
        </div>
        <span className={`jev-status is-${status.tone}`}>{status.label}</span>
      </div>

      {loadError && <p className="jev-note is-error">{loadError}</p>}

      {jev ? (
        <>
          <dl className="jev-config">
            <div><dt>地址</dt><dd className="mono">{jev.baseUrl}</dd></div>
            <div><dt>模型</dt><dd className="mono">{jev.model}</dd></div>
            <div><dt>超时</dt><dd>{jev.timeoutMs} ms</dd></div>
            <div><dt>置信度阈值</dt><dd>{jev.minConfidence.toFixed(2)}（低于它按确定性规则处理）</dd></div>
          </dl>
          <div className="jev-actions">
            <button type="button" className="button secondary" onClick={() => void test()} disabled={testing}>
              {testing ? <LoaderCircle size={16} className="spin" /> : <Zap size={16} />}
              <span>{testing ? "测试中…" : "测试连接"}</span>
            </button>
            <small>
              用一条模拟失败请求模型，检查接口、输出格式与耗时；不会改动任何运行。
              {!jev.enabled && "当前未启用，把 agent-team.yaml 中 jev.enabled 改为 true 后生效。"}
            </small>
          </div>
          {result && (
            <p className={`jev-note ${result.ok ? "is-ok" : "is-error"}`} role="status">
              {jevProbeSummary(result)}
            </p>
          )}
          {probeError && <p className="jev-note is-error" role="status">{probeError}</p>}
        </>
      ) : (
        jev === null && (
          <div className="jev-empty">
            <p>当前项目的 agent-team.yaml 没有 jev 配置。要接入本机 OpenAI 兼容模型，加入：</p>
            <pre>{CONFIG_HINT}</pre>
            <small>地址只允许 localhost / 127.x / ::1；不保存任何密钥。</small>
          </div>
        )
      )}
    </section>
  );
}
