import { useMediaQuery } from "../hooks/useMediaQuery";
import type { ProjectScope, PublicConfig } from "../types";
import { cn } from "../ui/cn";
import { Callout } from "../ui/form";
import { AutomationBar } from "./evolution/AutomationBar";
import { EvolutionPanes, EvolutionUnavailable, LockBanner } from "./evolution/workbench/panes";
import { useEvolutionWorkbench } from "./evolution/workbench/useEvolutionWorkbench";
import { EvolutionDecisionDialog } from "./EvolutionDecisionDialog";
import { EvolutionProposalDialog } from "./EvolutionProposalDialog";

interface EvolutionWorkbenchProps {
  scope: ProjectScope;
  config: PublicConfig;
}

export function EvolutionWorkbench({ scope, config }: EvolutionWorkbenchProps) {
  const model = useEvolutionWorkbench({ scope });
  const twoPane = useMediaQuery("(min-width: 801px)");
  const wide = useMediaQuery("(min-width: 1180px)");

  if (!model.snapshot) {
    return (
      <EvolutionUnavailable
        loading={model.loading}
        error={model.error}
        onRetry={() => void model.refresh().catch(() => undefined)}
      />
    );
  }

  return (
    <section
      aria-label="演进工作台"
      className={cn(
        "flex h-full min-h-0 flex-col bg-background text-sm text-ink",
        twoPane ? "overflow-hidden" : "scroll-thin overflow-y-auto overflow-x-hidden",
      )}
    >
      <AutomationBar
        automation={model.snapshot.automation}
        requestedCycles={model.requestedCycles}
        busy={model.busy}
        startIntentPending={model.automationStartPending}
        mutationLocked={model.mutationLocked}
        onCyclesChange={model.setRequestedCycles}
        onStart={() => void model.startAutomation()}
        onStop={() => void model.stopAutomation()}
      />
      <LockBanner snapshot={model.snapshot} />
      {model.visibleError && (
        <div className="shrink-0 px-4 pt-3 md:px-6">
          <Callout tone="danger" role="alert">
            {model.visibleError}
          </Callout>
        </div>
      )}

      <EvolutionPanes model={model} twoPane={twoPane} wide={wide} />

      <WorkbenchDialogs model={model} config={config} />
    </section>
  );
}

function WorkbenchDialogs({
  model,
  config,
}: {
  model: ReturnType<typeof useEvolutionWorkbench>;
  config: PublicConfig;
}) {
  return (
    <>
      <EvolutionProposalDialog
        open={model.creating}
        config={config}
        snapshot={model.snapshot!}
        busy={model.busy}
        {...(model.dialogError ? { error: model.dialogError } : {})}
        onClose={model.closeCreating}
        onSubmit={model.submitProposal}
      />
      <EvolutionDecisionDialog
        decision={model.decision}
        busy={model.busy}
        {...(model.dialogError ? { error: model.dialogError } : {})}
        onClose={model.closeDecision}
        onSubmit={model.submitDecision}
      />
    </>
  );
}
