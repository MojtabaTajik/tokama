// What the repo dialog shows for the two checks helpers: the buttons under the Checks field, the
// line under them, the list of suggested checks and the lines of a Try checks run. Everything an
// AI answer or a command prints (a command, its reason, the note, the output) is React text and
// nothing else, and a command is never cut: it wraps. A suggestion is only a line of text until
// the user adds it; nothing here adds or runs a command by itself.
import type { CheckTrial, SuggestChecksResult } from "@tokama/core";
import { type ReactNode, useState } from "react";
import { backendOf } from "../brand/backends/index.js";
import { formatDuration } from "../format/duration.js";
import { useNow } from "../useNow.js";
import { Button, CloseButton } from "../ui/Button.js";
import { CopyButton, toClipboard } from "../ui/CopyButton.js";
import { ChevronIcon, CopyIcon, PencilIcon, PlayIcon, StopIcon, SuggestIcon } from "../ui/icons.js";
import { StatusMark } from "../ui/status.js";
import { breaksRule, type CheckLine, lineOf, RULE_TEXT, sendsOf, summaryOf, targetOf } from "./checks-model.js";
import type { ChecksHelpers, SuggestState } from "./useChecksHelpers.js";

const TEXT = {
  try: "Try checks",
  suggest: "Suggest with AI",
  stop: "Stop",
  noSource: "No source files, no .env.",
  stays: "It stays on this computer.",
  noCli: "No AI CLI is ready on this computer.",
  noCliWhy: "Suggest with AI needs one that is installed and logged in. Get started shows the fix.",
  openGetStarted: "Open Get started",
  localOnly: "Off in local-only mode.",
  nothingSent: "Nothing is sent.",
  notAvailable: "Suggest with AI is not available.",
  tryAgain: "Try again",
  nothingAdded: "Nothing was added to Checks.",
  stopped: "Stopped.",
  consentTitle: (target: string) => `Send this folder's file names and build files to ${target}?`,
  sent: "Sent",
  sentWhat: "File and folder names, two levels deep. The text of build files, such as package.json, Makefile, CI workflows and the start of the README.",
  neverSent: "Never sent",
  neverSentWhat: "Source files, .env files, anything else in the folder.",
  goesTo: "Goes to",
  cloudTool: (target: string) => `${target}, a cloud AI tool. It leaves this computer.`,
  sendAndSuggest: "Send and suggest",
  notNow: "Not now",
  askedOnce: "Tokama asks this once per AI tool. After that the line under the button says what is sent, every time.",
  reading: "Reading file names and build files",
  asking: (target: string) => `Asking ${target}`,
  askingAgain: "Asking again, the first answer could not be read",
  suggestedBy: (target: string) => `Suggested by ${target}`,
  suggestedNone: (target: string) => `${target} suggested no checks`,
  itsNote: "Its note",
  withoutChecks: "You can add the repo without checks. Templates where you approve the change, like Quick change, work without them.",
  addAllNew: "Add all new",
  add: "Add",
  edit: "Edit",
  cancel: "Cancel",
  remove: "Remove",
  already: "already in Checks",
  added: "Added",
  aiWrote: "The AI wrote these lines. Tokama has not run them. Read a command before you add it: nothing runs until you press Try checks or start work.",
  trying: (count: number) => `Trying ${count} ${count === 1 ? "check" : "checks"}`,
  inWorktree: (branch: string) => (branch === "" ? "in a temporary worktree at the base branch" : `in a temporary worktree at ${branch}`),
  folderUntouched: "Your folder is not touched. The worktree is removed when the run ends.",
  freshWorktree: "The run used a fresh worktree, as every item does. Things that are not in git, such as installed packages or a build folder, can be missing there.",
  failingOk: (editing: boolean) => ` You can ${editing ? "save" : "add"} the repo with a failing check; Quick fix will stop on it until it passes.`,
  outputHead: "Output, last 2,000 characters",
  output: "Output",
  changedSince: "the checks changed since this run",
  justNow: "just now",
  closeResults: "Close the results",
  closeNote: "Close",
} as const;

export interface ChecksHelpersProps {
  readonly h: ChecksHelpers;
  /** The lines the Checks field has now. */
  readonly lines: readonly string[];
  /** Puts commands on new lines of the Checks field. */
  readonly onAdd: (commands: readonly string[]) => void;
  readonly baseBranch: string;
  readonly editing: boolean;
  readonly onOpenGetStarted?: (() => void) | undefined;
}

