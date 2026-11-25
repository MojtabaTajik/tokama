// The item drawer on the right of the board: kind, template, title and state; the "needs you"
// note with the decision's buttons; the tabs; the actions. It keeps its own copy of the item
// (useItem), so it works next to any list that opens it. The same component draws the item in the
// whole main area (the full view): a page header with ← back and ⤡, the decision as a bar pinned
// at the top while the page scrolls, and wide tabs. Both are one element, so switching keeps
// everything open in it: the tab, the chosen file, a note being written. Engine text (titles,
// questions, the cloud summary, step details, agent output, check output and transcripts) is
// rendered as React text only. While the item runs, the header shows the live activity line (who
// works, the latest action, the time) in place of the state line, and every item shows its step track.
import type { AgentSummary, CommandErrorCode, Decision, ItemRecord, Setup } from "@tokama/core";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BRIDGE_ERROR_CODES, type TokamaBridge } from "../../shared/bridge.js";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { itemElement } from "../list/useFocusFollow.js";
import { CollapseIcon, RepoIcon } from "../ui/icons.js";
import { ExpandButton } from "../ui/ExpandButton.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { changesRepo } from "./attempt-view.js";
import { ChecksTab } from "./ChecksTab.js";
import { attemptLine, decisionKind, hasEnded, nextRunLine, runLine, itemMark, KIND, outcomeLine, PRIVACY, stepAgent, stepMark, stepPosition, templateOf, whereLine } from "./describe.js";
import { DecisionChoices, inTextField } from "./DecisionChoices.js";
import { DiffTab, type DiffState } from "../ui/DiffView.js";
import { useDecisionDiff } from "./useDecisionDiff.js";
import { Finish } from "./Finish.js";
import { LogTab } from "./LogTab.js";
import { OutputTab, shownAttempt } from "./OutputTab.js";
import { StepOutput, StepPreview, type OutputState, useStepOutput } from "./StepOutput.js";
import { StoppedCard } from "./StoppedCard.js";
import { finishState, isDiscarded } from "./finish-view.js";
import { useItem } from "./useItem.js";
import { useActivity } from "./useActivity.js";
import { ActivityLine, StepTrack } from "./Progress.js";
import { attemptTime, stepTimes } from "./progress-view.js";
import { useNow } from "../useNow.js";
import { Button, CloseButton } from "../ui/Button.js";
import { ErrorRetry } from "../ui/ErrorRetry.js";
import { markOf } from "../ui/status.js";
import { AgentChip } from "../ui/agent.js";
import { Tabs } from "../ui/Tabs.js";
import { Placeholder } from "../ui/EmptyState.js";

const TEXT = {
  drawer: "Item",
  close: "Close",
  loading: "Loading the item",
  gone: "This item no longer exists.",
  loadFailed: "Could not load the item",
  needsYou: "Needs you",
  noQuestion: "This item waits for you, but the engine sent no question yet.",
  willBeSent: "Will be sent",
  notSentYet: "Nothing has been sent yet",
  views: "Views",
  noSteps: "This item has no steps.",
  attempts: "Attempts",
  actions: "Actions",
  stop: "Stop",
  stopQuestion: "Stop this item? The agent is stopped and the item ends. You can't continue it later. Changed files stay in the worktree.",
  stopConfirm: "Stop item",
  stopCancel: "Cancel",
  stale: "The question changed before your answer reached the engine. The drawer shows the item as it is now.",
  invalidChoice: (message: string) => `The engine did not accept that choice: ${message}`,
  alreadyEnded: "The item had already ended. The drawer shows the item as it is now.",
  notConnected: "Not connected to the engine. Try again when it is back.",
  failed: (message: string) => `Could not send it: ${message}`,
  committed: (commit: string) => `Committed · ${commit}`,
  committedLine: (title: string, branch: string | undefined) => `${title}${branch === undefined ? "" : ` · on ${branch}`} · Done`,
  makingChanges: (agent: string, run: string | undefined) => `${agent} is making your changes${run === undefined ? "" : ` · ${run}`}`,
  yourNote: (note: string) => `Your note: "${note}"`,
  wrote: (step: string, agent: string | undefined) => `${step} · what ${agent ?? "the agent"} wrote`,
  attempt: (attempt: number) => `attempt ${attempt}`,
  seeDiff: "See the changed files in the Diff tab",
  output: "Output",
  expand: "Open full view",
  collapse: "Close full view, back to the list with the drawer open (Esc)",
  collapseTip: "Close full view (Esc)",
  template: (name: string) => `template ${name}`,
} as const;

