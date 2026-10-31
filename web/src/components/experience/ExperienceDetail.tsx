import type { ExperienceEntry } from "../../types";
import { actionsFor, conditionLabels, tagLabels } from "./detail/model";
import {
  ConditionsCard,
  DetailHeader,
  ExperienceEmpty,
  FailureCallout,
  MetaRow,
  TagsCard,
} from "./detail/sections";

export { ExperienceEmpty };

interface ExperienceDetailProps {
  entry: ExperienceEntry;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
}

/** One experience entry: what it says, what it earns, and where it came from. */
export function ExperienceDetail({
  entry,
  busy,
  onPromote,
  onReject,
  onShare,
  onRetire,
}: ExperienceDetailProps) {
  return (
    <article className="flex flex-col gap-5">
      <DetailHeader
        entry={entry}
        actions={actionsFor(entry)}
        busy={busy}
        onPromote={onPromote}
        onReject={onReject}
        onShare={onShare}
        onRetire={onRetire}
      />
      {entry.failureReason ? <FailureCallout reason={entry.failureReason} /> : null}
      <ConditionsCard conditions={conditionLabels(entry)} />
      <TagsCard tags={tagLabels(entry)} />
      <MetaRow entry={entry} />
    </article>
  );
}
