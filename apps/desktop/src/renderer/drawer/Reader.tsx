// The reader: one step's output on its own, as a large document with its outline beside it, in
// the full view under the pinned decision. A link goes on to the whole item.
import type { ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import type { AgentTarget } from "../settings/describe.js";
import { Button } from "../ui/Button.js";
import { Placeholder } from "../ui/EmptyState.js";
import { OutputDoc, shownAttempt } from "./OutputTab.js";
import { InShort } from "./SaidBlock.js";

const TEXT = {
  label: "Reader",
  none: "This step has not written an output yet.",
  all: "All of this item: Steps, Output, Log →",
} as const;

export interface ReaderProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly stepIndex: number;
  /** "All of this item": the full view with its tabs. */
  readonly onShowAll: () => void;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
}

export function Reader({ bridge, item, setup, stepIndex, onShowAll, onOpenAgent }: ReaderProps) {
  const step = item.steps[stepIndex];
  const attempt = step === undefined ? undefined : shownAttempt(step);
  const said = step?.attempts?.find((candidate) => candidate.attempt === attempt)?.said;
  return (
    <div className="drawer-panel reader" role="region" aria-label={TEXT.label}>
      {said !== undefined && <InShort said={said} />}
      <div className="ot" data-full="true" data-reader="true">
        {attempt === undefined ? (
          <Placeholder>{TEXT.none}</Placeholder>
        ) : (
          <OutputDoc
            bridge={bridge}
            item={item}
            setup={setup}
            index={stepIndex}
            attempt={attempt}
            full
            onOpenAgent={onOpenAgent}
            also={
              <Button variant="link" className="ot-link" onClick={onShowAll}>
                {TEXT.all}
              </Button>
            }
          />
        )}
      </div>
      {attempt === undefined && (
        <Button variant="link" onClick={onShowAll}>
          {TEXT.all}
        </Button>
      )}
    </div>
  );
}
