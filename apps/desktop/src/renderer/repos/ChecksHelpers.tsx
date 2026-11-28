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
import { breaksRule, type CheckLine, checksNotRun, couldNotStartText, failedWithoutSetup, lineOf, RULE_TEXT, SETUP_RULE_TEXT, sendsOf, setupFailed, setupLineOf, summaryOf, targetOf, trialTitle } from "./checks-model.js";
import type { ChecksHelpers, SuggestState } from "./useChecksHelpers.js";

const TEXT = {
  try: "Try checks",
  trySetup: "Try setup",
  setupGroup: "Setup",
  checksGroup: "Checks",
  setupCommandGroup: "Setup command",
  useAsSetup: "Use as setup",
  replaceSetup: "Replace setup",
  inSetup: "In Setup command",
  alreadySetup: "already the setup command",
  fieldHolds: "The field holds another command: ",
  aiWroteSetup: "The AI wrote these lines. Tokama has not run them. A setup command usually downloads and runs code from a package registry, so read it before you use it. Nothing runs until you press Try checks or start work.",
  setupFailedFoot: "The checks need the setup command to pass first. Change the command, or fix what it complains about, and try again.",
  canStillSave: (editing: boolean) => `You can still ${editing ? "save" : "add"} the repo.`,
  noSetupSet: "No setup command is set. The run used a new worktree, which has no installed packages. If the output says a command or a package is missing, that is why.",
  addOneAbove: " Add one above, or use Suggest with AI.",
  useCommandAsSetup: "as setup",
  foundIn: (file: string) => `found ${file}`,
  suggest: "Suggest with AI",
  stop: "Stop",
  stopSuggesting: "Stop suggesting",
  stopTrying: "Stop trying checks",
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
  sentWhat: (sends: string) => `${sends.charAt(0).toUpperCase()}${sends.slice(1)} of this folder.`,
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
  /** The Setup command field as one command; empty when none. */
  readonly setup: string;
  /** Puts a command in the Setup command field, in the place of what it holds. */
  readonly onUseSetup: (command: string) => void;
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
    <span className="ch-status">
      <StatusMark status={reading ? "queued" : "running"} />
      {/* Only the phase is announced: the clock beside it changes every second. */}
      <span className="ch-status-word" role="status">
        {word}
      </span>
      <span className="ch-time mono">{formatDuration(now - state.since)}</span>
      <Button variant="link" size="sm" aria-label={TEXT.stopSuggesting} onClick={h.stopSuggest}>
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
        <dd>{TEXT.sentWhat(h.summary === undefined ? "file names and build files" : sendsOf(h.summary))}</dd>
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
export function ChecksHelpersRow({ h, lines, onAdd, setup, onUseSetup, baseBranch, editing, onOpenGetStarted }: ChecksHelpersProps) {
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
                <Button aria-label={TEXT.stopTrying} onClick={h.stopTrial}>
                  <StopIcon />
                  {TEXT.stop}
                </Button>
              ) : (
                <Button disabled={!h.hasWork || h.tryProblem !== undefined} onClick={h.startTrial}>
                  <PlayIcon />
                  {lines.length === 0 && setup !== "" ? TEXT.trySetup : TEXT.try}
                </Button>
              ))}
            {suggestShown && (h.suggest.kind === "running" ? <Running h={h} state={h.suggest} /> : <SuggestButton h={h} />)}
          </div>
          {h.canTry && h.tryProblem !== undefined && <p className="repo-hint">{h.tryProblem}</p>}
          {suggestShown && h.suggest.kind !== "running" && (answered ? <Disclosure h={h} /> : <SuggestNotice h={h} onOpenGetStarted={onOpenGetStarted} />)}
          {suggestShown && h.suggest.kind === "running" && <RunningLine h={h} />}
        </>
      )}
      {h.suggest.kind === "answer" && <Suggestions key={h.suggest.id} h={h} result={h.suggest.result} lines={lines} onAdd={onAdd} setup={setup} onUseSetup={onUseSetup} />}
      {h.trial.kind !== "idle" && <Trial h={h} lines={lines} setup={setup} onUseSetup={onUseSetup} baseBranch={baseBranch} editing={editing} />}
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
  readonly setup: string;
  readonly onUseSetup: (command: string) => void;
}

