// The Checks tab: one folded line per attempt of each step that runs checks, oldest first. The
// newest attempt that has results starts open; inside it each check command is a line with its
// mark and word, its exit code and duration, and a one-line summary. A failed command starts open
// with the end of its saved output, passed ones start folded, and commands of a running attempt
// that have not run yet wait. An attempt that ran no checks is one line that names them. Output is
// engine text, already cleaned of terminal control sequences by the engine, and shown as React
// text only.
import type { AttemptCheck, CheckState, ItemRecord, Setup } from "@tokama/core";
import { useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { formatDuration } from "../format/duration.js";
import { clock } from "../format/time.js";
import { attemptsOf, capNote, checkedStepName, checkSteps, durationText, plannedChecks, type StepAttempt, spokenDuration, useAttemptReply } from "./attempt-view.js";
import { OpenFile } from "./OpenFile.js";
import { Placeholder } from "../ui/EmptyState.js";
import { LinkedText } from "../ui/LinkedText.js";
import { Section, SectionList, useOpenSections } from "../ui/Section.js";
import { type Mark, markOf, StatusMark } from "../ui/status.js";

const TEXT = {
  setupGroup: "Setup",
  checksGroup: "Checks",
  setupFailed: "Setup failed",
  notRun: (count: number) => `${count} ${count === 1 ? "check" : "checks"} not run`,
  done: "Done",
  noChecks: "This item's steps run no checks.",
  noAttempts: (step: string) => `No attempts yet. Tokama runs the checks after each ${step} attempt.`,
  attempt: (n: number, fresh: boolean) => `Attempt ${n}${fresh ? " · fresh session" : ""}`,
  attempts: (n: number) => `${n} ${n === 1 ? "attempt" : "attempts"}`,
  loading: "Loading the checks",
  failed: (message: string) => `Could not load the checks: ${message}`,
  noneRan: "No checks ran in this attempt.",
  noneYet: (step: string) => `The checks run when ${step} ends.`,
  waiting: (step: string) => `runs when ${step} ends`,
  running: "running",
  output: "Output · stdout and stderr",
  notSaved: "The output of this check was not saved.",
  noOutput: "It wrote no output.",
  exit: "exit",
  signal: "signal",
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
  /** The full view: wider boxes for the output. */
  readonly full: boolean;
}

const keyOf = ({ index, attempt }: StepAttempt) => `${index}:${attempt.attempt}`;

/** An attempt has checks to show, or runs them now; one that ended without running any is only a line. */
const hasChecks = ({ attempt }: StepAttempt): boolean => attempt.checks.length > 0 || attempt.setup !== undefined || attempt.result === undefined;

export function ChecksTab({ bridge, item, setup, full }: ChecksTabProps) {
  const steps = checkSteps(item, setup);
  const attempts = attemptsOf(item, steps);
  const openable = attempts.filter(hasChecks);
  const newest = openable.reduce<StepAttempt | undefined>((best, entry) => (best === undefined || (entry.attempt.startedAt ?? 0) >= (best.attempt.startedAt ?? 0) ? entry : best), undefined);
  const { open, update } = useOpenSections(`${item.id}:Checks`, newest === undefined ? [] : [keyOf(newest)]);
  if (steps.length === 0) return <Placeholder>{TEXT.noChecks}</Placeholder>;
  if (attempts.length === 0) return <Placeholder>{TEXT.noAttempts(checkedStepName(item, steps[0]!))}</Placeholder>;
  return (
    <div className="ck" data-full={full ? "true" : undefined}>
      <SectionList
        facts={TEXT.attempts(attempts.length)}
        allOpen={openable.every((entry) => open.has(keyOf(entry)))}
        noneOpen={openable.every((entry) => !open.has(keyOf(entry)))}
        onExpandAll={() => update((keys) => openable.forEach((entry) => keys.add(keyOf(entry))))}
        onCollapseAll={() => update((keys) => keys.clear())}
      >
        {attempts.map((entry) => (
          <AttemptChecks
            key={keyOf(entry)}
            bridge={bridge}
            item={item}
            setup={setup}
            entry={entry}
            named={steps.length > 1}
            open={open.has(keyOf(entry))}
            onToggle={() =>
              update((keys) => {
                if (!keys.delete(keyOf(entry))) keys.add(keyOf(entry));
              })
            }
          />
        ))}
      </SectionList>
    </div>
  );
}

interface AttemptChecksProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly entry: StepAttempt;
  readonly named: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}

function AttemptChecks({ bridge, item, setup, entry, named, open, onToggle }: AttemptChecksProps) {
  const { index, step, attempt } = entry;
  // An attempt that waits on a setup that did not pass has not ended, and its checks never ran.
  const setupDown = attempt.setup?.passed === false;
  const notRun = item.decision?.setupFailed?.when === "checks" ? item.decision.setupFailed.checksNotRun : undefined;
  const result = setupDown && attempt.result === undefined ? markOf("failed") : RESULT[attempt.result ?? "running"]!;
  const failedCount = attempt.checks.filter((check) => !check.passed).length;
  const word =
    setupDown && attempt.result === undefined
      ? `${TEXT.setupFailed}${notRun === undefined ? "" : ` · ${TEXT.notRun(notRun)}`}`
      : attempt.result === "failed" && failedCount > 0
      ? `${result.word} · ${TEXT.checkCount(failedCount, attempt.checks.length)}`
      : attempt.result === "passed" && attempt.checks.length > 0
        ? `${result.word} · ${TEXT.passedCount(attempt.checks.length)}`
        : result.word;
  const title = `${named ? `${step.name} · ` : ""}${TEXT.attempt(attempt.attempt, attempt.attempt > 1 && step.agentId !== undefined)}`;
  const ran = hasChecks(entry);
  // An attempt that ran none names the commands it would have run, and why when the engine said.
  const facts = ran ? [...(attempt.startedAt === undefined ? [] : [clock(attempt.startedAt)]), ...(attempt.durationMs === undefined ? [] : [formatDuration(attempt.durationMs)])].join(" · ") : plannedChecks(item, setup, index).join(" · ");
  const spoken = ran && attempt.durationMs !== undefined ? [...(attempt.startedAt === undefined ? [] : [clock(attempt.startedAt)]), spokenDuration(attempt.durationMs)].join(", ") : undefined;
  return (
    <Section
      title={title}
      state={{ ...result, word }}
      facts={facts === "" ? undefined : facts}
      spokenFacts={spoken}
      summary={ran ? undefined : <LinkedText text={attempt.detail ?? TEXT.noneRan} />}
      disabled={!ran}
      open={open}
      onToggle={onToggle}
    >
      {() => <AttemptBody bridge={bridge} item={item} entry={entry} />}
    </Section>
  );
}

