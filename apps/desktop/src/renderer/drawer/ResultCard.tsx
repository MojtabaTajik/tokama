// The result card of an ended item, under its header: what the work produced in its agent's own
// words (a headline; with points and "Read more"; or a must-read with its reading time and a
// button to the reader), then what Tokama measured: Checked, Reviewed, Sent out. An item that did
// not finish says where it stopped first. Agent output, check commands and engine text are
// rendered as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Button } from "../ui/Button.js";
import { Pill } from "../ui/Pill.js";
import { finishView } from "./finish-view.js";
import { sizeOf } from "./OutputTab.js";
import type { Mark as MarkData } from "../ui/status.js";
import { ASK_ID } from "../newwork/needs.js";
import { type FetchWords, followUpText, type LinesWords, MARKS, type ResultRow, type SaidWords, resultView } from "./result-view.js";
import { useStepOutput } from "./StepOutput.js";

const TEXT = {
  label: "Result",
  says: (agent: string) => `${agent} says`,
  said: (agent: string, headline: string) => `${agent} said: ${headline}`,
  firstLines: (agent: string) => `First lines of ${agent}'s output`,
  readMore: (size: string) => `Read more · ${size} →`,
  readWriteUp: "Read the write-up",
  readAnswer: "Read the answer",
  startFrom: "Start work from this…",
  morePoints: (count: number) => `+${count} more in the output`,
} as const;

export interface ResultCardProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  /** The full view with room: the words on the left, the facts on the right. */
  readonly columns: boolean;
  /** "Read more": the Output tab on that step. */
  readonly onReadMore: (stepIndex: number) => void;
  /** "Read the write-up": the reader on that step's document. */
  readonly onRead: (stepIndex: number) => void;
  /** An Ask answer's "Start work from this…": New work opens with the question and the answer, and no template. Without it the card has no such link. */
  readonly onStartFrom?: ((prefill: { readonly repoId?: string; readonly text: string }) => void) | undefined;
}

export function ResultCard({ bridge, item, setup, columns, onReadMore, onRead, onStartFrom }: ResultCardProps) {
  const { failure, words, rows } = resultView(item, setup);
  // The item's one filled button is Finish while it is offered; the write-up button is then plain.
  // Without a commit only Discard is offered, and that is never the item's main action.
  const offered = finishView(item, setup);
  const finishOffered = offered?.kind === "offer" && offered.ahead !== undefined;
  const answer = item.templateId === ASK_ID;
  const text = answer ? followUpText(item) : undefined;
  const repoId = item.repoIds[0];
  const startFrom = onStartFrom === undefined || text === undefined ? undefined : () => onStartFrom({ ...(repoId !== undefined && { repoId }), text });
  return (
    <section className="result-card" aria-label={TEXT.label} data-columns={columns || undefined}>
      <div className="rc-main">
        <h3 className="rc-label">{TEXT.label}</h3>
        {failure !== undefined && (
          <>
            <p className="rc-headline">
              <Mark mark={MARKS.fail} />
              {failure}
            </p>
            {words?.kind === "said" && <p className="rc-agent-said">{TEXT.said(words.agent, words.headline)}</p>}
          </>
        )}
        {failure === undefined && words?.kind === "said" && <Said words={words} filled={!finishOffered} answer={answer} onReadMore={onReadMore} onRead={onRead} onStartFrom={startFrom} />}
        {failure === undefined && words?.kind === "lines" && <Lines words={words} onReadMore={onReadMore} />}
        {failure === undefined && words?.kind === "fetch" && <FetchedLines bridge={bridge} itemId={item.id} words={words} onReadMore={onReadMore} />}
      </div>
      {rows.length > 0 && (
        <dl className="rc-facts">
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </dl>
      )}
    </section>
  );
}

function Said({
  words,
  filled,
  answer,
  onReadMore,
  onRead,
  onStartFrom,
}: {
  readonly words: SaidWords;
  readonly filled: boolean;
  readonly answer: boolean;
  readonly onReadMore: (stepIndex: number) => void;
  readonly onRead: (stepIndex: number) => void;
  readonly onStartFrom: (() => void) | undefined;
}) {
  return (
    <>
      <p className="rc-who">
        <span>{TEXT.says(words.agent)}</span>
        {words.read !== undefined && <Pill>{words.read}</Pill>}
      </p>
      <p className="rc-headline">{words.headline}</p>
      {words.points.length > 0 && (
        <ul className="rc-points">
          {words.points.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
      )}
      {words.morePoints > 0 && <p className="rc-who">{TEXT.morePoints(words.morePoints)}</p>}
      {words.read !== undefined && (
        <div className="rc-action">
          <Button variant={filled ? "primary" : "secondary"} onClick={() => onRead(words.stepIndex)}>
            {answer ? TEXT.readAnswer : TEXT.readWriteUp}
          </Button>
        </div>
      )}
      {words.more !== undefined && (
        <Button variant="link" className="rc-action" onClick={() => onReadMore(words.stepIndex)}>
          {TEXT.readMore(words.more)}
        </Button>
      )}
      {onStartFrom !== undefined && (
        <Button variant="link" className="rc-action" onClick={onStartFrom}>
          {TEXT.startFrom}
        </Button>
      )}
    </>
  );
}

function Lines({ words, onReadMore }: { readonly words: Omit<LinesWords, "kind">; readonly onReadMore: (stepIndex: number) => void }) {
  return (
    <>
      <p className="rc-who">{TEXT.firstLines(words.agent)}</p>
      <p className="rc-lines mono">
        {words.lines.map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </p>
      {words.more !== undefined && (
        <Button variant="link" className="rc-action" onClick={() => onReadMore(words.stepIndex)}>
          {TEXT.readMore(words.more)}
        </Button>
      )}
    </>
  );
}

/** An item from before headlines: the first lines of the output, asked for once the card is on the screen. */
function FetchedLines({ bridge, itemId, words, onReadMore }: { readonly bridge: TokamaBridge; readonly itemId: string; readonly words: FetchWords; readonly onReadMore: (stepIndex: number) => void }) {
  const output = useStepOutput(bridge, itemId, words.stepIndex, words.attempt, `result ${words.stepIndex} ${words.attempt}`);
  if (output?.kind !== "loaded") return null;
  const { summary, text } = output.output;
  const lines = summary === undefined || summary.kind === "empty" ? [] : summary.lines;
  if (lines.length === 0) return null;
  return <Lines words={{ agent: words.agent, stepIndex: words.stepIndex, lines, more: sizeOf(text) }} onReadMore={onReadMore} />;
}

/** The symbol of a row, grey unless it is ✕ or !; its word is for screen readers. */
function Mark({ mark }: { readonly mark: MarkData }) {
  return (
    <>
      <span className="rc-mark" data-tone={mark.tone === "fail" || mark.tone === "warn" ? mark.tone : undefined} aria-hidden="true">
        {mark.symbol}
      </span>
      <span className="visually-hidden">{mark.word}: </span>
    </>
  );
}

function Row({ row }: { readonly row: ResultRow }) {
  return (
    <div className="rc-row">
      <dt>{row.label}</dt>
      <dd>
        {row.mark !== undefined && <Mark mark={row.mark} />}
        {row.text}
        {row.detail !== undefined && <span className="rc-detail mono">{row.detail}</span>}
      </dd>
    </div>
  );
}