/** The sentence under the buttons that says what Suggest with AI sends where. */
function Disclosure({ h }: { readonly h: ChecksHelpers }) {
  const { summary } = h;
  if (summary === undefined) return null;
  const target = targetOf(summary);
  const local = summary.agent?.runsOn === "local";
  return (
    <p className="ch-line">
      {TEXT.suggest} sends the {sendsOf(summary)} of this folder to {target ?? "the AI tool"}. {TEXT.noSource}
      {local && ` ${TEXT.stays}`}
    </p>
  );
}

/** A mark, a head, and what follows it: the shape of every line about a helper that did not give an answer. */
function Notice({ mark, head, children, action }: { readonly mark: "failed" | "unknown" | "warning"; readonly head: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="ch-notice" role="status">
      <StatusMark status={mark} />
      <div className="ch-notice-body">
        <p className="ch-notice-head">{head}</p>
        {children !== undefined && <p className="ch-line">{children}</p>}
        {action}
      </div>
    </div>
  );
}

/** The line under Suggest with AI for every state of the helper but a running one and an answer. */
function SuggestNotice({ h, onOpenGetStarted }: { readonly h: ChecksHelpers; readonly onOpenGetStarted: (() => void) | undefined }) {
  const state = h.suggest;
  const target = h.summary === undefined ? undefined : targetOf(h.summary);
  if (state.kind === "failed") {
    const { failure } = state;
    return (
      <Notice
        mark="failed"
        head={failure.head}
        action={
          failure.action === "get-started" && onOpenGetStarted !== undefined ? (
            <Button variant="link" className="ch-action" onClick={onOpenGetStarted}>
              {TEXT.openGetStarted}
            </Button>
          ) : (
            <Button variant="link" className="ch-action" onClick={h.startSuggest}>
              {TEXT.tryAgain}
            </Button>
          )
        }
      >
        {failure.message === "" ? TEXT.nothingAdded : `${failure.message} ${TEXT.nothingAdded}`}
      </Notice>
    );
  }
  if (state.kind === "stopped") {
    return (
      <Notice mark="unknown" head={TEXT.stopped}>
        {TEXT.nothingAdded}
      </Notice>
    );
  }
  const availability = h.availability;
  if (availability?.kind === "no_cli") {
    return (
      <Notice
        mark="warning"
        head={TEXT.noCli}
        action={
          onOpenGetStarted === undefined ? undefined : (
            <Button variant="link" className="ch-action" onClick={onOpenGetStarted}>
              {TEXT.openGetStarted}
            </Button>
          )
        }
      >
        {TEXT.noCliWhy}
      </Notice>
    );
  }
  if (availability?.kind === "local_only") {
    return (
      <Notice mark="unknown" head={TEXT.localOnly}>
        {`It would send the ${h.summary === undefined ? "file names and build files" : sendsOf(h.summary)} of this folder to ${target ?? "a cloud AI tool"}. ${TEXT.nothingSent}`}
      </Notice>
    );
  }
  if (availability?.kind === "unavailable") {
    return (
      <Notice mark="warning" head={TEXT.notAvailable}>
        {availability.problem}
      </Notice>
    );
  }
  return <Disclosure h={h} />;
}

/** The status line of a running suggestion, in the place of the button: phase, time, Stop. */
function Running({ h, state }: { readonly h: ChecksHelpers; readonly state: Extract<SuggestState, { kind: "running" }> }) {
  const now = useNow(true);
  const target = (h.summary === undefined ? undefined : targetOf(h.summary)) ?? "the AI tool";
  const reading = state.phase === "gathering";
  const word = reading ? TEXT.reading : state.phase === "retrying" ? TEXT.askingAgain : TEXT.asking(target);
  return (
    <span className="ch-status" role="status">
      <StatusMark status={reading ? "queued" : "running"} />
      <span className="ch-status-word">{word}</span>
      <span className="ch-time mono">{formatDuration(now - state.since)}</span>
      <Button variant="link" size="sm" onClick={h.stopSuggest}>
        {TEXT.stop}
      </Button>
    </span>
  );
}