/** One open attempt's checks; they are asked for, and for a running attempt asked again, only while it is open. */
function AttemptBody({ bridge, item, entry }: { readonly bridge: TokamaBridge; readonly item: ItemRecord; readonly entry: StepAttempt }) {
  const { index, attempt } = entry;
  const running = attempt.result === undefined;
  const reply = useAttemptReply(bridge, "attempt_checks", { itemId: item.id, stepIndex: index, attempt: attempt.attempt }, `${attempt.result ?? ""} ${attempt.checks.length} ${attempt.setup === undefined ? "" : String(attempt.setup.passed)}`, running);
  const checked = checkedStepName(item, index);
  if (reply.kind === "loading") return <Placeholder>{TEXT.loading}</Placeholder>;
  if (reply.kind !== "loaded") {
    return (
      <p className="inline-error" role="alert">
        <StatusMark status="failed" className="symbol" />
        {TEXT.failed(reply.message)}
      </p>
    );
  }
  const { setup } = reply.data;
  if (reply.data.checks.length === 0 && setup === undefined) {
    return (
      <div className="ck-none">
        <p>{running ? TEXT.noneYet(checked) : TEXT.noneRan}</p>
        {!running && attempt.detail !== undefined && <p className="mono"><LinkedText text={attempt.detail} /></p>}
      </div>
    );
  }
  // A check the failed setup kept from starting is "Not run": grey, and never counted as failed or passed.
  const notRun = setup?.state === "failed";
  const list = (
    <ol className="ck-list">
      {reply.data.checks.map((check, at) => (
        <li key={at} className="ck-check" data-state={check.state}>
          <CheckRow
            bridge={bridge}
            check={check}
            name={{ itemId: item.id, stepIndex: index, attempt: attempt.attempt, file: at + 1 }}
            waitingFor={checked}
            {...(notRun && check.state === "not_run" ? { mark: markOf("unknown", "Not run") } : {})}
          />
        </li>
      ))}
    </ol>
  );
  // With a setup command the attempt reads as two groups, Setup first; without one it is the list as it was.
  if (setup === undefined) return list;
  return (
    <>
      <p className="ck-group">{TEXT.setupGroup}</p>
      <ol className="ck-list">
        <li className="ck-check" data-state={setup.state}>
          <CheckRow
            bridge={bridge}
            check={setup}
            name={{ itemId: item.id, stepIndex: index, attempt: attempt.attempt, file: "setup" }}
            waitingFor={checked}
            mark={setup.state === "passed" ? markOf("passed", TEXT.done) : undefined}
            whole
          />
        </li>
      </ol>
      {reply.data.checks.length > 0 && (
        <>
          <p className="ck-group">{TEXT.checksGroup}</p>
          {list}
        </>
      )}
    </>
  );
}

interface CheckRowProps {
  readonly bridge: TokamaBridge;
  readonly check: AttemptCheck;
  readonly name: { readonly itemId: string; readonly stepIndex: number; readonly attempt: number; readonly file: number | "setup" };
  readonly waitingFor: string;
  /** Draws the line with this mark and word in the place of the state's own. */
  readonly mark?: Mark | undefined;
  /** The command is shown whole, wrapping onto more lines, never cut. */
  readonly whole?: boolean;
}

/** One command: a failed one starts open with the end of its output, a passed one folded, one that waits is only a line. */
function CheckRow({ bridge, check, name, waitingFor, mark, whole }: CheckRowProps) {
  // Until the engineer folds or unfolds it, it is open exactly while it is failed.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const open = chosen ?? check.state === "failed";
  const ended = check.state === "passed" || check.state === "failed";
  const summary = check.state === "waiting" ? TEXT.waiting(waitingFor) : check.summary !== "" ? check.summary : check.state === "running" ? TEXT.running : undefined;
  const code = check.exitCode === null ? TEXT.signal : String(check.exitCode);
  const facts = [...(ended ? [`${TEXT.exit} ${code}`] : []), ...(check.durationMs === null ? [] : [durationText(check.durationMs)])].join(" · ");
  const spoken = [...(ended ? [check.exitCode === null ? "stopped by a signal" : `exit code ${check.exitCode}`] : []), ...(check.durationMs === null ? [] : [spokenDuration(check.durationMs)])].join(", ");
  const output = check.output;
  return (
    <Section
      level="attempt"
      className={whole === true ? "ck-line ck-whole" : "ck-line"}
      title={`$ ${check.command}`}
      state={mark ?? STATE[check.state]}
      facts={facts === "" ? undefined : facts}
      spokenFacts={spoken === "" ? undefined : spoken}
      summary={summary}
      disabled={check.state === "waiting"}
      open={open}
      onToggle={() => setChosen(!open)}
    >
      {() => (
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
      )}
    </Section>
  );
}
