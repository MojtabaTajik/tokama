// The Output tab: what each agent step wrote in its latest ended attempt, one folded line per step,
// in step order, with one line of what it says under the closed line. Opening a step shows its
// output as a document: in the full view at a readable line length, with its headings as an outline
// and the agent that wrote it beside it. The text is shown with StepOutput (React text only); the
// outline holds the headings' own words as text.
import type { ItemRecord, OutputSummary, Setup, StepRecord } from "@tokama/core";
import { type ReactNode, useEffect, useRef } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { spokenSize, stepFacts } from "./attempt-view.js";
import { trackOf } from "./progress-view.js";
import { type OutputState, StepOutput, useStepOutput } from "./StepOutput.js";
import { useNow } from "../useNow.js";
import { AgentName } from "../ui/agent.js";
import type { Mark } from "../ui/status.js";
import { blocksOf } from "../ui/Markdown.js";
import { Button } from "../ui/Button.js";
import { Placeholder } from "../ui/EmptyState.js";
import { CopyButton, toClipboard } from "../ui/CopyButton.js";
import { Section, SectionList, useOpenSections } from "../ui/Section.js";

const TEXT = {
  none: "No step has written an output yet.",
  head: (step: string) => `${step} step · output`,
  meta: (attempt: number, size: string) => `attempt ${attempt} · ${size}`,
  about: "About this output",
  outline: "On this page",
  writtenBy: "Written by",
  approve: "approve",
  changes: "changes",
  mustFix: (count: number) => `${count} must-fix`,
} as const;

/** The latest attempt of an agent's step that has ended, the one with an output to show. */
export function shownAttempt(step: Pick<StepRecord, "agentId" | "attempts">): number | undefined {
  if (step.agentId === undefined) return undefined;
  return step.attempts?.filter((attempt) => attempt.result !== undefined).at(-1)?.attempt;
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** "512 B", "1.9 KB": the output's size in UTF-8. */
export function sizeOf(text: string): string {
  const bytes = bytesOf(text);
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** What an output says in one line: "approve", "changes · 2 must-fix · src/x.ts:12", or its first line; undefined when it says nothing. */
export function summaryLine(summary: OutputSummary | undefined): string | undefined {
  switch (summary?.kind) {
    case "verdict": {
      if (summary.verdict === "approve") return TEXT.approve;
      const count = summary.mustFix.length + summary.more;
      const ref = summary.mustFix.find((item) => item.ref !== undefined)?.ref;
      return [TEXT.changes, ...(count > 0 ? [TEXT.mustFix(count)] : []), ...(ref === undefined ? [] : [ref])].join(" · ");
    }
    case "lines":
      return summary.lines[0];
    default:
      return undefined;
  }
}

export interface OutputTabProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  /** The full view: outlines and agents beside the outputs. */
  readonly full: boolean;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
  /** Opens this step's output and scrolls to it, again for each new `seq`: a stopped step's "See the notes". */
  readonly focus?: { readonly stepIndex: number; readonly seq: number } | undefined;
}

const stepKey = (index: number) => `s:${index}`;

export function OutputTab({ bridge, item, setup, full, onOpenAgent, focus }: OutputTabProps) {
  const shown = item.steps.flatMap((step, index) => {
    const attempt = shownAttempt(step);
    return attempt === undefined ? [] : [{ index, attempt }];
  });
  // A step that waits for its plan to be approved opens by itself: the output is what you decide on.
  const waiting = item.state === "needs_you" && item.decision?.kind === "plan_approval" ? item.decision.stepIndex : undefined;
  const { open, update } = useOpenSections(
    `${item.id}:Output`,
    shown.filter(({ index }) => index === waiting || index === focus?.stepIndex).map(({ index }) => stepKey(index)),
  );
  // Each new question opens its step, also when the engineer closed it for an earlier question.
  const approvalId = waiting === undefined ? undefined : item.decision?.id;
  const seenApproval = useRef(approvalId);
  useEffect(() => {
    // The question already there when the tab opens is the defaults' business: a visit does not undo a close.
    if (seenApproval.current === approvalId) return;
    seenApproval.current = approvalId;
    if (approvalId !== undefined && waiting !== undefined) update((keys) => keys.add(stepKey(waiting)));
    // Only a new question acts; `update` is new on every render.
  }, [approvalId]);
  const asked = focus?.seq;
  const askedStep = focus?.stepIndex;
  useEffect(() => {
    if (asked !== undefined && askedStep !== undefined) update((keys) => keys.add(stepKey(askedStep)));
    // Only a new ask acts; `update` is new on every render.
  }, [asked, askedStep]);
  if (shown.length === 0) return <Placeholder>{TEXT.none}</Placeholder>;
  const track = trackOf(item).steps;
  return (
    <div className="ot" data-full={full ? "true" : undefined}>
      <SectionList>
        {shown.map(({ index, attempt }) => (
          <OutputStep
            key={`${index} ${attempt}`}
            bridge={bridge}
            item={item}
            setup={setup}
            index={index}
            attempt={attempt}
            mark={track[index]!}
            full={full}
            onOpenAgent={onOpenAgent}
            focus={focus}
            open={open.has(stepKey(index))}
            onToggle={() =>
              update((keys) => {
                if (!keys.delete(stepKey(index))) keys.add(stepKey(index));
              })
            }
          />
        ))}
      </SectionList>
    </div>
  );
}

interface OutputStepProps extends Omit<OutputTabProps, "focus"> {
  readonly index: number;
  readonly attempt: number;
  readonly mark: Mark;
  readonly focus: OutputTabProps["focus"];
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** One step's line, with its output asked for once: the line's summary and size, and the document when it is open. */
function OutputStep({ bridge, item, setup, index, attempt, mark, full, onOpenAgent, focus, open, onToggle }: OutputStepProps) {
  const step = item.steps[index]!;
  const output = useStepOutput(bridge, item.id, index, attempt, `${index} ${attempt}`);
  const loaded = output?.kind === "loaded" ? output.output : undefined;
  // A later attempt can be running: its time keeps counting on the line.
  const now = useNow(step.attempts?.at(-1)?.result === undefined && step.attempts !== undefined);
  const facts = stepFacts(step, now, loaded === undefined ? undefined : { text: sizeOf(loaded.text), spoken: spokenSize(bytesOf(loaded.text)) });
  const info = agentInfo(item, index, setup)!;
  return (
    <Section
      title={step.name}
      agent={<AgentName name={info.name} dot={info.dot} coloured />}
      state={mark}
      facts={facts.text}
      spokenFacts={facts.spoken}
      summary={summaryLine(loaded?.summary)}
      open={open}
      onToggle={onToggle}
    >
      {() => <OutputDoc bridge={bridge} item={item} setup={setup} index={index} attempt={attempt} full={full} onOpenAgent={onOpenAgent} focus={focus} state={output} />}
    </Section>
  );
}

export interface OutputDocProps extends OutputTabProps {
  readonly index: number;
  readonly attempt: number;
  /** Links under the outline, for the reader. */
  readonly also?: ReactNode;
  /** The output as its step's line already asked for it; without it the document asks for itself. */
  readonly state?: OutputState | undefined;
}

/** One step's output as a document: the text, and in the full view its outline and agent beside it. */
export function OutputDoc({ bridge, item, setup, index, attempt, full, onOpenAgent, focus, also, state }: OutputDocProps) {
  const step = item.steps[index]!;
  const own = useStepOutput(bridge, item.id, index, attempt, state === undefined ? `${index} ${attempt}` : undefined);
  const output = state ?? own;
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
