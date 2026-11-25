// The Checks tab: one section per attempt of each step that runs checks, oldest first. Each check
// command shows its result as a mark and a word, its exit code, duration and a one-line summary;
// a failed one opens with the end of its saved output, passed ones start folded, and commands of
// a running attempt that have not run yet wait. Output is engine text, already cleaned of terminal
// control sequences by the engine, and shown as React text only.
import type { AttemptCheck, CheckState, ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import { attemptsOf, capNote, checkedStepName, checkSteps, durationText, type StepAttempt, useAttemptReply } from "./attempt-view.js";
import { OpenFile } from "./OpenFile.js";
import { type Mark, markOf, StatusMark } from "../ui/status.js";
import { Placeholder } from "../ui/EmptyState.js";

const TEXT = {
  noChecks: "This item's steps run no checks.",
  noAttempts: (step: string) => `No attempts yet. Tokama runs the checks after each ${step} attempt.`,
  attempt: (n: number, fresh: boolean) => `Attempt ${n}${fresh ? " · fresh session" : ""}`,
  loading: "Loading the checks",
  failed: (message: string) => `Could not load the checks: ${message}`,
  noneRan: "No checks ran in this attempt.",
  noneYet: (step: string) => `The checks run when ${step} ends.`,
  waiting: (step: string) => `runs when ${step} ends`,
  running: "running",
  output: "Output · stdout and stderr",
  notSaved: "The output of this check was not saved.",
  noOutput: "It wrote no output.",
  exit: "exit ",
  signal: "signal",
  columns: ["Result", "Command", "Exit", "Duration", "Summary"],
  checkCount: (failed: number, all: number) => `${failed} of ${all} ${all === 1 ? "check" : "checks"} failed`,
  passedCount: (all: number) => `${all} ${all === 1 ? "check" : "checks"} passed`,
} as const;

const STATE: Record<CheckState, Mark> = {
  passed: markOf("passed"),
  failed: markOf("failed"),
  running: markOf("running"),
  waiting: markOf("waiting"),
  not_run: markOf("warning", "did not run"),
};

const RESULT: Record<string, Mark> = {
  passed: markOf("passed"),
  failed: markOf("failed"),
  run_failed: markOf("run_failed"),
  stopped: markOf("stopped"),
  running: markOf("running"),
};

export interface ChecksTabProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  /** The full view: one row per command, in columns. */
  readonly full: boolean;
}

export function ChecksTab({ bridge, item, setup, full }: ChecksTabProps) {
  const steps = checkSteps(item, setup);
  if (steps.length === 0) return <Placeholder>{TEXT.noChecks}</Placeholder>;
  const attempts = attemptsOf(item, steps);
  if (attempts.length === 0) return <Placeholder>{TEXT.noAttempts(checkedStepName(item, steps[0]!))}</Placeholder>;
  return (
    <div className="ck" data-full={full ? "true" : undefined}>
      {attempts.map((entry) => (
        <AttemptChecks key={`${entry.index} ${entry.attempt.attempt}`} bridge={bridge} item={item} entry={entry} named={steps.length > 1} />
      ))}
    </div>
  );
}

