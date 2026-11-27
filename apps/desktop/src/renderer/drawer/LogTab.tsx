// The Log tab: one folded line per agent step, in run order. Opening a step shows its attempts as
// lines too, the latest one open; opening an attempt shows the agent's transcript. Each tool call
// is one line (→), the agent's own words read as prose, and the final message is shown in full. A
// cut transcript says how much it shows and offers Open the file. A transcript is asked for only
// while its attempt is open, and a running attempt is read again every few seconds only then. What
// was opened stays open while the app runs. Everything is engine text, shown as React text only,
// never as HTML or Markdown.
import type { AttemptSummary, ItemRecord, ItemUsage, Setup, StepRecord } from "@tokama/core";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { agentInfo } from "../agent/agent-info.js";
import { attemptsText } from "../insights/usage-model.js";
import { useNow } from "../useNow.js";
import { agentSteps, attemptFacts, capNote, logFacts, sizeFact, stepFacts, transcriptBytes, transcriptLines, useAttemptReply } from "./attempt-view.js";
import { attemptLine } from "./describe.js";
import { OpenFile } from "./OpenFile.js";
import { trackOf } from "./progress-view.js";
import { AgentName } from "../ui/agent.js";
import { Placeholder } from "../ui/EmptyState.js";
import { Section, SectionList, useOpenSections } from "../ui/Section.js";
import { type Mark, markOf, StatusMark } from "../ui/status.js";

const TEXT = {
  none: "No agent has run yet. Each attempt's transcript appears here.",
  attempt: (n: number, fresh: boolean) => `Attempt ${n}${fresh ? " · fresh session" : ""}`,
  loading: "Loading the transcript",
  failed: (message: string) => `Could not load the transcript: ${message}`,
  notSaved: "The transcript of this attempt was not saved.",
  noLines: "No lines yet.",
  final: "Final message",
  transcript: (title: string) => `${title}: transcript`,
  transcripts: (step: string) => `${step}: transcripts`,
  retries: (retry: { readonly attempts: readonly number[]; readonly tokensPercent: number; readonly failingCheck?: string | undefined }) =>
    `${attemptsText(retry.attempts)} used ${Math.round(retry.tokensPercent)}% of this item's tokens${retry.failingCheck === undefined ? "" : ` · failing check: ${retry.failingCheck}`}`,
} as const;

/** Looks at the box's end again after each answer only while the reader was at the end. */
const AT_END_PX = 8;

export interface LogTabProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  /** What the item used: a step with retries says what they took. */
  readonly usage?: ItemUsage | undefined;
  readonly setup: Setup | undefined;
  readonly full: boolean;
  /** Opens this step and its latest attempt and focuses its line, again for each new `seq`: a stopped step's "See the log". */
  readonly focus?: { readonly stepIndex: number; readonly seq: number } | undefined;
}

// The keys of the open sections, per item: `s:2` the step at index 2 is open; `a:2:3` its attempt 3
// was opened by hand; `t:2` the engineer has touched this step's attempts, so the latest no longer
// follows a new one.
const stepKey = (index: number) => `s:${index}`;
const attemptKey = (index: number, attempt: number) => `a:${index}:${attempt}`;
const touchedKey = (index: number) => `t:${index}`;

