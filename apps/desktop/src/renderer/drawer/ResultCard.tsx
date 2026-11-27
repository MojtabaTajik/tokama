// The result card of an ended item, under its header: what the work produced in its agent's own
// words (a headline; with points and "Read more"; or a must-read with its reading time and a
// button to the reader), then what Tokama measured: Checked, Reviewed, Sent out. An item that did
// not finish says where it stopped first. Agent output, check commands and engine text are
// rendered as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Button } from "../ui/Button.js";
import { Pill } from "../ui/Pill.js";
import { sizeOf } from "./OutputTab.js";
import type { Mark as MarkData } from "../ui/status.js";
import { type FetchWords, type LinesWords, MARKS, type ResultRow, type SaidWords, resultView } from "./result-view.js";
import { useStepOutput } from "./StepOutput.js";

const TEXT = {
  label: "Result",
  says: (agent: string) => `${agent} says`,
  said: (agent: string, headline: string) => `${agent} said: ${headline}`,
  firstLines: (agent: string) => `First lines of ${agent}'s output`,
  readMore: (size: string) => `Read more · ${size} →`,
  readWriteUp: "Read the write-up",
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
}

export function ResultCard({ bridge, item, setup, columns, onReadMore, onRead }: ResultCardProps) {
  const { failure, words, rows } = resultView(item, setup);
  return (
    <section className="result-card" aria-label={TEXT.label} data-columns={columns || undefined}>
      <div className="rc-main">
        <p className="rc-label">{TEXT.label}</p>
        {failure !== undefined && (
          <>
            <p className="rc-headline">
              <Mark mark={MARKS.fail} />
              {failure}
            </p>
            {words?.kind === "said" && <p className="rc-agent-said">{TEXT.said(words.agent, words.headline)}</p>}
          </>
        )}
        {failure === undefined && words?.kind === "said" && <Said words={words} onReadMore={onReadMore} onRead={onRead} />}
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

function Said({ words, onReadMore, onRead }: { readonly words: SaidWords; readonly onReadMore: (stepIndex: number) => void; readonly onRead: (stepIndex: number) => void }) {
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
          <Button variant="primary" onClick={() => onRead(words.stepIndex)}>
            {TEXT.readWriteUp}
          </Button>
        </div>
      )}
      {words.more !== undefined && (
        <Button variant="link" className="rc-action" onClick={() => onReadMore(words.stepIndex)}>
          {TEXT.readMore(words.more)}
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
