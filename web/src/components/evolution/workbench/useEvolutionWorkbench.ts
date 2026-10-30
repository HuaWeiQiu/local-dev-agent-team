import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getEvolution } from "../../../api";
import { evolutionLocked, type EvolutionFilter } from "../../../evolution";
import type { EvolutionSnapshot, ProjectScope } from "../../../types";
import {
  evolutionErrorMessage,
  refreshRequiredEvolutionCodes,
} from "../../evolution/format";
import type { DetailTab } from "../../evolution/ProposalDetail";
import type { EvolutionDecision } from "../../EvolutionDecisionDialog";
import type { EvolutionProposalInput } from "../../EvolutionProposalDialog";
import {
  archive,
  describeDecision,
  evaluate as evaluateProposal,
  previewFor,
  runDecision,
  startAutomation,
  stopAutomation,
  submitProposal as submitProposalCommand,
  unarchive,
} from "./actions";
import {
  auditFor,
  automationActive,
  clampCycles,
  completedFor,
  isWideViewport,
  mutationLocked,
  nextSelection,
  proposalsFor,
  selectedProposal,
} from "./model";

export interface EvolutionWorkbenchModel {
  snapshot: EvolutionSnapshot | undefined;
  proposals: ReturnType<typeof proposalsFor>;
  selectedId: string | undefined;
  selected: ReturnType<typeof selectedProposal>;
  audit: EvolutionSnapshot["auditRecords"];
  completed: EvolutionSnapshot["completedApplications"];
  loading: boolean;
  busy: boolean;
  error: string | undefined;
  pollError: string | undefined;
  visibleError: string | undefined;
  dialogError: string | undefined;
  filter: EvolutionFilter;
  query: string;
  tab: DetailTab;
  creating: boolean;
  decision: EvolutionDecision | undefined;
  requestedCycles: number;
  automationStartPending: boolean;
  locked: boolean;
  mutationLocked: boolean;
  refresh(): Promise<EvolutionSnapshot>;
  setFilter(value: EvolutionFilter): void;
  setQuery(value: string): void;
  setTab(value: DetailTab): void;
  setCreating(value: boolean): void;
  setDialogError(value: string | undefined): void;
  setDecision(value: EvolutionDecision | undefined): void;
  setSelectedId(value: string | undefined): void;
  closeCreating(): void;
  closeDecision(): void;
  setRequestedCycles(value: number): void;
  selectProposal(id: string): void;
  evaluate(): Promise<void>;
  openPreview(mode: "promote" | "rollback"): Promise<void>;
  openReasonDecision(mode: "reject" | "adopt"): void;
  openDeleteDecision(): void;
  submitProposal(input: EvolutionProposalInput): Promise<void>;
  submitDecision(reason: string): Promise<void>;
  startAutomation(): Promise<void>;
  stopAutomation(): Promise<void>;
  archive(): Promise<void>;
  unarchive(): Promise<void>;
}

/**
 * Data, invariants and commands behind the evolution workbench.
 *
 * The render function stays a layout: selection repair, the archived-view
 * refetch, automation polling and the "one mutation at a time" latch live here,
 * each in its own effect or helper so no single function carries the whole
 * state machine.
 */
