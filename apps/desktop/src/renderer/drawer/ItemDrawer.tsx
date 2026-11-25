// The item drawer on the right of the board: kind, template, title and state; the "needs you"
// note with the decision's buttons; the tabs; the actions. It keeps its own copy of the item
// (useItem), so it works next to any list that opens it. Engine text (titles, questions, the
// cloud summary, step details, agent output) is rendered as React text only.
import type { CommandErrorCode, Decision, ItemRecord, Setup } from "@tokama/core";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BRIDGE_ERROR_CODES, type TokamaBridge } from "../../shared/bridge.js";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { itemElement } from "../list/useFocusFollow.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { attemptLine, decisionKind, hasEnded, nextRunLine, runLine, itemMark, KIND, outcomeLine, PRIVACY, stepAgent, stepMark, stepPosition, templateOf, whereLine } from "./describe.js";
import { DecisionChoices } from "./DecisionChoices.js";
import { DiffTab, useDecisionDiff } from "./DiffView.js";
import { Finish } from "./Finish.js";
import { StepOutput, type OutputState, useStepOutput } from "./StepOutput.js";
import { finishState, isDiscarded } from "./finish-view.js";
import { useItem } from "./useItem.js";

const TEXT = {
  drawer: "Item",
  close: "Close",
  loading: "Loading the item",
  gone: "This item no longer exists.",
  loadFailed: "Could not load the item",
  retry: "Retry",
  needsYou: "Needs you",
  noQuestion: "This item waits for you, but the engine sent no question yet.",
  willBeSent: "Will be sent",
  notSentYet: "Nothing has been sent yet",
  views: "Views",
  later: (tab: string) => `${tab} comes later: the engine does not send this data yet.`,
  noSteps: "This item has no steps.",
  attempts: "Attempts",
  actions: "Actions",
  stop: "Stop",
  stopQuestion: "Stop this item? Its agent is stopped; what is recorded so far is kept.",
  stopConfirm: "Stop item",
  stopCancel: "Keep running",
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
} as const;

type Tab = "Steps" | "Log" | "Diff" | "Checks";
/** The tabs the drawer shows. Evidence and Findings are left out until the engine sends their data. */
const tabsOf = (item: Pick<ItemRecord, "kind">): readonly Tab[] =>
  item.kind === "task" ? ["Steps", "Log", "Diff", "Checks"] : ["Steps", "Log"];

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
}