export type Tab = "Steps" | "Output" | "Diff" | "Checks" | "Log";

/** A decision carries a diff worth showing while its change is loading or lists a changed file. */
const carriesDiff = (diff: DiffState | undefined): boolean => diff !== undefined && (diff.kind !== "loaded" || diff.diff.files.length + diff.diff.moreFiles > 0);

/**
 * The tabs, the same in the drawer and the full view: Diff only while a decision carries a diff
 * with changed files, Checks only on an item that changes a repo.
 */
export const tabsOf = (item: Pick<ItemRecord, "kind" | "repoIds">, diff: DiffState | undefined): readonly Tab[] => [
  "Steps",
  "Output",
  ...(carriesDiff(diff) ? (["Diff"] as const) : []),
  ...(changesRepo(item) ? (["Checks"] as const) : []),
  "Log",
];

export type Notice = { readonly tone: "warn" | "fail"; readonly text: string };

/** What the drawer says when a command fails, by error code. */
export function problem(code: string, message: string): Notice {
  switch (code as CommandErrorCode | (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES]) {
    case "stale_decision":
      return { tone: "warn", text: TEXT.stale };
    case "invalid_choice":
      return { tone: "fail", text: TEXT.invalidChoice(message) };
    case "invalid_state":
      return { tone: "warn", text: TEXT.alreadyEnded };
    case BRIDGE_ERROR_CODES.notConnected:
      return { tone: "fail", text: TEXT.notConnected };
    default:
      return { tone: "fail", text: TEXT.failed(message) };
  }
}

/** Codes after which the drawer's copy of the item is out of date. */
export const REFRESH_ON = new Set(["stale_decision", "invalid_state", "not_found"]);

export interface ItemDrawerProps {
  readonly bridge: TokamaBridge;
  readonly itemId: string;
  /** Names the item's template, agents and connections; undefined until the first load. */
  readonly setup: Setup | undefined;
  readonly onClose: () => void;
  /** Changes each time the engineer asks for the item's diff (Review the diff): the drawer shows its Diff tab. */
  readonly diffAsked?: number | undefined;
  /** Reads the setup again (Finish's Check again). */
  readonly onCheckAgain?: () => void;
  /** An agent tooltip's "Open in Settings →". */
  readonly onOpenAgent?: (agent: AgentTarget) => void;
  /**
   * What the list asked for this item: its Discard question, or a refusal to show. Each new `seq`
   * asks again.
   */
  readonly request?: { readonly seq: number; readonly discard?: true; readonly notice?: string } | undefined;
  /** ⤢: shows the item in the whole main area. Without it the drawer has no ⤢ buttons. */
  readonly onExpand?: (() => void) | undefined;
  /** Set while the item fills the main area instead of the drawer. */
  readonly expanded?: Expanded | undefined;
}

export interface Expanded {
  /** The list the item was opened from, for "← All work". */
  readonly back: string;
  /** The main area has room for a side-by-side diff. */
  readonly wide: boolean;
  /** ⤡, Escape and ← back: the list again, with the drawer on the same item and tab. */
  readonly onCollapse: () => void;
}