export function useEvolutionWorkbench(input: {
  scope: ProjectScope;
}): EvolutionWorkbenchModel {
  const { scope } = input;
  const [snapshot, setSnapshot] = useState<EvolutionSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<EvolutionFilter>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [creating, setCreating] = useState(false);
  const [decision, setDecision] = useState<EvolutionDecision>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [dialogError, setDialogError] = useState<string>();
  const [requestedCycles, setRequestedCycles] = useState(3);
  const [automationStartIntent, setAutomationStartIntent] = useState<{
    commandId: string;
    maxCycles: number;
  }>();

  const includeArchived = filter === "archived";
  const wideRef = useRef(isWideViewport());
  const selectedIdLive = useRef(selectedId);
  selectedIdLive.current = selectedId;

  const refresh = useCallback(async (): Promise<EvolutionSnapshot> => {
    setLoading(true);
    try {
      const next = await getEvolution(scope, { includeArchived });
      setSnapshot(next);
      setSelectedId((current) => nextSelection(next.proposals, current, wideRef.current));
      setError(undefined);
      return next;
    } catch (requestError) {
      setError(evolutionErrorMessage(requestError));
      throw requestError;
    } finally {
      setLoading(false);
    }
  }, [scope, includeArchived]);

  useInitialLoad(scope, includeArchived, {
    setSnapshot,
    setSelectedId,
    setDecision,
    setCreating,
    setError,
    setPollError,
    setAutomationStartIntent,
    setLoading,
    setRequestedCycles,
  });

  useArchivedRefetch(snapshot !== undefined, includeArchived, refresh);
  useAutomationPolling(scope, includeArchived, snapshot, {
    setSnapshot,
    setPollError,
  });

  const proposals = useMemo(
    () => proposalsFor(snapshot, filter, query),
    [filter, query, snapshot],
  );
  const selected = selectedProposal(snapshot, selectedId);
  const locked = snapshot ? evolutionLocked(snapshot) : true;

  useSelectionRepair(busy, loading, proposals, selectedId, setSelectedId);
  useDecisionReset(decision, selectedId, setDecision, setDialogError);

  const mutations = useMutations({
    scope,
    snapshot,
    selected,
    decision,
    creating,
    refresh,
    setSnapshot,
    setBusy,
    setError,
    setDialogError,
    setDecision,
    setCreating,
    setSelectedId,
    selectedIdRef: selectedIdLive,
    automationStartIntent,
    setAutomationStartIntent,
    requestedCycles,
  });

  return {
    snapshot,
    proposals,
    selectedId,
    selected,
    audit: snapshot ? auditFor(snapshot, selected?.id) : [],
    completed: snapshot ? completedFor(snapshot, selected?.id) : [],
    loading,
    busy,
    error,
    pollError,
    visibleError: error ?? pollError,
    dialogError,
    filter,
    query,
    tab,
    creating,
    decision,
    requestedCycles,
    automationStartPending: automationStartIntent !== undefined,
    locked,
    mutationLocked: snapshot ? mutationLocked(snapshot) : true,
    refresh,
    setFilter,
    setQuery,
    setTab,
    setCreating,
    setDialogError,
    setDecision,
    setSelectedId,
    setRequestedCycles,
    selectProposal: (id: string) => {
      setSelectedId(id);
      setTab("overview");
    },
    ...useDialogClosers({ busy, setCreating, setDecision, setDialogError }),
    ...mutations,
  };
}

interface LoadHost {
  setSnapshot(value: EvolutionSnapshot | undefined): void;
  setSelectedId(value: string | undefined): void;
  setDecision(value: EvolutionDecision | undefined): void;
  setCreating(value: boolean): void;
  setError(value: string | undefined): void;
  setPollError(value: string | undefined): void;
  setAutomationStartIntent(value: undefined): void;
  setLoading(value: boolean): void;
  setRequestedCycles(value: number): void;
}