/** The note that asks before the first send to a cloud AI tool, in the place of the buttons. */
function Consent({ h }: { readonly h: ChecksHelpers }) {
  const target = (h.summary === undefined ? undefined : targetOf(h.summary)) ?? "the AI tool";
  const name = h.summary?.agent === undefined ? "the AI tool" : backendOf(h.summary.agent.cliId).name;
  return (
    <div className="ch-consent" role="group" aria-label="Before the first send">
      <p className="ch-consent-title">{TEXT.consentTitle(name)}</p>
      <dl className="ch-facts">
        <dt>{TEXT.sent}</dt>
        <dd>{TEXT.sentWhat}</dd>
        <dt>{TEXT.neverSent}</dt>
        <dd>{TEXT.neverSentWhat}</dd>
        <dt>{TEXT.goesTo}</dt>
        <dd>{TEXT.cloudTool(target)}</dd>
      </dl>
      <div className="ch-consent-buttons">
        <Button onClick={h.agree}>{TEXT.sendAndSuggest}</Button>
        <Button onClick={h.notNow}>{TEXT.notNow}</Button>
      </div>
      <p className="ch-line">{TEXT.askedOnce}</p>
    </div>
  );
}

/** Suggest with AI and the line under it, for the "No checks found" box, where Try checks would have nothing to run. */
export function SuggestInBox({ h, onOpenGetStarted }: Pick<ChecksHelpersProps, "h" | "onOpenGetStarted">) {
  if (!h.loaded || h.availability === undefined) return null;
  if (h.suggest.kind === "consent") return <Consent h={h} />;
  return (
    <div className="ch-box">
      <div className="ch-buttons">
        <SuggestButton h={h} />
      </div>
      <SuggestNotice h={h} onOpenGetStarted={onOpenGetStarted} />
    </div>
  );
}

function SuggestButton({ h }: { readonly h: ChecksHelpers }) {
  return (
    <Button disabled={h.availability?.kind !== "ready"} onClick={h.startSuggest}>
      <SuggestIcon />
      {TEXT.suggest}
    </Button>
  );
}

/** The two buttons under the Checks field, the line under them, and the lists they open. */
export function ChecksHelpersRow({ h, lines, onAdd, baseBranch, editing, onOpenGetStarted }: ChecksHelpersProps) {
  const suggestShown = h.loaded && h.availability !== undefined;
  const trying = h.trial.kind === "running";
  const answered = h.suggest.kind === "answer";
  return (
    <div className="ch">
      {h.suggest.kind === "consent" ? (
        <Consent h={h} />
      ) : (
        <>
          <div className="ch-buttons">
            {h.canTry &&
              (trying ? (
                <Button onClick={h.stopTrial}>
                  <StopIcon />
                  {TEXT.stop}
                </Button>
              ) : (
                <Button disabled={lines.length === 0 || h.tryProblem !== undefined} onClick={h.startTrial}>
                  <PlayIcon />
                  {TEXT.try}
                </Button>
              ))}
            {suggestShown && (h.suggest.kind === "running" ? <Running h={h} state={h.suggest} /> : <SuggestButton h={h} />)}
          </div>
          {h.canTry && h.tryProblem !== undefined && <p className="repo-hint">{h.tryProblem}</p>}
          {suggestShown && h.suggest.kind !== "running" && (answered ? <Disclosure h={h} /> : <SuggestNotice h={h} onOpenGetStarted={onOpenGetStarted} />)}
          {suggestShown && h.suggest.kind === "running" && <RunningLine h={h} />}
        </>
      )}
      {h.suggest.kind === "answer" && <Suggestions key={h.suggest.id} h={h} result={h.suggest.result} lines={lines} onAdd={onAdd} />}
      {h.trial.kind !== "idle" && <Trial h={h} lines={lines} baseBranch={baseBranch} editing={editing} />}
    </div>
  );
}

/** What a running suggestion sends, in words. The engine does not report counts or names, so this is the helper's own list. */
function RunningLine({ h }: { readonly h: ChecksHelpers }) {
  const target = (h.summary === undefined ? undefined : targetOf(h.summary)) ?? "the AI tool";
  return <p className="ch-line">{`Sending the ${h.summary === undefined ? "file names and build files" : sendsOf(h.summary)} of this folder to ${target}.`}</p>;
}

interface SuggestionsProps {
  readonly h: ChecksHelpers;
  readonly result: SuggestChecksResult;
  readonly lines: readonly string[];
  readonly onAdd: (commands: readonly string[]) => void;
}