export function ItemDrawer({ bridge, itemId, setup, onClose, diffAsked, onCheckAgain, onOpenAgent, request }: ItemDrawerProps) {
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
      event.preventDefault();
      if (confirmingStop) cancelStop();
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
  const output = useStepOutput(bridge, itemId, approval?.stepIndex ?? 0, undefined, approval?.id);
  const showDiff = () => {
    setTab("Diff");
    document.getElementById(tabId("Diff"))?.focus();
  };

  const template = item && templateOf(item, setup);
  const tabs = item ? tabsOf(item) : [];
  const shown = tabs.includes(tab) ? tab : "Steps";

  return (
    <aside className="drawer" aria-label={item ? undefined : TEXT.drawer} aria-labelledby={item ? titleId : undefined} tabIndex={-1} ref={drawer}>
      <header className="drawer-header">
        {item ? (
          <div className="drawer-heading">
            <p className="drawer-kind">
              {KIND[item.kind].symbol} {KIND[item.kind].word} · <TemplateIcon icon={template?.icon} color={template?.color} />
              {template?.name ?? item.templateId} · {PRIVACY[item.privacy]}
            </p>
            <h2 id={titleId}>{item.title}</h2>
            <StateLine item={item} />
          </div>
        ) : (
          <div className="drawer-heading">
            <Missing error={error} onRetry={refresh} />
          </div>
        )}
        <button type="button" className="drawer-close" aria-label={TEXT.close} title={TEXT.close} onClick={onClose}>
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      {notice && (
        <p className="drawer-notice" data-tone={notice.tone} role="status">
          <span className="symbol" aria-hidden="true">
            {notice.tone === "warn" ? "!" : "✕"}
          </span>
          {notice.text}
        </p>
      )}

      {item?.state === "needs_you" && <NeedsYou item={item} setup={setup} decision={item.decision} busy={busy} output={output} onShowDiff={showDiff} onChoose={resolve} />}
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
          <Tabs tabs={tabs} shown={shown} onPick={setTab} />
          <div className="drawer-panel" role="tabpanel" id={panelId(shown)} aria-labelledby={tabId(shown)}>
            {shown === "Steps" ? (
              <Steps bridge={bridge} item={item} setup={setup} onOpenAgent={onOpenAgent} />
            ) : shown === "Diff" && diff !== undefined ? (
              <DiffTab key={item.decision?.id} state={diff} baseBranch={setup?.repos.find((repo) => repo.id === item.repoIds[0])?.baseBranch} />
            ) : (
              <p className="placeholder">{TEXT.later(shown)}</p>
            )}
          </div>
          {confirmingStop ? (
            <ConfirmStop busy={busy} onStop={stop} onCancel={cancelStop} />
          ) : (
            !hasEnded(item) && (
              <div className="drawer-actions" role="group" aria-label={TEXT.actions}>
                <button type="button" className="choice danger" ref={stopLink} disabled={busy} onClick={() => setConfirmingStop(true)}>
                  {TEXT.stop}
                </button>
              </div>
            )
          )}
        </>
      )}
    </aside>
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

function Missing({ error, onRetry }: { readonly error: { code: string; message: string } | undefined; readonly onRetry: () => void }) {
  if (!error) return <p className="placeholder">{TEXT.loading}</p>;
  if (error.code === "not_found") return <p className="placeholder">{TEXT.gone}</p>;
  return (
    <div role="alert">
      <p className="drawer-error">
        <span className="symbol" aria-hidden="true">
          ✕
        </span>
        {TEXT.loadFailed}
      </p>
      <p className="detail">{error.message}</p>
      <button type="button" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </button>
    </div>
  );
}

interface NeedsYouProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly decision: Decision | undefined;
  readonly busy: boolean;
  /** What the step's agent wrote, for a step you approve. */
  readonly output: OutputState | undefined;
  readonly onShowDiff: () => void;
  readonly onChoose: (decision: Decision, choice: string, note?: string) => void;
}

