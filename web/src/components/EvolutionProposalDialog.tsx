import { Braces, FileText, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toBlueprintDefinition, utf8ByteLength } from "../evolution";
import { agentRoleLabel, strategyDisplayName } from "../presentation";
import { useModalKeyboard } from "../useModalKeyboard";
import type { EvolutionSnapshot, PublicConfig, StrategyBlueprintDefinition } from "../types";

export type EvolutionProposalInput =
  | { kind: "strategy"; name: string; definition: StrategyBlueprintDefinition; commandId: string }
  | { kind: "prompt"; role: string; content: string; commandId: string };

interface EvolutionProposalDialogProps {
  open: boolean;
  config: PublicConfig;
  snapshot: EvolutionSnapshot;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: EvolutionProposalInput): Promise<void>;
}

export function EvolutionProposalDialog({
  open,
  config,
  snapshot,
  busy,
  error,
  onClose,
  onSubmit,
}: EvolutionProposalDialogProps) {
  const dialogRef = useModalKeyboard(open, busy, onClose);
  const strategyNames = useMemo(() => Object.keys(config.strategies.definitions).sort(), [config]);
  const [kind, setKind] = useState<"strategy" | "prompt">("strategy");
  const [sourceName, setSourceName] = useState(config.strategies.default);
  const [targetName, setTargetName] = useState(`${config.strategies.default}-evolved`);
  const [topology, setTopology] = useState<"parallel-dag" | "sequential">("parallel-dag");
  const [maxParallel, setMaxParallel] = useState(2);
  const [maxReworkAttempts, setMaxReworkAttempts] = useState(2);
  const [role, setRole] = useState(snapshot.promptRoles[0]?.role ?? "");
  const [content, setContent] = useState("");
  const [commandId, setCommandId] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    const defaultName = config.strategies.default;
    const definition = config.strategies.definitions[defaultName];
    setKind("strategy");
    setSourceName(defaultName);
    setTargetName(`${defaultName}-evolved`);
    setTopology(definition?.topology?.mode ?? "parallel-dag");
    setMaxParallel(definition?.maxParallel ?? config.project.maxParallel);
    setMaxReworkAttempts(definition?.maxReworkAttempts ?? 2);
    setRole(snapshot.promptRoles[0]?.role ?? "");
    setContent("");
    setCommandId(crypto.randomUUID());
    setSubmitted(false);
  }, [config, open, snapshot.promptRoles]);

  if (!open) return null;
  const byteLength = utf8ByteLength(content);
  const targetNameValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(targetName);
  const strategyLimitsValid = Number.isInteger(maxParallel)
    && maxParallel >= 1
    && maxParallel <= 32
    && Number.isInteger(maxReworkAttempts)
    && maxReworkAttempts >= 0
    && maxReworkAttempts <= 10;
  const canSubmit = kind === "strategy"
    ? Boolean(targetNameValid && strategyLimitsValid && config.strategies.definitions[sourceName])
    : Boolean(role && content.trim() && byteLength <= 262_144);

  const changeSource = (name: string) => {
    const definition = config.strategies.definitions[name];
    setSourceName(name);
    setTargetName(`${name}-evolved`);
    setTopology(definition?.topology?.mode ?? "parallel-dag");
    setMaxParallel(definition?.maxParallel ?? config.project.maxParallel);
    setMaxReworkAttempts(definition?.maxReworkAttempts ?? 2);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitted(true);
    if (kind === "prompt") {
      void onSubmit({ kind, role, content, commandId });
      return;
    }
    const source = config.strategies.definitions[sourceName];
    if (!source) return;
    const definition = toBlueprintDefinition(source);
    definition.topology = { mode: topology };
    definition.maxParallel = maxParallel;
    definition.maxReworkAttempts = maxReworkAttempts;
    void onSubmit({ kind, name: targetName.trim(), definition, commandId });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="evolution-proposal-dialog" role="dialog" aria-modal="true" aria-labelledby="evolution-proposal-title" tabIndex={-1}>
        <header>
          <div><span className="section-kicker">新建候选</span><h2 id="evolution-proposal-title">新建演进候选</h2></div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <form onSubmit={submit}>
          <div className="evolution-kind-switch" role="group" aria-label="候选类型">
            <button type="button" aria-pressed={kind === "strategy"} className={kind === "strategy" ? "is-active" : ""} onClick={() => setKind("strategy")} disabled={busy || submitted}><Braces size={16} />执行策略</button>
            <button type="button" aria-pressed={kind === "prompt"} className={kind === "prompt" ? "is-active" : ""} onClick={() => setKind("prompt")} disabled={busy || submitted || snapshot.promptRoles.length === 0}><FileText size={16} />角色提示词</button>
          </div>
          {kind === "strategy" ? (
            <div className="evolution-form-grid">
              <label><span>基于已有策略</span><select aria-label="基于已有策略" value={sourceName} disabled={busy || submitted} onChange={(event) => changeSource(event.target.value)}>{strategyNames.map((name) => <option value={name} key={name}>{strategyDisplayName(name)}</option>)}</select></label>
              <label><span>候选策略名称</span><input aria-label="候选策略名称" value={targetName} maxLength={64} disabled={busy || submitted} onChange={(event) => setTargetName(event.target.value)} autoFocus /></label>
              {!targetNameValid && targetName.length > 0 && <p className="evolution-field-error">名称需以字母或数字开头，只能包含字母、数字、点、下划线和连字符。</p>}
              <label><span>执行拓扑</span><select aria-label="执行拓扑" value={topology} disabled={busy || submitted} onChange={(event) => setTopology(event.target.value as typeof topology)}><option value="parallel-dag">依赖并行</option><option value="sequential">顺序执行</option></select></label>
              <label><span>最大并行数</span><input aria-label="最大并行数" type="number" min={1} max={32} value={maxParallel} disabled={busy || submitted} onChange={(event) => setMaxParallel(Number(event.target.value))} /></label>
              <label><span>最多返工次数</span><input aria-label="最多返工次数" type="number" min={0} max={10} value={maxReworkAttempts} disabled={busy || submitted} onChange={(event) => setMaxReworkAttempts(Number(event.target.value))} /></label>
            </div>
          ) : (
            <div className="evolution-prompt-form">
              <label><span>角色</span><select aria-label="提示词角色" value={role} disabled={busy || submitted} onChange={(event) => setRole(event.target.value)}>{snapshot.promptRoles.map((item) => <option value={item.role} key={item.role}>{agentRoleLabel(item.role)}</option>)}</select></label>
              <label><span>提示词内容</span><textarea aria-label="提示词内容" rows={13} value={content} disabled={busy || submitted} onChange={(event) => setContent(event.target.value)} autoFocus spellCheck={false} /></label>
              <span className={byteLength > 262_144 ? "byte-count is-over" : "byte-count"}>{byteLength.toLocaleString("zh-CN")} / 262,144 字节</span>
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="button primary" disabled={busy || !canSubmit}><Plus size={16} />{busy ? "提交中" : submitted ? "重试原候选" : "创建候选"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