export function LogTab({ bridge, item, usage, setup, full, focus }: LogTabProps) {
  const indexes = agentSteps(item);
  const withLog = indexes.filter((index) => (item.steps[index]!.attempts ?? []).length > 0);
  const { open, update } = useOpenSections(`${item.id}:Log`, []);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const [reveal, setReveal] = useState<{ readonly stepIndex: number; readonly seq: number } | undefined>(undefined);
  const asked = focus?.seq;
  const askedStep = focus?.stepIndex;
  useEffect(() => {
    if (asked === undefined || askedStep === undefined) return;
    update((keys) => {
      keys.add(stepKey(askedStep));
      keys.delete(touchedKey(askedStep));
    });
    setReveal({ stepIndex: askedStep, seq: asked });
    // Only a new ask acts; `update` is new on every render.
  }, [asked, askedStep]);
  useLayoutEffect(() => {
    if (reveal === undefined) return;
    const button = buttons.current.get(reveal.stepIndex);
    button?.scrollIntoView?.({ block: "start" });
    button?.focus();
  }, [reveal]);

  if (withLog.length === 0) return <Placeholder>{TEXT.none}</Placeholder>;
  const track = trackOf(item, setup?.agents ?? []).steps;
  const latestOf = (index: number) => item.steps[index]!.attempts!.at(-1)!.attempt;
  const attemptOpen = (index: number, attempt: number) => open.has(attemptKey(index, attempt)) || (open.has(stepKey(index)) && !open.has(touchedKey(index)) && attempt === latestOf(index));

  const toggleStep = (index: number) =>
    update((keys) => {
      if (keys.delete(stepKey(index))) {
        // Closing forgets which attempts were open: the step opens on its latest again.
        for (const key of [...keys]) if (key.startsWith(`a:${index}:`) || key === touchedKey(index)) keys.delete(key);
      } else keys.add(stepKey(index));
    });
  const toggleAttempt = (index: number, attempt: number) =>
    update((keys) => {
      const wasOpen = attemptOpen(index, attempt);
      // The first touch fixes what was open, so the latest attempt stops following a new one.
      for (const entry of item.steps[index]!.attempts!) if (attemptOpen(index, entry.attempt)) keys.add(attemptKey(index, entry.attempt));
      keys.add(touchedKey(index));
      if (wasOpen) keys.delete(attemptKey(index, attempt));
      else keys.add(attemptKey(index, attempt));
    });

  return (
    <div className="lg" data-full={full ? "true" : undefined}>
      <SectionList
        facts={logFacts(indexes.map((index) => item.steps[index]!))}
        allOpen={withLog.every((index) => open.has(stepKey(index)))}
        noneOpen={withLog.every((index) => !open.has(stepKey(index)))}
        onExpandAll={() =>
          update((keys) => {
            keys.clear();
            for (const index of withLog) keys.add(stepKey(index));
          })
        }
        onCollapseAll={() => update((keys) => keys.clear())}
      >
        {indexes.map((index) => (
          <StepLog
            key={index}
            bridge={bridge}
            item={item}
            usage={usage}
            setup={setup}
            index={index}
            mark={track[index]!.mark}
            open={open.has(stepKey(index))}
            attemptOpen={(attempt) => attemptOpen(index, attempt)}
            onToggle={() => toggleStep(index)}
            onToggleAttempt={(attempt) => toggleAttempt(index, attempt)}
            buttonRef={(button) => {
              if (button === null) buttons.current.delete(index);
              else buttons.current.set(index, button);
            }}
          />
        ))}
      </SectionList>
    </div>
  );
}

interface StepLogProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly usage: ItemUsage | undefined;
  readonly setup: Setup | undefined;
  readonly index: number;
  readonly mark: Mark;
  readonly open: boolean;
  readonly attemptOpen: (attempt: number) => boolean;
  readonly onToggle: () => void;
  readonly onToggleAttempt: (attempt: number) => void;
  readonly buttonRef: (button: HTMLButtonElement | null) => void;
}