function NeedsYou({ item, setup, decision, busy, output, onShowDiff, onChoose }: NeedsYouProps) {
  const step = decision === undefined ? undefined : item.steps[decision.stepIndex];
  const agent = step?.agentId === undefined ? undefined : stepAgent(step, setup?.agents ?? []).name;
  const kind = decision === undefined ? undefined : decisionKind(decision);
  return (
    <section className="needs-you" aria-label={TEXT.needsYou}>
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
                {decision.hasDiff === true && (
                  <button type="button" className="link" onClick={onShowDiff}>
                    {TEXT.seeDiff}
                  </button>
                )}
              </p>
              <StepOutput state={output} label={TEXT.wrote(step.name, agent)} />
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
  if (item.state === "done" && commit !== undefined) {
    return (
      <section className="after" data-tone="pass" aria-label={TEXT.committed(commit.commit.slice(0, 7))}>
        <p className="after-head">
          <span className="mark" aria-hidden="true">
            ✓
          </span>
          {TEXT.committed(commit.commit.slice(0, 7))}
        </p>
        <p className="after-text">{TEXT.committedLine(item.title, commit.branch)}</p>
      </section>
    );
  }
  const step = item.steps.find((candidate) => candidate.state === "running" && candidate.changesNote !== undefined);
  if (step?.changesNote === undefined) return null;
  const line = TEXT.makingChanges(stepAgent(step, setup?.agents ?? []).name, runLine(step));
  return (
    <section className="after" data-tone="live" aria-label={line}>
      <p className="after-head">
        <span className="mark" aria-hidden="true">
          ●
        </span>
        {line}
      </p>
      <p className="after-text">{TEXT.yourNote(step.changesNote)}</p>
    </section>
  );
}

const tabId = (tab: Tab) => `drawer-tab-${tab.toLowerCase()}`;
const panelId = (tab: Tab) => `drawer-panel-${tab.toLowerCase()}`;

function Tabs({ tabs, shown, onPick }: { readonly tabs: readonly Tab[]; readonly shown: Tab; readonly onPick: (tab: Tab) => void }) {
  // Arrow keys move between tabs; only the shown tab is in the Tab order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(shown) + step + tabs.length) % tabs.length] ?? shown;
    onPick(next);
    document.getElementById(tabId(next))?.focus();
  };
  return (
    <div className="drawer-tabs" role="tablist" aria-label={TEXT.views} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={tabId(tab)}
          aria-selected={tab === shown}
          aria-controls={tab === shown ? panelId(tab) : undefined}
          tabIndex={tab === shown ? 0 : -1}
          onClick={() => onPick(tab)}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

interface StepsProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly onOpenAgent: ItemDrawerProps["onOpenAgent"];
}

function Steps({ bridge, item, setup, onOpenAgent }: StepsProps) {
  if (item.steps.length === 0) return <p className="placeholder">{TEXT.noSteps}</p>;
  const agents = setup?.agents ?? [];
  const connections = setup?.connections ?? [];
  return (
    <ol className="steps">
      {item.steps.map((step, index) => {
        const mark = stepMark(step.state);
        const agent = stepAgent(step, agents);
        const tip = agentInfo(item, index, setup);
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
                  <>
                    <span className="dot" data-dot={agent.dot} aria-hidden="true" />
                    <span>{agent.name}</span>
                  </>
                ) : (
                  <AgentLabel info={tip} onOpen={onOpenAgent} />
                )}{" "}
                <span>· {whereLine(step, agents, connections)}</span>
              </div>
              {step.detail !== undefined && <p className="step-detail mono">{step.detail}</p>}
              {step.attempts !== undefined && step.attempts.length > 0 && (
                <ol className="step-attempts" aria-label={`${step.name}: ${TEXT.attempts}`}>
                  {step.attempts.map((attempt) => {
                    const line = attemptLine(attempt);
                    return (
                      <li key={attempt.attempt} className="step-attempt">
                        <span className="mono">
                          <span className="mark" data-tone={line.mark.tone} aria-hidden="true">
                            {line.mark.symbol}
                          </span>
                          {line.text}
                        </span>
                        {/* Only an ended attempt of an agent's step has an output. */}
                        {step.agentId !== undefined && attempt.result !== undefined && (
                          <AttemptOutput bridge={bridge} itemId={item.id} stepIndex={index} attempt={attempt.attempt} label={`${step.name}, ${TEXT.attempt(attempt.attempt)}: ${TEXT.output}`} />
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
function AttemptOutput({ bridge, itemId, stepIndex, attempt, label }: { readonly bridge: TokamaBridge; readonly itemId: string; readonly stepIndex: number; readonly attempt: number; readonly label: string }) {
  const [opened, setOpened] = useState(false);
  const output = useStepOutput(bridge, itemId, stepIndex, attempt, opened ? `${stepIndex} ${attempt}` : undefined);
  return (
    <details className="attempt-output" onToggle={(event) => event.currentTarget.open && setOpened(true)}>
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
        <button type="button" className="choice danger" disabled={busy} onClick={onStop}>
          {TEXT.stopConfirm}
        </button>
        <button type="button" className="choice" ref={cancel} onClick={onCancel}>
          {TEXT.stopCancel}
        </button>
      </div>
    </div>
  );
}