function AttemptChecks({ bridge, item, entry, named }: { readonly bridge: TokamaBridge; readonly item: ItemRecord; readonly entry: StepAttempt; readonly named: boolean }) {
  const { index, step, attempt } = entry;
  const running = attempt.result === undefined;
  const reply = useAttemptReply(bridge, "attempt_checks", { itemId: item.id, stepIndex: index, attempt: attempt.attempt }, `${attempt.result ?? ""} ${attempt.checks.length}`, running);
  const result = RESULT[attempt.result ?? "running"]!;
  const failedCount = attempt.checks.filter((check) => !check.passed).length;
  const word =
    attempt.result === "failed" && failedCount > 0
      ? `${result.word} · ${TEXT.checkCount(failedCount, attempt.checks.length)}`
      : attempt.result === "passed" && attempt.checks.length > 0
        ? `${result.word} · ${TEXT.passedCount(attempt.checks.length)}`
        : result.word;
  const title = `${named ? `${step.name} · ` : ""}${TEXT.attempt(attempt.attempt, attempt.attempt > 1 && step.agentId !== undefined)}`;
  const checked = checkedStepName(item, index);
  return (
    <section className="ck-attempt" aria-label={title}>
      <p className="ck-attempt-head">
        <span className="mark" data-tone={result.tone} aria-hidden="true">
          {result.symbol}
        </span>
        <span className="ck-attempt-title">{title}</span>
        <span className="ck-attempt-word">{word}</span>
      </p>
      {reply.kind === "loading" ? (
        <Placeholder>{TEXT.loading}</Placeholder>
      ) : reply.kind !== "loaded" ? (
        <p className="drawer-error" role="alert">
          <StatusMark status="failed" className="symbol" />
          {TEXT.failed(reply.message)}
        </p>
      ) : reply.data.checks.length === 0 ? (
        <div className="ck-none">
          <p>{running ? TEXT.noneYet(checked) : TEXT.noneRan}</p>
          {!running && attempt.detail !== undefined && <p className="mono">{attempt.detail}</p>}
        </div>
      ) : (
        <>
          <div className="ck-columns" aria-hidden="true">
            <span />
            {TEXT.columns.map((column) => (
              <span key={column}>{column}</span>
            ))}
          </div>
          <ol className="ck-list">
            {reply.data.checks.map((check, at) => (
              <li key={at} className="ck-check" data-state={check.state}>
                <CheckRow bridge={bridge} check={check} name={{ itemId: item.id, stepIndex: index, attempt: attempt.attempt, file: at + 1 }} waitingFor={checked} />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

interface CheckRowProps {
  readonly bridge: TokamaBridge;
  readonly check: AttemptCheck;
  readonly name: { readonly itemId: string; readonly stepIndex: number; readonly attempt: number; readonly file: number };
  readonly waitingFor: string;
}

function CheckRow({ bridge, check, name, waitingFor }: CheckRowProps) {
  const state = STATE[check.state];
  const ended = check.state === "passed" || check.state === "failed";
  const summary = check.state === "waiting" ? TEXT.waiting(waitingFor) : check.summary !== "" ? check.summary : check.state === "running" ? TEXT.running : "";
  const cells = (
    <>
      <span className="ck-result" data-tone={state.tone}>
        <span aria-hidden="true">{state.symbol}</span> {state.word}
      </span>
      <span className="ck-cmd mono">$ {check.command}</span>
      <span className="ck-exit mono">
        {ended ? (
          <>
            <span className="ck-exit-word">{TEXT.exit}</span>
            {check.exitCode === null ? TEXT.signal : check.exitCode}
          </>
        ) : (
          "–"
        )}
      </span>
      <span className="ck-dur mono">{durationText(check.durationMs)}</span>
      <span className="ck-sum">{summary}</span>
    </>
  );
  if (check.state === "waiting") {
    return (
      <div className="ck-row">
        <span className="ck-chev" />
        {cells}
      </div>
    );
  }
  const output = check.output;
  return (
    <details className="ck-details" open={check.state === "failed"}>
      <summary className="ck-row">
        <span className="ck-chev" aria-hidden="true">
          ▸
        </span>
        {cells}
      </summary>
      <div className="ck-out">
        <p className="ck-out-head">
          <span>{TEXT.output}</span>
          {output?.truncated === true && (
            <>
              <span className="ck-cap">{capNote(output)}</span>
              <OpenFile bridge={bridge} name={name} />
            </>
          )}
        </p>
        {output === null ? (
          <p className="ck-out-none">{TEXT.notSaved}</p>
        ) : output.text === "" ? (
          <p className="ck-out-none">{TEXT.noOutput}</p>
        ) : (
          <pre className="ck-lines mono" tabIndex={0} aria-label={`${TEXT.output}: ${check.command}`}>
            {output.text}
          </pre>
        )}
      </div>
    </details>
  );
}
