// The Log tab: the agent's transcript of each attempt of each agent step, oldest first. Each tool
// call is one line (→), the agent's own words read as prose, and the final message is shown in
// full. A cut transcript says how much it shows and offers Open the file; a running attempt is
// read again every few seconds. Everything is engine text, shown as React text only, never as
// HTML or Markdown.
import type { ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { agentSteps, attemptsOf, capNote, type StepAttempt, transcriptLines, useAttemptReply } from "./attempt-view.js";
import { attemptLine } from "./describe.js";
import { OpenFile } from "./OpenFile.js";
import { StatusMark } from "../ui/status.js";
import { Placeholder } from "../ui/EmptyState.js";

const TEXT = {
  none: "No agent has run yet. Each attempt's transcript appears here.",
  title: (step: string, n: number, fresh: boolean) => `${step} · attempt ${n}${fresh ? ", fresh session" : ""}`,
  loading: "Loading the transcript",
  failed: (message: string) => `Could not load the transcript: ${message}`,
  notSaved: "The transcript of this attempt was not saved.",
  noLines: "No lines yet.",
  final: "Final message",
  transcript: (title: string) => `${title}: transcript`,
} as const;

export interface LogTabProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly full: boolean;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
}

export function LogTab({ bridge, item, setup, full, onOpenAgent }: LogTabProps) {
  const attempts = attemptsOf(item, agentSteps(item));
  if (attempts.length === 0) return <Placeholder>{TEXT.none}</Placeholder>;
  return (
    <div className="lg" data-full={full ? "true" : undefined}>
      {attempts.map((entry) => (
        <AttemptLog key={`${entry.index} ${entry.attempt.attempt}`} bridge={bridge} item={item} setup={setup} entry={entry} onOpenAgent={onOpenAgent} />
      ))}
    </div>
  );
}

interface AttemptLogProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly entry: StepAttempt;
  readonly onOpenAgent: LogTabProps["onOpenAgent"];
}

function AttemptLog({ bridge, item, setup, entry, onOpenAgent }: AttemptLogProps) {
  const { index, step, attempt } = entry;
  const running = attempt.result === undefined;
  const reply = useAttemptReply(bridge, "attempt_log", { itemId: item.id, stepIndex: index, attempt: attempt.attempt }, attempt.result ?? "", running);
  const line = attemptLine(attempt);
  const title = TEXT.title(step.name, attempt.attempt, attempt.attempt > 1);
  const info = agentInfo(item, index, setup);
  const transcript = reply.kind === "loaded" ? reply.data.transcript : null;
  return (
    <section className="lg-attempt" aria-label={title}>
      <p className="lg-head">
        <span className="mark" data-tone={line.mark.tone} aria-hidden="true">
          {line.mark.symbol}
        </span>
        <span className="lg-title">{title}</span>
        {info !== undefined && <AgentLabel info={info} onOpen={onOpenAgent} />}
        <span className="lg-meta mono">{line.text.split(" · ").slice(1).join(" · ")}</span>
      </p>
      {reply.kind === "loading" ? (
        <Placeholder>{TEXT.loading}</Placeholder>
      ) : reply.kind !== "loaded" ? (
        <p className="inline-error" role="alert">
          <StatusMark status="failed" className="symbol" />
          {TEXT.failed(reply.message)}
        </p>
      ) : (
        <div className="lg-box">
          {transcript?.truncated === true && (
            <p className="lg-cap">
              <span>{capNote(transcript, "Showing the last")}</span>
              <OpenFile bridge={bridge} name={{ itemId: item.id, stepIndex: index, attempt: attempt.attempt, file: "transcript" }} />
            </p>
          )}
          <div className="lg-body" tabIndex={0} role="region" aria-label={TEXT.transcript(title)}>
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
                <span className="lg-label">{info === undefined ? TEXT.final : `${TEXT.final} · ${info.name}`}</span>
                <div className="lg-final-text">{reply.data.final.text}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
