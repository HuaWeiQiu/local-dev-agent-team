import { MessageCircleQuestion, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { askInquiry, deleteInquiry, getInquiries, getInquiry } from "../api";
import { runActionErrorMessage } from "../presentation";
import type { InquiryRecord, ProjectScope, RunState } from "../types";

interface InquiryDrawerProps {
  open: boolean;
  scope?: ProjectScope;
  run?: RunState;
  onClose(): void;
}

export function InquiryDrawer({ open, scope, run, onClose }: InquiryDrawerProps) {
  const [inquiries, setInquiries] = useState<InquiryRecord[]>([]);
  const [question, setQuestion] = useState("");
  const [stage, setStage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pollTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open || !scope || !run) return;
    let cancelled = false;
    const load = () => {
      getInquiries(scope, run.id)
        .then((next) => {
          if (cancelled) return;
          setInquiries(next);
          if (next.some((inquiry) => inquiry.status === "running")) {
            pollTimer.current = window.setTimeout(load, 2_000);
          }
        })
        .catch(() => undefined);
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer.current);
    };
  }, [open, run, scope]);

  if (!open || !scope || !run) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await askInquiry(scope, run.id, {
        question: question.trim(),
        ...(stage ? { stage } : {}),
      });
      setInquiries((current) => [...current, created]);
      setQuestion("");
      pollInquiry(scope, run.id, created.id);
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const pollInquiry = (targetScope: ProjectScope, runId: string, inquiryId: string) => {
    const poll = () => {
      getInquiry(targetScope, runId, inquiryId)
        .then((next) => {
          setInquiries((current) => current.map((item) => (item.id === next.id ? next : item)));
          if (next.status === "running") {
            pollTimer.current = window.setTimeout(poll, 2_000);
          }
        })
        .catch(() => undefined);
    };
    poll();
  };

  const remove = async (inquiryId: string) => {
    setError(undefined);
    try {
      await deleteInquiry(scope, run.id, inquiryId);
      setInquiries((current) => current.filter((item) => item.id !== inquiryId));
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="inquiry-drawer" role="dialog" aria-modal="true" aria-labelledby="inquiry-title">
        <header>
          <div>
            <span className="section-kicker">软分支会话</span>
            <h2 id="inquiry-title">问进度</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <p className="inquiry-hint">只读咨询当前运行快照，不影响正在执行的任务，但会额外消耗一次模型调用额度。会话可单独删除。</p>

        <form onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="inquiry-stage">针对阶段</label>
          <select id="inquiry-stage" value={stage} onChange={(event) => setStage(event.target.value)}>
            <option value="">当前阶段（{run.status}）</option>
            {[...new Set((run.stageSummaries ?? []).map((summary) => summary.stage))].map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <label className="field-label" htmlFor="inquiry-question">问题</label>
          <textarea
            id="inquiry-question"
            value={question}
            rows={3}
            maxLength={2_000}
            placeholder="例如：现在做到哪一步了？"
            onChange={(event) => setQuestion(event.target.value)}
            required
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="button primary" disabled={busy || !question.trim()}>
            <MessageCircleQuestion size={16} />{busy ? "提问中" : "提问"}
          </button>
        </form>

        <div className="inquiry-history">
          <h3>历史会话（{inquiries.length}）</h3>
          {inquiries.length === 0 && <p className="muted">还没有提问。</p>}
          {inquiries.map((inquiry) => (
            <div className={`inquiry-card is-${inquiry.status}`} key={inquiry.id}>
              <div className="inquiry-card-head">
                <strong>{inquiry.question}</strong>
                <span>{inquiryStatusLabel(inquiry.status)}</span>
                <button
                  className="icon-button compact"
                  onClick={() => void remove(inquiry.id)}
                  aria-label="删除会话"
                  title="删除会话"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {inquiry.answer && <p>{inquiry.answer}</p>}
              {inquiry.keyPoints?.length ? (
                <ul>
                  {inquiry.keyPoints.map((point) => <li key={point}>{point}</li>)}
                </ul>
              ) : null}
              {inquiry.error && <p className="inline-error">{inquiry.error}</p>}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function inquiryStatusLabel(status: InquiryRecord["status"]): string {
  switch (status) {
    case "running": return "回答中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
  }
}
