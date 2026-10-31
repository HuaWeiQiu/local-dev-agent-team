import { useCallback, useEffect, useState } from "react";
import {
  getEvolution,
  getExperience,
  promoteExperience,
  rejectExperience,
  retireExperience,
  retrieveExperience,
  shareExperience,
} from "../../../api";
import { errorMessage } from "../../../presentation";
import type {
  ExperiencePlanningBundle,
  ExperienceSnapshot,
  ProjectScope,
} from "../../../types";
import type { ActionMode, LatestEvaluation } from "../model";
import { actionError, promoteOptions, type ActionInput } from "./model";

export interface ExperienceData {
  snapshot: ExperienceSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
  busy: boolean;
  setError(value: string | undefined): void;
  refresh(): Promise<void>;
}

/** Snapshot, loading and the shared error channel for one project scope. */
export function useExperienceData(scope: ProjectScope): ExperienceData {
  const [snapshot, setSnapshot] = useState<ExperienceSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getExperience(scope);
      setSnapshot(next);
      setError(undefined);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
    void refresh();
  }, [refresh]);

  return { snapshot, loading, error, busy, setError, refresh };
}

export interface PreviewState {
  query: string;
  result: ExperiencePlanningBundle | undefined;
  loading: boolean;
  setQuery(value: string): void;
}

/** Debounced read-only retrieval preview (never counts a hit). */
export function useExperiencePreview(scope: ProjectScope): PreviewState {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ExperiencePlanningBundle>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResult(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      retrieveExperience(scope, text, { preview: true })
        .then((bundle) => setResult(bundle))
        .catch(() => setResult(undefined))
        .finally(() => setLoading(false));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [query, scope]);

  return { query, result, loading, setQuery };
}

/** The latest evaluation identity, fetched when a promotion dialog opens. */
export function useLatestEvaluation(scope: ProjectScope): {
  latest: LatestEvaluation | undefined;
  load(): Promise<void>;
} {
  const [latest, setLatest] = useState<LatestEvaluation>();
  const load = useCallback(async () => {
    try {
      const evolution = await getEvolution(scope);
      setLatest(evolution.automation.lastEvaluation ?? undefined);
    } catch {
      setLatest(undefined);
    }
  }, [scope]);
  return { latest, load };
}

export interface ActionState {
  action: { mode: ActionMode; experienceId: string } | undefined;
  reason: string;
  suiteDigest: string;
  forceWithoutSuite: boolean;
  dialogError: string | undefined;
  busy: boolean;
  open(mode: ActionMode, experienceId: string, initialReason: string): void;
  close(): void;
  setReason(value: string): void;
  setSuiteDigest(value: string): void;
  setForceWithoutSuite(value: boolean): void;
  setDialogError(value: string | undefined): void;
  submit(): Promise<void>;
}

/** Promote / reject / retire / share, with the dialog's validation. */
export function useExperienceActions(input: {
  scope: ProjectScope;
  requireSuite: boolean;
  onDone(): Promise<void>;
}): ActionState {
  const [action, setAction] = useState<{ mode: ActionMode; experienceId: string }>();
  const [reason, setReason] = useState("");
  const [suiteDigest, setSuiteDigest] = useState("");
  const [forceWithoutSuite, setForceWithoutSuite] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const open = (mode: ActionMode, experienceId: string, initialReason: string): void => {
    setAction({ mode, experienceId });
    setReason(initialReason);
    setDialogError(undefined);
  };

  const close = (): void => setAction(undefined);

  const submit = async (): Promise<void> => {
    if (!action) return;
    const invalid = actionError({
      mode: action.mode,
      reason,
      suiteDigest,
      forceWithoutSuite,
      requireSuite: input.requireSuite,
    } satisfies ActionInput);
    if (invalid) {
      setDialogError(invalid);
      return;
    }
    setBusy(true);
    setDialogError(undefined);
    try {
      await runAction(input.scope, action, reason.trim(), promoteOptions({ suiteDigest, forceWithoutSuite }));
      resetDialog();
      await input.onDone();
    } catch (requestError) {
      setDialogError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const resetDialog = (): void => {
    setAction(undefined);
    setReason("");
    setSuiteDigest("");
    setForceWithoutSuite(false);
  };

  return {
    action,
    reason,
    suiteDigest,
    forceWithoutSuite,
    dialogError,
    busy,
    open,
    close,
    setReason,
    setSuiteDigest,
    setForceWithoutSuite,
    setDialogError,
    submit,
  };
}

async function runAction(
  scope: ProjectScope,
  action: { mode: ActionMode; experienceId: string },
  reason: string,
  options: ReturnType<typeof promoteOptions>,
): Promise<void> {
  if (action.mode === "promote") {
    await promoteExperience(scope, action.experienceId, reason, options);
    return;
  }
  if (action.mode === "reject") {
    await rejectExperience(scope, action.experienceId, reason);
    return;
  }
  if (action.mode === "retire") {
    await retireExperience(scope, action.experienceId, reason);
    return;
  }
  await shareExperience(scope, action.experienceId, reason);
}