/** First load for a project: every per-project signal resets before the fetch. */
function useInitialLoad(
  scope: ProjectScope,
  includeArchived: boolean,
  host: LoadHost,
): void {
  useEffect(() => {
    let active = true;
    host.setSnapshot(undefined);
    host.setSelectedId(undefined);
    host.setDecision(undefined);
    host.setCreating(false);
    host.setError(undefined);
    host.setPollError(undefined);
    host.setAutomationStartIntent(undefined);
    host.setLoading(true);
    void getEvolution(scope, { includeArchived })
      .then((next) => {
        if (!active) return;
        applyFirstSnapshot(next, host);
      })
      .catch((requestError: unknown) => {
        if (active) host.setError(evolutionErrorMessage(requestError));
      })
      .finally(() => {
        if (active) host.setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
}

function applyFirstSnapshot(next: EvolutionSnapshot, host: LoadHost): void {
  host.setSnapshot(next);
  host.setPollError(undefined);
  host.setRequestedCycles(clampCycles(next.automation.configuredMaxCycles));
  host.setSelectedId(isWideViewport() ? next.proposals[0]?.id : undefined);
}

/** Archived candidates come from the server on demand, so toggling refetches. */
function useArchivedRefetch(
  ready: boolean,
  includeArchived: boolean,
  refresh: () => Promise<EvolutionSnapshot>,
): void {
  useEffect(() => {
    if (!ready) return;
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);
}

interface PollHost {
  setSnapshot(value: EvolutionSnapshot): void;
  setPollError(value: string | undefined): void;
}

/** Poll the server while automatic evolution is running or draining. */
function useAutomationPolling(
  scope: ProjectScope,
  includeArchived: boolean,
  snapshot: EvolutionSnapshot | undefined,
  host: PollHost,
): void {
  const status = snapshot?.automation.status;
  useEffect(() => {
    if (!automationActive(status)) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await getEvolution(scope, { includeArchived });
        if (!active) return;
        host.setSnapshot(next);
        host.setPollError(undefined);
        if (automationActive(next.automation.status)) {
          timer = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (requestError) {
        if (!active) return;
        host.setPollError(evolutionErrorMessage(requestError));
        timer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, scope, includeArchived]);
}

/** Repair a selection that the current filter hides. */
function useSelectionRepair(
  busy: boolean,
  loading: boolean,
  proposals: ReturnType<typeof proposalsFor>,
  selectedId: string | undefined,
  setSelectedId: (value: string | undefined) => void,
): void {
  useEffect(() => {
    if (busy || loading) return;
    if (selectedId && proposals.some((proposal) => proposal.id === selectedId)) return;
    setSelectedId(isWideViewport() ? proposals[0]?.id : undefined);
  }, [busy, loading, proposals, selectedId, setSelectedId]);
}

/** Drop a pending decision when the selection moves elsewhere. */
function useDecisionReset(
  decision: EvolutionDecision | undefined,
  selectedId: string | undefined,
  setDecision: (value: EvolutionDecision | undefined) => void,
  setDialogError: (value: string | undefined) => void,
): void {
  useEffect(() => {
    if (!decision || decision.proposalId === selectedId) return;
    setDecision(undefined);
    setDialogError(undefined);
  }, [decision, selectedId, setDecision, setDialogError]);
}

interface MutationInput {
  scope: ProjectScope;
  snapshot: EvolutionSnapshot | undefined;
  selected: ReturnType<typeof selectedProposal>;
  decision: EvolutionDecision | undefined;
  creating: boolean;
  refresh(): Promise<EvolutionSnapshot>;
  setSnapshot(value: EvolutionSnapshot | undefined): void;
  setBusy(value: boolean): void;
  setError(value: string | undefined): void;
  setDialogError(value: string | undefined): void;
  setDecision(value: EvolutionDecision | undefined): void;
  setCreating(value: boolean): void;
  setSelectedId(value: string | undefined): void;
  selectedIdRef: { current: string | undefined };
  automationStartIntent: { commandId: string; maxCycles: number } | undefined;
  setAutomationStartIntent(value: { commandId: string; maxCycles: number } | undefined): void;
  requestedCycles: number;
}

type Mutations = Pick<
  EvolutionWorkbenchModel,
  | "evaluate"
  | "openPreview"
  | "openReasonDecision"
  | "openDeleteDecision"
  | "submitProposal"
  | "submitDecision"
  | "startAutomation"
  | "stopAutomation"
  | "archive"
  | "unarchive"
>;

function useMutations(input: MutationInput): Mutations {
  const mutate = async (
    operation: () => Promise<unknown>,
    options: { closeDecision?: boolean } = {},
  ): Promise<void> => {
    await runMutation(input, operation, options);
  };

  const evaluate = async (): Promise<void> => {
    if (!input.selected) return;
    await mutate(() => evaluateProposal(input.scope, input.selected!.id));
  };

  const openPreview = async (mode: "promote" | "rollback"): Promise<void> => {
    if (!input.selected || !input.snapshot) return;
    await openPreviewFor(input, mode);
  };

  const openReasonDecision = (mode: "reject" | "adopt"): void => {
    if (!input.selected) return;
    input.setDecision({
      mode,
      proposalId: input.selected.id,
      commandId: crypto.randomUUID(),
    });
    input.setDialogError(undefined);
  };

  const openDeleteDecision = (): void => {
    if (!input.selected) return;
    input.setDecision({
      mode: "delete",
      proposalId: input.selected.id,
      commandId: crypto.randomUUID(),
    });
    input.setDialogError(undefined);
  };

  const submitProposal = async (proposal: EvolutionProposalInput): Promise<void> => {
    await createProposal(input, mutate, proposal);
  };

  const submitDecision = async (reason: string): Promise<void> => {
    await submitPendingDecision(input, mutate, reason);
  };

  const start = async (): Promise<void> => {
    await startAutomatic(input);
  };

  const stop = async (): Promise<void> => {
    await mutate(() => stopAutomation(input.scope));
  };

  const archiveProposal = async (): Promise<void> => {
    if (!input.selected) return;
    await mutate(() => archive(input.scope, input.selected!.id, crypto.randomUUID()));
  };

  const unarchiveProposal = async (): Promise<void> => {
    if (!input.selected) return;
    await mutate(() => unarchive(input.scope, input.selected!.id, crypto.randomUUID()));
  };

  return {
    evaluate,
    openPreview,
    openReasonDecision,
    openDeleteDecision,
    submitProposal,
    submitDecision,
    startAutomation: start,
    stopAutomation: stop,
    archive: archiveProposal,
    unarchive: unarchiveProposal,
  };
}

/** One mutation at a time: latch, run, then refresh or explain the failure. */
async function runMutation(
  input: MutationInput,
  operation: () => Promise<unknown>,
  options: { closeDecision?: boolean },
): Promise<void> {
  input.setBusy(true);
  input.setError(undefined);
  input.setDialogError(undefined);
  try {
    await operation();
  } catch (requestError) {
    await reportMutationError(input, requestError);
    input.setBusy(false);
    return;
  }
  if (options.closeDecision) input.setDecision(undefined);
  try {
    await input.refresh();
  } catch {
    input.setError("操作已由服务端接收，但最新状态读取失败。请刷新后核对，勿重复创建新命令。");
  } finally {
    input.setBusy(false);
  }
}

/** Surface a failed mutation, and resync when the server says the state moved. */
async function reportMutationError(input: MutationInput, requestError: unknown): Promise<void> {
  const message = evolutionErrorMessage(requestError);
  if (input.decision || input.creating) input.setDialogError(message);
  else input.setError(message);
  const code = requestError instanceof ApiError ? requestError.code ?? "" : "";
  if (!refreshRequiredEvolutionCodes.has(code)) return;
  input.setDecision(undefined);
  await input.refresh().catch(() => undefined);
  input.setError(
    code === "RECOVERY_REQUIRED"
      ? "本地演进状态需要先恢复，所有变更操作均已停用。"
      : "目标或修订已经变化，请重新查看预览后再确认。",
  );
}

async function openPreviewFor(
  input: MutationInput,
  mode: "promote" | "rollback",
): Promise<void> {
  const selected = input.selected!;
  const snapshot = input.snapshot!;
  input.setBusy(true);
  input.setError(undefined);
  try {
    const preview = await previewFor(input.scope, mode, selected.id, snapshot.catalogRevision);
    if (input.selectedIdRef.current !== selected.id) return;
    input.setDecision({
      mode,
      proposalId: selected.id,
      commandId: crypto.randomUUID(),
      preview,
    });
    input.setDialogError(undefined);
  } catch (requestError) {
    await reportPreviewError(input, requestError);
  } finally {
    input.setBusy(false);
  }
}

async function reportPreviewError(input: MutationInput, requestError: unknown): Promise<void> {
  if (!(requestError instanceof ApiError && requestError.status === 409)) {
    input.setError(evolutionErrorMessage(requestError));
    return;
  }
  await input.refresh().catch(() => undefined);
  input.setError("候选或目标状态已经变化，请核对最新状态后重新预览。");
}

async function createProposal(
  input: MutationInput,
  mutate: (operation: () => Promise<unknown>) => Promise<void>,
  proposal: EvolutionProposalInput,
): Promise<void> {
  let createdId: string | undefined;
  await mutate(async () => {
    createdId = await submitProposalCommand(input.scope, proposal);
    input.setCreating(false);
  });
  if (createdId) input.setSelectedId(createdId);
}

async function submitPendingDecision(
  input: MutationInput,
  mutate: (operation: () => Promise<unknown>, options?: { closeDecision?: boolean }) => Promise<void>,
  reason: string,
): Promise<void> {
  const decision = input.decision;
  const snapshot = input.snapshot;
  if (!decision || !snapshot) return;
  const described = describeDecision(decision, snapshot, reason);
  if (decision.mode !== "reject" && decision.submittedReason === undefined) {
    input.setDecision({ ...decision, submittedReason: described.reason });
  }
  await mutate(() => runDecision(input.scope, described, decision.commandId), {
    closeDecision: true,
  });
}

async function startAutomatic(input: MutationInput): Promise<void> {
  const intent = input.automationStartIntent ?? {
    commandId: crypto.randomUUID(),
    maxCycles: input.requestedCycles,
  };
  input.setAutomationStartIntent(intent);
  input.setBusy(true);
  input.setError(undefined);
  try {
    await startAutomation(input.scope, intent.maxCycles, intent.commandId);
    await input.refresh();
    input.setAutomationStartIntent(undefined);
  } catch (requestError) {
    await reportStartFailure(input, requestError);
  } finally {
    input.setBusy(false);
  }
}

async function reportStartFailure(input: MutationInput, requestError: unknown): Promise<void> {
  const message = evolutionErrorMessage(requestError);
  try {
    const latest = await input.refresh();
    input.setAutomationStartIntent(undefined);
    if (latest.automation.status === "idle") input.setError(message);
  } catch {
    input.setError("启动结果暂时无法确认。请使用同一按钮重试，系统不会重复启动同一循环。");
  }
}

/** Dialog close handlers: a running mutation keeps its dialog (and its error) on screen. */
function useDialogClosers(input: {
  busy: boolean;
  setCreating(value: boolean): void;
  setDecision(value: EvolutionDecision | undefined): void;
  setDialogError(value: string | undefined): void;
}): { closeCreating(): void; closeDecision(): void } {
  return {
    closeCreating: () => {
      if (input.busy) return;
      input.setCreating(false);
      input.setDialogError(undefined);
    },
    closeDecision: () => {
      if (input.busy) return;
      input.setDecision(undefined);
      input.setDialogError(undefined);
    },
  };
}