export function ItemDrawer({ bridge, itemId, setup, onClose, diffAsked, onCheckAgain, onOpenAgent, request, onExpand, expanded }: ItemDrawerProps) {
  const { item, error, refresh } = useItem(bridge, itemId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [tab, setTab] = useState<Tab>("Steps");
  const drawer = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const stopLink = useRef<HTMLButtonElement>(null);
  const refocusStop = useRef(false);
  const titleId = useId();
  // The item shown now, so a command reply for an item shown before is dropped.
  const currentId = useRef(itemId);
  currentId.current = itemId;

  // Focus moves into the drawer when it opens or shows another item; the opener is what had it
  // before, unless that was inside the drawer already.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!drawer.current?.contains(active)) opener.current = active;
    drawer.current?.focus();
    setNotice(undefined);
    setConfirmingStop(false);
    setBusy(false);
    setTab("Steps");
  }, [itemId]);
  // Focus follows the item into the full view and back into the drawer when the button that
  // switched it went away; focus elsewhere (the rail button that changed the page) stays.
  const full = expanded !== undefined;
  useLayoutEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) drawer.current?.focus();
  }, [full]);
  // A refusal of a command the list sent for this item, in the engine's words.
  useEffect(() => {
    if (request?.notice !== undefined) setNotice({ tone: "warn", text: request.notice });
  }, [request?.seq, request?.notice]);
  // On close, focus goes back to the opener, if it is still on the screen; if the item moved to
  // another group or column meanwhile, to the item's current row or card. Focus that already sits
  // on another control (the rail button that hid the drawer) stays there.
  useEffect(
    () => () => {
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
      else itemElement(currentId.current)?.focus();
    },
    [],
  );

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // In the full view, Escape in a field you type in belongs to the field.
      if (expanded !== undefined && inTextField(event.target)) return;
      event.preventDefault();
      if (confirmingStop) cancelStop();
      else if (expanded !== undefined) expanded.onCollapse();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const cancelStop = () => {
    refocusStop.current = true;
    setConfirmingStop(false);
  };
  // The Stop link is back once the confirmation is gone: a cancel returns focus to it.
  useEffect(() => {
    if (confirmingStop || !refocusStop.current) return;
    refocusStop.current = false;
    stopLink.current?.focus();
  }, [confirmingStop]);
  // A button that had focus can go with an update (a decision answered, the item stopped): focus
  // then stays in the drawer instead of falling back to the page.
  useEffect(() => {
    if (document.activeElement === document.body) drawer.current?.focus();
  }, [item]);

  /** Sends a command; the item itself changes through the engine's `item_updated` event. */
  const send = async (command: Parameters<TokamaBridge["command"]>[0]) => {
    const sentFor = currentId.current;
    setBusy(true);
    setNotice(undefined);
    const reply = await bridge.command(command).catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    // The drawer shows another item now: this reply, its notice and its busy state are not its own.
    if (currentId.current !== sentFor) return;
    setBusy(false);
    // The button that sent it can be gone (the Stop confirmation): keep focus in the drawer.
    if (document.activeElement === document.body || document.activeElement === null) drawer.current?.focus();
    if (reply.ok) return;
    // A refused finish action says why in the engine's own words.
    const refusedFinish = command.type === "finish_item" && (reply.error.code === "invalid_state" || reply.error.code === "invalid_request");
    setNotice(refusedFinish ? { tone: "warn", text: reply.error.message } : problem(reply.error.code, reply.error.message));
    if (REFRESH_ON.has(reply.error.code)) refresh();
  };

  const resolve = (decision: Decision, choice: string, note?: string) => {
    if (item) void send({ type: "resolve_decision", itemId: item.id, decisionId: decision.id, choice, ...(note !== undefined && { note }) });
  };
  const stop = () => {
    setConfirmingStop(false);
    if (item) void send({ type: "stop_item", itemId: item.id });
  };

  // Each new change approval opens on the Diff tab; once it is answered, the tab goes back to Steps.
  const changeAsked = item?.state === "needs_you" && item.decision?.hasDiff === true ? item.decision.id : undefined;
  const openedOn = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (changeAsked !== undefined && openedOn.current !== changeAsked) setTab("Diff");
    else if (changeAsked === undefined && openedOn.current !== undefined) setTab((current) => (current === "Diff" ? "Steps" : current));
    openedOn.current = changeAsked;
  }, [changeAsked]);
  // Only a new ask counts: a drawer that opens later does not jump to Diff for an old one.
  const lastAsked = useRef(diffAsked);
  useEffect(() => {
    if (diffAsked !== lastAsked.current) setTab("Diff");
    lastAsked.current = diffAsked;
  }, [diffAsked]);
  const diff = useDecisionDiff(bridge, itemId, item?.state === "needs_you" ? item.decision : undefined);
  // A step you approve shows what its agent wrote, from the latest attempt, for each new question.
  const approval = item?.state === "needs_you" && item.decision?.kind === "plan_approval" ? item.decision : undefined;
  // The full view's decision bar has no room for the output: each new question to approve one,
  // and each entry into the full view with one waiting, shows the Output tab (unless it has changed files to show on Diff).
  const outputAsked = full && approval !== undefined && !carriesDiff(diff) ? approval.id : undefined;
  const outputShownFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (outputAsked !== undefined && outputShownFor.current !== outputAsked) setTab("Output");
    outputShownFor.current = outputAsked;
  }, [outputAsked]);
  const output = useStepOutput(bridge, itemId, approval?.stepIndex ?? 0, undefined, approval?.id);
  const showTab = (to: Tab) => () => {
    setTab(to);
    document.getElementById(tabId(to))?.focus();
  };
  // A stopped step's "See the notes": the Output tab, scrolled to that step's section.
  const [notesOf, setNotesOf] = useState<{ readonly stepIndex: number; readonly seq: number } | undefined>(undefined);
  const showStopped = (to: "Output" | "Log", stepIndex: number) => {
    if (to === "Output") setNotesOf((last) => ({ stepIndex, seq: (last?.seq ?? 0) + 1 }));
    showTab(to)();
  };
  const stoppedDecision = item?.state === "needs_you" && item.decision?.stopped !== undefined ? { ...item.decision, stopped: item.decision.stopped } : undefined;
  const changedFiles = diff?.kind === "loaded" && diff.diff.files.length + diff.diff.moreFiles > 0;

  const template = item && templateOf(item, setup);
  const tabs = item ? tabsOf(item, diff) : [];
  const shown = tabs.includes(tab) ? tab : "Steps";
  // ⤢ on the diff inside the drawer: the full view on the Diff tab.
  const expandTo = onExpand === undefined || full ? undefined : (to: Tab) => () => {
    setTab(to);
    onExpand();
  };
  const decisionInfo = item?.decision === undefined ? undefined : agentInfo(item, item.decision.stepIndex, setup);

  const header = expanded !== undefined ? (
    // Keyed apart, so the button that switched the view goes with its header and focus moves to the view.
    <header key="full" className="ex-header">
      <div className="ex-heading">
        <Button variant="link" className="ex-back" onClick={expanded.onCollapse}>
          ← {expanded.back}
        </Button>
        {item ? (
          <>
            <h1 id={titleId}>{item.title}</h1>
            <LiveActivity bridge={bridge} item={item} agents={setup?.agents ?? []} />
            <StepTrack item={item} />
            <div className="ex-meta">
              <StateLine item={item} />
              <span className="ex-meta-part">
                <TemplateIcon icon={template?.icon} color={template?.color} />
                {TEXT.template(template?.name ?? item.templateId)}
              </span>
              {item.repoIds.length > 0 && (
                <span className="ex-meta-part">
                  <RepoIcon />
                  <span className="mono">{item.repoIds.join(", ")}</span>
                </span>
              )}
            </div>
          </>
        ) : (
          <Missing error={error} onRetry={refresh} />
        )}
      </div>
      <Button variant="secondary" className="ex-collapse" aria-label={TEXT.collapse} title={TEXT.collapseTip} onClick={expanded.onCollapse}>
        <CollapseIcon />
        <kbd>Esc</kbd>
      </Button>
    </header>
  ) : (
    <header key="drawer" className="drawer-header">
      {item ? (
        <div className="drawer-heading">
          <p className="drawer-kind">
            {KIND[item.kind].symbol} {KIND[item.kind].word} · <TemplateIcon icon={template?.icon} color={template?.color} />
            {template?.name ?? item.templateId} · {PRIVACY[item.privacy]}
          </p>
          <h2 id={titleId}>{item.title}</h2>
          <LiveActivity bridge={bridge} item={item} agents={setup?.agents ?? []} fallback={<StateLine item={item} />} />
          <StepTrack item={item} />
        </div>
      ) : (
        <div className="drawer-heading">
          <Missing error={error} onRetry={refresh} />
        </div>
      )}
      {item && onExpand !== undefined && (
        <ExpandButton className="drawer-expand" label={TEXT.expand} onClick={onExpand} />
      )}
      <CloseButton className="drawer-close" label={TEXT.close} onClick={onClose} />
    </header>
  );

  return (
    <section
      className={full ? "expanded" : "drawer"}
      role={full ? "main" : "complementary"}
      aria-label={item ? undefined : TEXT.drawer}
      aria-labelledby={item ? titleId : undefined}
      tabIndex={-1}
      ref={drawer}
    >
      {header}

      {notice && (
        <p className="drawer-notice" data-tone={notice.tone} role="status">
          <span className="symbol" aria-hidden="true">
            {markOf(notice.tone === "warn" ? "warning" : "failed").symbol}
          </span>
          {notice.text}
        </p>
      )}

      {stoppedDecision !== undefined && item !== undefined && (
        <StoppedCard bridge={bridge} item={item} setup={setup} decision={stoppedDecision} busy={busy} full={full} onChoose={resolve} onShow={showStopped} />
      )}
      {item?.state === "needs_you" && stoppedDecision === undefined && (
        <NeedsYou item={item} setup={setup} decision={item.decision} busy={busy} output={full ? undefined : output} full={full} changedFiles={changedFiles} onShowOutput={showTab("Output")} onShowDiff={showTab("Diff")} onChoose={resolve} />
      )}
      {item !== undefined && item.state !== "needs_you" && <After item={item} setup={setup} />}

      {item?.state === "done" && (
        <Finish
          item={item}
          setup={setup}
          busy={busy}
          askDiscard={request?.discard === true ? request.seq : undefined}
          {...(onCheckAgain !== undefined && { onCheckAgain })}
          onFinish={(action) => void send({ type: "finish_item", itemId: item.id, action })}
          onAcceptChanges={() => void send({ type: "accept_git_changes", itemId: item.id })}
        />
      )}

      {item && (
        <>
          <Tabs className="drawer-tabs" tabs={tabs} selected={shown} onSelect={setTab} label={TEXT.views} idOf={tabId} panelIdOf={panelId} />
          <div className="drawer-panel" role="tabpanel" id={panelId(shown)} aria-labelledby={tabId(shown)} data-tab={shown}>
            {shown === "Steps" ? (
              <Steps bridge={bridge} item={item} setup={setup} onOpenAgent={onOpenAgent} unfold={stoppedDecision?.stepIndex} />
            ) : shown === "Output" ? (
              <OutputTab bridge={bridge} item={item} setup={setup} full={full} onOpenAgent={onOpenAgent} focus={notesOf} />
            ) : shown === "Checks" ? (
              <ChecksTab bridge={bridge} item={item} setup={setup} full={full} />
            ) : shown === "Log" ? (
              <LogTab bridge={bridge} item={item} setup={setup} full={full} onOpenAgent={onOpenAgent} />
            ) : diff !== undefined ? (
              <DiffTab
                key={item.decision?.id}
                state={diff}
                baseBranch={setup?.repos.find((repo) => repo.id === item.repoIds[0])?.baseBranch}
                layout={expanded === undefined ? "drawer" : expanded.wide ? "wide" : "narrow"}
                onExpand={expandTo?.("Diff")}
                by={full && decisionInfo !== undefined ? <AgentLabel info={decisionInfo} onOpen={onOpenAgent} /> : undefined}
              />
            ) : null}
          </div>
          {confirmingStop ? (
            <ConfirmStop busy={busy} onStop={stop} onCancel={cancelStop} />
          ) : (
            !hasEnded(item) && (
              <div className="drawer-actions" role="group" aria-label={TEXT.actions}>
                <Button variant="danger" ref={stopLink} disabled={busy} onClick={() => setConfirmingStop(true)}>
                  {TEXT.stop}
                </Button>
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}

/** A discarded item's work is gone: it reads as discarded rather than done. */
const DISCARDED = { symbol: "⊘", word: "discarded", tone: "muted" } as const;

function StateLine({ item }: { readonly item: ItemRecord }) {
  const mark = isDiscarded(item) ? DISCARDED : itemMark(item.state);
  const position = stepPosition(item);
  const outcome = isDiscarded(item) ? undefined : (finishState(item) ?? outcomeLine(item));
  return (
    <p className="drawer-state">
      <span className="mark" data-tone={mark.tone} aria-hidden="true">
        {mark.symbol}
      </span>
      <span data-tone={mark.tone}>{mark.word}</span>
      {position && <span className="drawer-position"> · {position}</span>}
      {outcome && <span className="drawer-position mono"> · {outcome}</span>}
    </p>
  );
}

/**
 * The activity line while the item runs a step, ticking every second; `fallback` otherwise. Its
 * own component, so only this line renders again each second.
 */
function LiveActivity({ bridge, item, agents, fallback = null }: { readonly bridge: TokamaBridge; readonly item: ItemRecord; readonly agents: readonly AgentSummary[]; readonly fallback?: ReactNode }) {
  const running = item.state === "running" && item.steps.some((step) => step.state === "running");
  const activity = useActivity(bridge, item.id, running);
  const now = useNow(running);
  return running ? <ActivityLine item={item} activity={activity} agents={agents} now={now} /> : fallback;
}

function Missing({ error, onRetry }: { readonly error: { code: string; message: string } | undefined; readonly onRetry: () => void }) {
  if (!error) return <Placeholder>{TEXT.loading}</Placeholder>;
  if (error.code === "not_found") return <Placeholder>{TEXT.gone}</Placeholder>;
  return <ErrorRetry title={TEXT.loadFailed} detail={error.message} onRetry={onRetry} />;
}

interface NeedsYouProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly decision: Decision | undefined;
  readonly busy: boolean;
  /** What the step's agent wrote, for a step you approve; the full view shows it on the Output tab instead. */
  readonly output: OutputState | undefined;
  /** The full view: the decision as a bar pinned at the top, its buttons beside the question. */
  readonly full: boolean;
  /** The step changed files: the card links to the Diff tab. */
  readonly changedFiles: boolean;
  /** Show full plan: the Output tab. */
  readonly onShowOutput: () => void;
  readonly onShowDiff: () => void;
  readonly onChoose: (decision: Decision, choice: string, note?: string) => void;
}

function NeedsYou({ item, setup, decision, busy, output, full, changedFiles, onShowOutput, onShowDiff, onChoose }: NeedsYouProps) {
  const step = decision === undefined ? undefined : item.steps[decision.stepIndex];
  const agent = step?.agentId === undefined ? undefined : stepAgent(step, setup?.agents ?? []).name;
  const kind = decision === undefined ? undefined : decisionKind(decision);
  return (
    <section className={full ? "needs-you ex-decision" : "needs-you"} aria-label={TEXT.needsYou}>
      {decision ? (
        <>
          {kind !== undefined && <p className="needs-you-kind">{kind}</p>}
          <p className="needs-you-question">
            <span className="mark" aria-hidden="true">
              ⏸
            </span>
            {decision.question}
          </p>
          {decision.why !== undefined && <p className="needs-you-why">{decision.why}</p>}
          {decision.summaryText !== undefined && (
            <div className="cloud-summary">
              <p className="cloud-summary-label">
                <span>{TEXT.willBeSent}</span>
                <span className="muted">{TEXT.notSentYet}</span>
              </p>
              {/* Focusable, so a long summary can be scrolled with the keyboard. */}
              <pre className="cloud-summary-text mono" tabIndex={0} aria-label={TEXT.willBeSent}>
                {decision.summaryText}
              </pre>
            </div>
          )}
          {output !== undefined && step !== undefined && (
            <div className="step-output">
              <p className="step-output-label">
                <span>{TEXT.wrote(step.name, agent)}</span>
                {output.kind === "loaded" && <span className="muted mono">{TEXT.attempt(output.output.attempt)}</span>}
                {changedFiles && (
                  <Button variant="link" onClick={onShowDiff}>
                    {TEXT.seeDiff}
                  </Button>
                )}
              </p>
              <StepPreview state={output} label={TEXT.wrote(step.name, agent)} isPlan={step.name.toLowerCase() === "plan"} onShowFull={onShowOutput} />
            </div>
          )}
          <DecisionChoices key={decision.id} decision={decision} busy={busy} agent={agent} run={nextRunLine(step)} onChoose={(choice, note) => onChoose(decision, choice, note)} />
        </>
      ) : (
        <p className="needs-you-question">
          <span className="mark" aria-hidden="true">
            ⏸
          </span>
          {TEXT.noQuestion}
        </p>
      )}
    </section>
  );
}

/**
 * What happened after a decision: the commit an approval made, or the step running again with the
 * note of Request changes.
 */
function After({ item, setup }: { readonly item: ItemRecord; readonly setup: Setup | undefined }) {
  const commit = item.outcome?.commits?.[0];
  // After a merge the branch is gone: the Merged card in Finish says it all.
  if (item.state === "done" && commit !== undefined && item.finish?.merged === undefined) {
    return (
      <section className="after" data-tone="pass" aria-label={TEXT.committed(commit.commit.slice(0, 7))}>
        <span className="mark" aria-hidden="true">
          ✓
        </span>
        <div className="after-body">
          <p className="after-head">{TEXT.committed(commit.commit.slice(0, 7))}</p>
          <p className="after-text">{TEXT.committedLine(item.title, commit.branch)}</p>
        </div>
      </section>
    );
  }
  const step = item.steps.find((candidate) => candidate.state === "running" && candidate.changesNote !== undefined);
  if (step?.changesNote === undefined) return null;
  const line = TEXT.makingChanges(stepAgent(step, setup?.agents ?? []).name, runLine(step));
  return (
    <section className="after" data-tone="live" aria-label={line}>
      <span className="mark" aria-hidden="true">
        ●
      </span>
      <div className="after-body">
        <p className="after-head">{line}</p>
        <p className="after-text">{TEXT.yourNote(step.changesNote)}</p>
      </div>
    </section>
  );
}

const tabId = (tab: Tab) => `drawer-tab-${tab.toLowerCase()}`;
const panelId = (tab: Tab) => `drawer-panel-${tab.toLowerCase()}`;

interface StepsProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly onOpenAgent: ItemDrawerProps["onOpenAgent"];
  /** The step that stopped: its latest output starts unfolded. */
  readonly unfold?: number | undefined;
}

function Steps({ bridge, item, setup, onOpenAgent, unfold }: StepsProps) {
  if (item.steps.length === 0) return <Placeholder>{TEXT.noSteps}</Placeholder>;
  const agents = setup?.agents ?? [];
  const connections = setup?.connections ?? [];
  return (
    <ol className="steps">
      {item.steps.map((step, index) => {
        const mark = stepMark(step.state);
        const agent = stepAgent(step, agents);
        const tip = agentInfo(item, index, setup);
        const unfolded = index === unfold ? shownAttempt(step) : undefined;
        return (
          <li key={index} className="step" data-state={step.state}>
            <span className="mark" data-tone={mark.tone} aria-hidden="true">
              {mark.symbol}
            </span>
            <div className="step-body">
              <p className="step-name">
                {step.name}
                <span className="visually-hidden">, {mark.word}</span>
              </p>
              <div className="step-where">
                {tip === undefined ? (
                  <AgentChip agent={agent} />
                ) : (
                  <AgentLabel info={tip} onOpen={onOpenAgent} />
                )}{" "}
                <span>· {whereLine(step, agents, connections)}</span>
              </div>
              {(step.detail !== undefined || stepTimes(step).length > 0) && <p className="step-detail mono">{[...(step.detail === undefined ? [] : [step.detail]), ...stepTimes(step)].join(" · ")}</p>}
              {step.attempts !== undefined && step.attempts.length > 0 && (
                <ol className="step-attempts" aria-label={`${step.name}: ${TEXT.attempts}`}>
                  {step.attempts.map((attempt) => {
                    const line = attemptLine(attempt);
                    const took = attemptTime(attempt);
                    return (
                      <li key={attempt.attempt} className="step-attempt">
                        <span className="mono">
                          <span className="mark" data-tone={line.mark.tone} aria-hidden="true">
                            {line.mark.symbol}
                          </span>
                          {took === undefined ? line.text : `${line.text} · ${took}`}
                        </span>
                        {/* Only an ended attempt of an agent's step has an output. */}
                        {step.agentId !== undefined && attempt.result !== undefined && (
                          <AttemptOutput
                            bridge={bridge}
                            itemId={item.id}
                            stepIndex={index}
                            attempt={attempt.attempt}
                            label={`${step.name}, ${TEXT.attempt(attempt.attempt)}: ${TEXT.output}`}
                            unfolded={attempt.attempt === unfolded}
                          />
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** An attempt's output, collapsed; it is asked for the first time the engineer opens it. */
function AttemptOutput({
  bridge,
  itemId,
  stepIndex,
  attempt,
  label,
  unfolded,
}: {
  readonly bridge: TokamaBridge;
  readonly itemId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly label: string;
  /** Starts open: the output of the step that stopped. */
  readonly unfolded: boolean;
}) {
  const [opened, setOpened] = useState(unfolded);
  const output = useStepOutput(bridge, itemId, stepIndex, attempt, opened ? `${stepIndex} ${attempt}` : undefined);
  return (
    <details className="attempt-output" open={unfolded || undefined} onToggle={(event) => event.currentTarget.open && setOpened(true)}>
      <summary aria-label={label}>{TEXT.output}</summary>
      {output !== undefined && <StepOutput state={output} label={label} />}
    </details>
  );
}

function ConfirmStop({ busy, onStop, onCancel }: { readonly busy: boolean; readonly onStop: () => void; readonly onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="drawer-confirm" role="group" aria-label={TEXT.stopConfirm}>
      <p>{TEXT.stopQuestion}</p>
      <div className="choices">
        <Button variant="danger" disabled={busy} onClick={onStop}>
          {TEXT.stopConfirm}
        </Button>
        <Button variant="secondary" ref={cancel} onClick={onCancel}>
          {TEXT.stopCancel}
        </Button>
      </div>
    </div>
  );
}