/**
 * The answer's setup row, first under its own heading. It goes only into the Setup command field,
 * by "Use as setup" or "Replace setup"; "Add all new" never takes it.
 */
function SetupSuggestion({ row, setup, onUse }: { readonly row: NonNullable<SuggestChecksResult["setup"]>; readonly setup: string; readonly onUse: (command: string) => void }) {
  const [removed, setRemoved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  // The command this row put in the field, so it can say "In Setup command" for it and not "already".
  const [used, setUsed] = useState<string | undefined>(undefined);
  if (removed) return null;
  const command = used ?? row.command;
  const problem = editing && (edited.trim() === "" || breaksRule(edited));
  const use = (text: string) => {
    onUse(text);
    setUsed(text);
    setEditing(false);
  };
  return (
    <>
      <p className="ch-group">{TEXT.setupCommandGroup}</p>
      <ul className="ch-rows">
        <li className="ch-row">
          {editing ? (
            <>
              <div className="ch-row-main">
                <textarea
                  className="mono ch-edit"
                  aria-label={`Edit the setup command ${row.command}`}
                  aria-invalid={problem || undefined}
                  rows={1}
                  value={edited}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => setEdited(event.target.value.replaceAll("\n", " "))}
                  onKeyDown={(event) => {
                    // The dialog is a form: Enter here uses the command, it does not save the repo.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!problem) use(edited.trim());
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(false);
                    }
                  }}
                />
                <span className="ch-row-actions">
                  <Button size="sm" disabled={problem} onClick={() => use(edited.trim())}>
                    {setup === "" ? TEXT.useAsSetup : TEXT.replaceSetup}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setEditing(false)}>
                    {TEXT.cancel}
                  </Button>
                </span>
              </div>
              <p className="ch-why">{row.why}</p>
              {problem && edited.trim() !== "" && (
                <p className="ch-problem">
                  <StatusMark status="failed" /> {SETUP_RULE_TEXT}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="ch-row-main">
                <span className="ch-command" data-dim={setup === command || undefined}>
                  <span className="mono ch-command-text">{command}</span> <span className="ch-dim">{`about ${row.minutes} min`}</span>
                </span>
                <span className="ch-row-actions">
                  {setup === command ? (
                    used !== undefined ? (
                      <span className="ch-added">
                        <StatusMark status="passed" /> {TEXT.inSetup}
                      </span>
                    ) : (
                      <span className="ch-dim">{TEXT.alreadySetup}</span>
                    )
                  ) : (
                    <>
                      <Button size="sm" aria-label={`${setup === "" ? TEXT.useAsSetup : TEXT.replaceSetup} ${command}`} onClick={() => use(command)}>
                        {setup === "" ? TEXT.useAsSetup : TEXT.replaceSetup}
                      </Button>
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        aria-label={`Edit ${command}`}
                        title={TEXT.edit}
                        onClick={() => {
                          setEditing(true);
                          setEdited(command);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <CloseButton size="icon-sm" label={`Remove ${command}`} onClick={() => setRemoved(true)} />
                    </>
                  )}
                </span>
              </div>
              <p className="ch-why" data-dim={setup === command || undefined}>
                {row.why}
              </p>
              {setup !== "" && setup !== command && (
                <p className="ch-why">
                  {TEXT.fieldHolds}
                  <span className="mono">{setup}</span>.
                </p>
              )}
            </>
          )}
        </li>
      </ul>
    </>
  );
}

/** The answer: one row per suggested check, each added, edited or removed by hand; a setup row first when there is one. */
function Suggestions({ h, result, lines, onAdd, setup, onUseSetup }: SuggestionsProps) {
  const target = (h.summary === undefined ? undefined : targetOf(h.summary)) ?? "the AI tool";
  // Commands the user added from this list, so a row can say "Added" and not "already in Checks".
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [edited, setEdited] = useState("");
  // A row added after an edit stands for the edited command from then on, so the original cannot be added too.
  const [replaced, setReplaced] = useState<ReadonlyMap<string, string>>(new Map());
  const [dismissed, setDismissed] = useState(false);
  // Every hook is above this line: a card that closes must render the same hooks as one that is open.
  if (dismissed) return null;
  const shown = (check: { readonly command: string }) => replaced.get(check.command) ?? check.command;
  const rows = result.checks.filter((check) => !removed.has(check.command));
  const fresh = rows.filter((check) => !lines.includes(shown(check)));
  const add = (commands: readonly string[]) => {
    onAdd(commands);
    setAdded(new Set([...added, ...commands]));
  };
  const addEdited = (original: string) => {
    const command = edited.trim();
    add([command]);
    setReplaced(new Map(replaced).set(original, command));
    setEditing(undefined);
  };
  const setupRow = result.setup;
  if (result.checks.length === 0 && setupRow === undefined) {
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
          {TEXT.suggestedBy(target)}{" "}
          <span className="ch-dim">{`${setupRow === undefined ? "" : "1 setup · "}${rows.length} ${rows.length === 1 ? "check" : "checks"} · ${fresh.length} new`}</span>
        </span>
        <span className="ch-card-actions">
          <Button size="sm" disabled={fresh.length === 0} onClick={() => add(fresh.map(shown))}>
            {TEXT.addAllNew}
          </Button>
          <CloseButton size="icon-sm" label={TEXT.closeNote} onClick={() => setDismissed(true)} />
        </span>
      </div>
      {setupRow !== undefined && <SetupSuggestion row={setupRow} setup={setup} onUse={onUseSetup} />}
      {setupRow !== undefined && rows.length > 0 && <p className="ch-group">{TEXT.checksGroup}</p>}
      <ul className="ch-rows">
        {rows.map((check) => {
          const command = shown(check);
          const inField = lines.includes(command);
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
                          if (!problem) addEdited(check.command);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditing(undefined);
                        }
                      }}
                    />
                    <span className="ch-row-actions">
                      <Button size="sm" disabled={problem} onClick={() => addEdited(check.command)}>
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
                      <span className="mono ch-command-text">{command}</span> <span className="ch-dim">{`about ${check.minutes} min`}</span>
                    </span>
                    <span className="ch-row-actions">
                      {inField ? (
                        added.has(command) ? (
                          <span className="ch-added">
                            <StatusMark status="passed" /> {TEXT.added}
                          </span>
                        ) : (
                          <span className="ch-dim">{TEXT.already}</span>
                        )
                      ) : (
                        <>
                          <Button size="sm" aria-label={`Add ${command}`} onClick={() => add([command])}>
                            {TEXT.add}
                          </Button>
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label={`Edit ${command}`}
                            title={TEXT.edit}
                            onClick={() => {
                              setEditing(check.command);
                              setEdited(command);
                            }}
                          >
                            <PencilIcon />
                          </Button>
                          <CloseButton size="icon-sm" label={`Remove ${command}`} onClick={() => setRemoved(new Set([...removed, check.command]))} />
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
      <p className="ch-card-foot">{setupRow === undefined ? TEXT.aiWrote : TEXT.aiWroteSetup}</p>
    </section>
  );
}

/** One line of a trial: mark, command, state and time, the output of a line that has one, and a note under the line. */
function TrialLine({ check, line, planned, note }: { readonly check: { readonly command: string; readonly outputTail?: string | undefined }; readonly line: CheckLine; readonly planned: boolean; readonly note?: string | undefined }) {
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
      {note !== undefined && <p className="ch-line">{note}</p>}
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
  readonly setup: string;
  readonly onUseSetup: (command: string) => void;
  readonly baseBranch: string;
  readonly editing: boolean;
}

/** The setup line and the checks of a trial, in two groups when there is a setup command; one list when not. */
function TrialRows({ trial, now, planned }: { readonly trial: CheckTrial; readonly now: number; readonly planned: boolean }) {
  const checks = (
    <ul className="ch-rows">
      {trial.checks.map((check, index) => (
        <TrialLine key={index} check={check} line={lineOf(check)} planned={planned} />
      ))}
    </ul>
  );
  if (trial.setup === undefined) return checks;
  const result = trial.setupResult ?? { state: "waiting" as const };
  return (
    <>
      <p className="ch-group">{TEXT.setupGroup}</p>
      <ul className="ch-rows">
        <TrialLine
          check={{ command: trial.setup, outputTail: result.outputTail }}
          line={setupLineOf(result, now)}
          planned={planned}
          note={result.couldNotStart?.word === undefined ? undefined : couldNotStartText(result.couldNotStart.word, result.couldNotStart.reason)}
        />
      </ul>
      {trial.checks.length > 0 && (
        <>
          <p className="ch-group">{TEXT.checksGroup}</p>
          {checks}
        </>
      )}
    </>
  );
}

/** A Try checks run: its lines while it runs, then the results. Closed with the ✕; never saved. */
function Trial({ h, lines, setup, onUseSetup, baseBranch, editing }: TrialProps) {
  const state = h.trial;
  // The clock moves while a run goes (the setup line shows its running time) and slowly after it, for "just now".
  const now = useNow(state.kind === "running" || state.kind === "ended", state.kind === "running" ? 1_000 : 15_000);
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
    // Before the engine's first update, what was asked stands in for the trial.
    const shown: CheckTrial = state.trial ?? {
      trialId: "" as CheckTrial["trialId"],
      state: "running",
      startedAt: now,
      ...(state.setup === "" ? {} : { setup: state.setup, setupResult: { state: "waiting" as const } }),
      checks: state.lines.map((command) => ({ command, state: "waiting" as const })),
    };
    return (
      <section className="ch-card" aria-label="Try checks">
        <div className="ch-card-head">
          <span className="ch-card-title" role="status">
            {trialTitle(shown.setup !== undefined, shown.checks.length)} <span className="ch-dim">{TEXT.inWorktree(baseBranch.trim())}</span>
          </span>
        </div>
        <TrialRows trial={shown} now={now} planned={state.trial === undefined} />
        <p className="ch-card-foot">{TEXT.folderUntouched}</p>
      </section>
    );
  }
  const { trial } = state;
  const summary = summaryOf(trial);
  const changed = trial.checks.map((check) => check.command).join("\n") !== lines.join("\n") || (trial.setup ?? "") !== setup;
  const notRun = checksNotRun(trial);
  // No setup command and a check did not pass: a missing package may be why. A hint is a known file the trial's worktree held.
  const noSetupNote = failedWithoutSetup(trial) && setup === "";
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
      <TrialRows trial={trial} now={now} planned={false} />
      {noSetupNote ? (
        <div className="ch-card-foot">
          <p>
            {TEXT.noSetupSet}
            {trial.setupHint === undefined && TEXT.addOneAbove}
            {TEXT.failingOk(editing)}
          </p>
          {trial.setupHint !== undefined && (
            <p className="ch-hint-row">
              <Button size="sm" onClick={() => onUseSetup(trial.setupHint!.command)}>
                Use <span className="mono">{trial.setupHint.command}</span> {TEXT.useCommandAsSetup}
              </Button>
              <span className="ch-dim">{TEXT.foundIn(trial.setupHint.from)}</span>
            </p>
          )}
        </div>
      ) : setupFailed(trial) ? (
        <p className="ch-card-foot">
          {notRun > 0 && `${TEXT.setupFailedFoot} `}
          {TEXT.canStillSave(editing)}
        </p>
      ) : (
        <p className="ch-card-foot">
          {TEXT.freshWorktree}
          {summary.tone === "fail" && TEXT.failingOk(editing)}
        </p>
      )}
    </section>
  );
}