function StepLog({ bridge, item, usage, setup, index, mark, open, attemptOpen, onToggle, onToggleAttempt, buttonRef }: StepLogProps) {
  const step: StepRecord = item.steps[index]!;
  const attempts = step.attempts ?? [];
  const running = attempts.at(-1)?.result === undefined && attempts.length > 0;
  // Its own clock, so only a running step's line is drawn again each second.
  const now = useNow(running);
  const facts = stepFacts(step, now, sizeFact(transcriptBytes(attempts)));
  const info = agentInfo(item, index, setup);
  const retry = usage?.retries?.find((entry) => entry.stepIndex === index);
  return (
    <Section
      title={step.name}
      agent={info === undefined ? undefined : <AgentName name={info.name} hue={info.hue} coloured />}
      state={mark}
      facts={facts.text}
      spokenFacts={facts.spoken}
      open={open}
      onToggle={onToggle}
      disabled={attempts.length === 0}
      buttonRef={buttonRef}
    >
      {() => (
        <div className="lg-attempts" role="group" aria-label={TEXT.transcripts(step.name)}>
          {retry !== undefined && <p className="lg-retries">{TEXT.retries(retry)}</p>}
          {attempts.map((attempt) => (
            <AttemptLog
              key={attempt.attempt}
              bridge={bridge}
              item={item}
              index={index}
              stepName={step.name}
              agentName={info?.name}
              fresh={attempt.attempt > 1}
              attempt={attempt}
              open={attemptOpen(attempt.attempt)}
              onToggle={() => onToggleAttempt(attempt.attempt)}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

interface AttemptLogProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly index: number;
  readonly stepName: string;
  readonly agentName: string | undefined;
  readonly fresh: boolean;
  readonly attempt: AttemptSummary;
  readonly open: boolean;
  readonly onToggle: () => void;
}

function AttemptLog({ bridge, item, index, stepName, agentName, fresh, attempt, open, onToggle }: AttemptLogProps) {
  const running = attempt.result === undefined;
  const now = useNow(running);
  const facts = attemptFacts(attempt, now);
  const line = attemptLine(attempt);
  // A failed attempt of a step that runs checks failed them.
  const mark = attempt.result === "failed" && attempt.checks.some((check) => !check.passed) ? markOf("failed", "checks failed") : line.mark;
  const title = TEXT.attempt(attempt.attempt, fresh);
  return (
    <Section level="attempt" title={title} state={mark} facts={facts.text} spokenFacts={facts.spoken} open={open} onToggle={onToggle}>
      {() => (attempt.transcriptSaved === false ? <p className="lg-none">{TEXT.notSaved}</p> : <AttemptBody bridge={bridge} itemId={item.id} index={index} attempt={attempt} agentName={agentName} label={`${stepName}, ${title.toLowerCase()}`} />)}
    </Section>
  );
}

interface AttemptBodyProps {
  readonly bridge: TokamaBridge;
  readonly itemId: string;
  readonly index: number;
  readonly attempt: AttemptSummary;
  readonly agentName: string | undefined;
  readonly label: string;
}

/** The transcript of one open attempt; its query, and for a running attempt its polling, live and die with it. Not drawn again by the line's clock. */
const AttemptBody = memo(function AttemptBody({ bridge, itemId, index, attempt, agentName, label }: AttemptBodyProps) {
  const running = attempt.result === undefined;
  const reply = useAttemptReply(bridge, "attempt_log", { itemId, stepIndex: index, attempt: attempt.attempt }, attempt.result ?? "", running);
  const box = useRef<HTMLDivElement>(null);
  // A running attempt keeps its end in view, but only while the reader has not scrolled away from it.
  const atEnd = useRef(running);
  useLayoutEffect(() => {
    const element = box.current;
    if (running && atEnd.current && element !== null) element.scrollTop = element.scrollHeight;
  }, [reply, running]);
  const transcript = reply.kind === "loaded" ? reply.data.transcript : null;
  if (reply.kind === "loading") return <Placeholder>{TEXT.loading}</Placeholder>;
  if (reply.kind !== "loaded") {
    return (
      <p className="inline-error" role="alert">
        <StatusMark status="failed" className="symbol" />
        {TEXT.failed(reply.message)}
      </p>
    );
  }
  return (
    <div className="lg-box">
      {transcript?.truncated === true && (
        <p className="lg-cap">
          <span>{capNote(transcript, "Showing the last")}</span>
          <OpenFile bridge={bridge} name={{ itemId, stepIndex: index, attempt: attempt.attempt, file: "transcript" }} />
        </p>
      )}
      <div
        className="lg-body"
        tabIndex={0}
        role="region"
        aria-label={TEXT.transcript(label)}
        ref={box}
        onScroll={(event) => {
          const element = event.currentTarget;
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END_PX;
        }}
      >
        {transcript === null && !running ? (
          <p className="lg-none">{TEXT.notSaved}</p>
        ) : transcript === null || transcript.text === "" ? (
          <p className="lg-none">{TEXT.noLines}</p>
        ) : (
          transcriptLines(transcript.text).map((entry, at) =>
            entry.kind === "gap" ? (
              <div key={at} className="lg-gap" />
            ) : (
              <div key={at} className="lg-line" data-kind={entry.kind}>
                <span className="lg-glyph mono" aria-hidden="true">
                  {entry.kind === "tool" ? "→" : ""}
                </span>
                <span className="lg-text">{entry.text}</span>
              </div>
            ),
          )
        )}
        {reply.data.final !== null && reply.data.final.text.trim() !== "" && (
          <div className="lg-final">
            <span className="lg-label">{agentName === undefined ? TEXT.final : `${TEXT.final} · ${agentName}`}</span>
            <div className="lg-final-text">{reply.data.final.text}</div>
          </div>
        )}
      </div>
    </div>
  );
});