/** The answer: one row per suggested check, each added, edited or removed by hand. */
function Suggestions({ h, result, lines, onAdd }: SuggestionsProps) {
  const target = (h.summary === undefined ? undefined : targetOf(h.summary)) ?? "the AI tool";
  // Commands the user added from this list, so a row can say "Added" and not "already in Checks".
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [edited, setEdited] = useState("");
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const rows = result.checks.filter((check) => !removed.has(check.command));
  const fresh = rows.filter((check) => !lines.includes(check.command));
  const add = (commands: readonly string[]) => {
    onAdd(commands);
    setAdded(new Set([...added, ...commands]));
  };
  if (result.checks.length === 0) {
    return (
      <section className="ch-card" aria-label="Suggested checks">
        <div className="ch-card-head">
          <span className="ch-card-title">{TEXT.suggestedNone(target)}</span>
          <CloseButton size="icon-sm" label={TEXT.closeNote} onClick={() => setDismissed(true)} />
        </div>
        {result.note !== undefined && (
          <div className="ch-card-body">
            <span className="ch-dim">{TEXT.itsNote}</span>
            <p className="ch-note">{result.note}</p>
          </div>
        )}
        <p className="ch-card-foot">{TEXT.withoutChecks}</p>
      </section>
    );
  }
  return (
    <section className="ch-card" aria-label="Suggested checks">
      <div className="ch-card-head">
        <span className="ch-card-title">
          {TEXT.suggestedBy(target)} <span className="ch-dim">{`${rows.length} ${rows.length === 1 ? "check" : "checks"} · ${fresh.length} new`}</span>
        </span>
        <span className="ch-card-actions">
          <Button size="sm" disabled={fresh.length === 0} onClick={() => add(fresh.map((check) => check.command))}>
            {TEXT.addAllNew}
          </Button>
          <CloseButton size="icon-sm" label={TEXT.closeNote} onClick={() => setDismissed(true)} />
        </span>
      </div>
      <ul className="ch-rows">
        {rows.map((check) => {
          const inField = lines.includes(check.command);
          const isEditing = editing === check.command;
          const problem = isEditing && (edited.trim() === "" || breaksRule(edited));
          return (
            <li key={check.command} className="ch-row">
              {isEditing ? (
                <>
                  <div className="ch-row-main">
                    <textarea
                      className="mono ch-edit"
                      aria-label={`Edit the command ${check.command}`}
                      aria-invalid={problem || undefined}
                      rows={1}
                      value={edited}
                      autoFocus
                      spellCheck={false}
                      onChange={(event) => setEdited(event.target.value.replaceAll("\n", " "))}
                      onKeyDown={(event) => {
                        // The dialog is a form: Enter here adds the row, it does not save the repo.
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (!problem) {
                            add([edited.trim()]);
                            setEditing(undefined);
                          }
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditing(undefined);
                        }
                      }}
                    />
                    <span className="ch-row-actions">
                      <Button
                        size="sm"
                        disabled={problem}
                        onClick={() => {
                          add([edited.trim()]);
                          setEditing(undefined);
                        }}
                      >
                        {TEXT.add}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setEditing(undefined)}>
                        {TEXT.cancel}
                      </Button>
                    </span>
                  </div>
                  <p className="ch-why">{check.why}</p>
                  {problem && edited.trim() !== "" && (
                    <p className="ch-problem">
                      <StatusMark status="failed" /> {RULE_TEXT}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="ch-row-main">
                    <span className="ch-command" data-dim={inField || undefined}>
                      <span className="mono ch-command-text">{check.command}</span> <span className="ch-dim">{`about ${check.minutes} min`}</span>
                    </span>
                    <span className="ch-row-actions">
                      {inField ? (
                        added.has(check.command) ? (
                          <span className="ch-added">
                            <StatusMark status="passed" /> {TEXT.added}
                          </span>
                        ) : (
                          <span className="ch-dim">{TEXT.already}</span>
                        )
                      ) : (
                        <>
                          <Button size="sm" aria-label={`Add ${check.command}`} onClick={() => add([check.command])}>
                            {TEXT.add}
                          </Button>
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label={`Edit ${check.command}`}
                            title={TEXT.edit}
                            onClick={() => {
                              setEditing(check.command);
                              setEdited(check.command);
                            }}
                          >
                            <PencilIcon />
                          </Button>
                          <CloseButton size="icon-sm" label={`Remove ${check.command}`} onClick={() => setRemoved(new Set([...removed, check.command]))} />
                        </>
                      )}
                    </span>
                  </div>
                  <p className="ch-why" data-dim={inField || undefined}>
                    {check.why}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="ch-card-foot">{TEXT.aiWrote}</p>
    </section>
  );
}

/** One line of a trial: mark, command, state and time, and the output of a line that has one. */
function TrialLine({ check, line, planned }: { readonly check: CheckTrial["checks"][number]; readonly line: CheckLine; readonly planned: boolean }) {
  const [open, setOpen] = useState(false);
  const status = line.tone === "pass" ? "passed" : line.tone === "fail" ? "failed" : line.tone === "live" ? "running" : line.tone === "waiting" ? "queued" : "unknown";
  return (
    <li className="ch-trial-line" data-planned={planned || undefined}>
      <div className="ch-trial-row">
        <StatusMark status={status} />
        <span className="mono ch-command-text">{check.command}</span>
        <span className="ch-trial-state">
          <span className="ch-trial-word" data-tone={line.tone}>
            {line.word}
          </span>
          {line.time !== undefined && <span className="ch-time mono">{line.time}</span>}
          {line.hasOutput && (
            <Button variant="link" size="sm" className="ch-output-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="ch-chev" data-open={open || undefined}>
                <ChevronIcon size={12} />
              </span>
              {TEXT.output}
            </Button>
          )}
        </span>
      </div>
      {open && check.outputTail !== undefined && (
        <div className="ch-output">
          <div className="ch-output-head">
            <span className="ch-dim">{TEXT.outputHead}</span>
            <CopyButton variant="quiet" size="sm" copy={toClipboard(check.outputTail)} icon={<CopyIcon />} ariaLabel={`Copy the output of ${check.command}`} />
          </div>
          <pre className="mono ch-output-text">{check.outputTail}</pre>
        </div>
      )}
    </li>
  );
}

interface TrialProps {
  readonly h: ChecksHelpers;
  readonly lines: readonly string[];
  readonly baseBranch: string;
  readonly editing: boolean;
}

/** A Try checks run: its lines while it runs, then the results. Closed with the ✕; never saved. */
function Trial({ h, lines, baseBranch, editing }: TrialProps) {
  const state = h.trial;
  const now = useNow(state.kind === "ended", 15_000);
  if (state.kind === "idle") return null;
  if (state.kind === "error") {
    return (
      <section className="ch-card" aria-label="Try checks">
        <div className="ch-card-head">
          <span className="ch-card-title">
            <StatusMark status="failed" /> {state.message}
          </span>
          <CloseButton size="icon-sm" label={TEXT.closeResults} onClick={h.dismissTrial} />
        </div>
      </section>
    );
  }
  if (state.kind === "running") {
    const checks: CheckTrial["checks"] = state.trial?.checks ?? state.lines.map((command) => ({ command, state: "waiting" as const }));
    return (
      <section className="ch-card" aria-label="Try checks">
        <div className="ch-card-head">
          <span className="ch-card-title" role="status">
            {TEXT.trying(checks.length)} <span className="ch-dim">{TEXT.inWorktree(baseBranch.trim())}</span>
          </span>
        </div>
        <ul className="ch-rows">
          {checks.map((check, index) => (
            <TrialLine key={index} check={check} line={lineOf(check)} planned={state.trial === undefined} />
          ))}
        </ul>
        <p className="ch-card-foot">{TEXT.folderUntouched}</p>
      </section>
    );
  }
  const { trial } = state;
  const summary = summaryOf(trial);
  const changed = trial.checks.map((check) => check.command).join("\n") !== lines.join("\n");
  const took = trial.endedAt === undefined ? undefined : formatDuration(trial.endedAt - trial.startedAt);
  const age = trial.endedAt === undefined ? 0 : Math.max(0, now - trial.endedAt);
  return (
    <section className="ch-card" aria-label="Try checks results">
      <div className="ch-card-head">
        <span className="ch-card-title" role="status">
          <StatusMark status={summary.tone === "pass" ? "passed" : summary.tone === "fail" ? "failed" : "unknown"} /> {summary.text}{" "}
          <span className="ch-dim">
            {[took, age < 60_000 ? TEXT.justNow : `${formatDuration(age, "minutes")} ago`, changed ? TEXT.changedSince : undefined].filter((part) => part !== undefined).join(" · ")}
          </span>
        </span>
        <CloseButton size="icon-sm" label={TEXT.closeResults} onClick={h.dismissTrial} />
      </div>
      <ul className="ch-rows">
        {trial.checks.map((check, index) => (
          <TrialLine key={index} check={check} line={lineOf(check)} planned={false} />
        ))}
      </ul>
      <p className="ch-card-foot">
        {TEXT.freshWorktree}
        {summary.tone === "fail" && TEXT.failingOk(editing)}
      </p>
    </section>
  );
}
