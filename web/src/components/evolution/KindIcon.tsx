import { Braces, FileText } from "lucide-react";
import type { EvolutionProposal } from "../../types";
import { cn } from "../../ui/cn";

export function KindIcon({ kind, className }: { kind: EvolutionProposal["candidate"]["kind"]; className?: string }) {
  const strategy = kind === "strategy-blueprint";
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-lg [&_svg]:size-4",
        strategy ? "bg-info-soft text-info-ink" : "bg-warning-soft text-warning-ink",
        className,
      )}
    >
      {strategy ? <Braces /> : <FileText />}
    </span>
  );
}
