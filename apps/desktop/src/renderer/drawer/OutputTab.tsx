// The Output tab: what each agent step wrote in its latest ended attempt, one section per step, in
// step order. In the full view each output reads as a document at a readable line length, with its
// headings as an outline and the agent that wrote it beside it. The text is shown with StepOutput
// (React text only); the outline holds the headings' own words as text.
import type { ItemRecord, Setup, StepRecord } from "@tokama/core";
import { type ReactNode, useEffect, useRef } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { StepOutput, useStepOutput } from "./StepOutput.js";
import { blocksOf } from "../ui/Markdown.js";
import { Button } from "../ui/Button.js";
import { Placeholder } from "../ui/EmptyState.js";
import { CopyButton, toClipboard } from "../ui/CopyButton.js";

const TEXT = {
  none: "No step has written an output yet.",
  head: (step: string) => `${step} step · output`,
  meta: (attempt: number, size: string) => `attempt ${attempt} · ${size}`,
  about: "About this output",
  outline: "On this page",
  writtenBy: "Written by",
} as const;

/** The latest attempt of an agent's step that has ended, the one with an output to show. */
export function shownAttempt(step: Pick<StepRecord, "agentId" | "attempts">): number | undefined {
  if (step.agentId === undefined) return undefined;
  return step.attempts?.filter((attempt) => attempt.result !== undefined).at(-1)?.attempt;
}

/** "512 B", "1.9 KB": the output's size in UTF-8. */
export function sizeOf(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export interface OutputTabProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  /** The full view: outlines and agents beside the outputs. */
  readonly full: boolean;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
  /** Scrolls to this step's section, again for each new `seq`: a stopped step's "See the notes". */
  readonly focus?: { readonly stepIndex: number; readonly seq: number } | undefined;
}

export function OutputTab({ bridge, item, setup, full, onOpenAgent, focus }: OutputTabProps) {
  const shown = item.steps.flatMap((step, index) => {
    const attempt = shownAttempt(step);
    return attempt === undefined ? [] : [{ index, attempt }];
  });
  if (shown.length === 0) return <Placeholder>{TEXT.none}</Placeholder>;
  return (
    <div className="ot" data-full={full ? "true" : undefined}>
      {shown.map(({ index, attempt }) => (
        <OutputDoc key={`${index} ${attempt}`} bridge={bridge} item={item} setup={setup} index={index} attempt={attempt} full={full} onOpenAgent={onOpenAgent} focus={focus} />
      ))}
    </div>
  );
}

export interface OutputDocProps extends OutputTabProps {
  readonly index: number;
  readonly attempt: number;
  /** Links under the outline, for the reader. */
  readonly also?: ReactNode;
}

/** One step's output as a document: the text, and in the full view its outline and agent beside it. */
export function OutputDoc({ bridge, item, setup, index, attempt, full, onOpenAgent, focus, also }: OutputDocProps) {
  const step = item.steps[index]!;
  const output = useStepOutput(bridge, item.id, index, attempt, `${index} ${attempt}`);
  const section = useRef<HTMLElement>(null);
  const asked = focus?.stepIndex === index ? focus.seq : undefined;
  useEffect(() => {
    if (asked !== undefined) section.current?.scrollIntoView?.({ block: "start" });
  }, [asked]);
  const text = output?.kind === "loaded" ? output.output.text : undefined;
  const headings = text === undefined ? [] : blocksOf(text).flatMap((block) => (block.kind === "heading" ? [block.text] : []));
  const head = TEXT.head(step.name);
  // Only agents' steps have an output, so the step always has an agent.
  const info = agentInfo(item, index, setup)!;
  return (
    <section className="ot-step" aria-label={head} ref={section}>
      <article className="ot-doc">
        <p className="ot-head">
          <span>{head}</span>
          {output?.kind === "loaded" && <span className="mono">{TEXT.meta(output.output.attempt, sizeOf(output.output.text))}</span>}
          {text !== undefined && text.trim() !== "" && <CopyButton size="sm" className="ot-copy" copy={toClipboard(text)} />}
        </p>
        {output !== undefined && <StepOutput state={output} label={head} />}
      </article>
      {full && (
        <aside className="ot-aside" aria-label={TEXT.about}>
          {headings.length > 0 && (
            <div className="ot-group">
              <span className="ot-label">{TEXT.outline}</span>
              {headings.map((heading, at) => (
                <Button variant="link" key={at} className="ot-link" onClick={() => section.current?.querySelectorAll(".st-heading")[at]?.scrollIntoView({ block: "start" })}>
                  {heading}
                </Button>
              ))}
            </div>
          )}
          <div className="ot-group">
            <span className="ot-label">{TEXT.writtenBy}</span>
            <AgentLabel info={info} onOpen={onOpenAgent} />
          </div>
          {also !== undefined && <div className="ot-group">{also}</div>}
        </aside>
      )}
    </section>
  );
}
