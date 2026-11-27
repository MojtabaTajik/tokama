// The pipeline list: one flat row per item, in groups (Needs you, Running, Done, Failed). A row
// shows the status, the title, the workflow and repos, the item's own steps as a small pipeline
// (the current step with its attempt), its agent with the model, and its time. A row is a native
// button, so Enter and Space select it as a click does; the agent label next to it has its own
// tooltip and does not select the row. Engine text (titles, questions, names) is rendered as React
// text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import type { ReactNode } from "react";
import { AgentLabel } from "../agent/AgentLabel.js";
import { agentInfo } from "../agent/agent-info.js";
import { useBreath } from "../drawer/Progress.js";
import { useNow } from "../useNow.js";
import { templateOf } from "../drawer/describe.js";
import { finishNote } from "../drawer/finish-view.js";
import { currentStep, type GroupKey, type ItemGroup, listEntries, pipelineOf, rowAgent, rowMark, timeOf } from "../model.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import type { AgentTarget } from "../settings/describe.js";
import { FinishSplit } from "./FinishSplit.js";
import { useFocusFollow } from "./useFocusFollow.js";
import { Button } from "../ui/Button.js";
import { markOf } from "../ui/status.js";
import { AgentChip } from "../ui/agent.js";
import { Facts } from "../ui/Facts.js";
import { factsOf } from "../../shared/item-facts.js";

const TEXT = {
  nothing: { needs: "Nothing waiting", running: "Nothing running", done: "Nothing finished", failed: "Nothing failed" },
  nothingFor: (what: string, name: string) => `${what} for ${name}`,
  steps: "Steps",
  attempt: (n: number) => `attempt ${n}`,
} as const;

/** A step in words, for the pipeline's label: "Review running attempt 1", "Plan passed". */
const stepWords = (step: { readonly name: string; readonly mark: { readonly word: string }; readonly current: boolean; readonly attempt: number | undefined }): string =>
  `${step.name} ${step.mark.word}${step.current && step.attempt !== undefined ? ` ${TEXT.attempt(step.attempt)}` : ""}`;

export interface ItemListProps {
  readonly groups: readonly ItemGroup[];
  readonly setup: Setup | undefined;
  readonly now: number;
  readonly selectedItemId: string | undefined;
  readonly onSelect: (itemId: string) => void;
  /** The repo the list is filtered to, named in the empty message. */
  readonly repoId?: string | undefined;
  /** Finish actions from a Done row's split button; without it the row has none. */
  readonly onFinish?: (itemId: string, action: FinishAction) => void | Promise<void>;
  /** Discard… from a Done row: opens the item with its Discard question. */
  readonly onDiscard?: (itemId: string) => void;
  /** An agent tooltip's "Open in Settings →"; without it the tooltips have no link. */
  readonly onOpenAgent?: (agent: AgentTarget) => void;
  /** What follows a group's last row, such as Load older. */
  readonly footers?: Partial<Record<GroupKey, ReactNode>>;
}

/** A mark that breathes while `on`, in step with every other breathing mark on screen. */
function BreathMark({ on, className, children, ...rest }: { readonly on: boolean; readonly className: string; readonly children: ReactNode; readonly "data-tone"?: string; readonly "data-group"?: string; readonly "aria-hidden"?: "true" }) {
  const breath = useBreath(on);
  return (
    <span className={className} {...rest} data-breathe={on} style={on ? breath : undefined}>
      {children}
    </span>
  );
}

const GROUP_SYMBOL = { needs: markOf("needs_you").symbol, running: markOf("running").symbol, done: markOf("done").symbol, failed: markOf("failed").symbol } as const;

export function ItemList({ groups, setup, now, selectedItemId, onSelect, repoId, onFinish, onDiscard, onOpenAgent, footers }: ItemListProps) {
  const focus = useFocusFollow();
  return (
    <div className="pipeline-list" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {groups.map((group) => {
        const count = "count" in group ? group.count : group.items.length;
        return (
          <section key={group.key} className="pl-group" aria-label={group.name}>
            <h3 className="pl-group-heading">
              <BreathMark className="pl-group-symbol" on={group.key === "running" && group.items.some((item) => item.state === "running")} data-group={group.key} aria-hidden="true">
                {GROUP_SYMBOL[group.key]}
              </BreathMark>
              {group.name}
              {count !== undefined && <span className="pl-group-count mono">{count}</span>}
            </h3>
            {count === 0 && <p className="pl-empty">{repoId === undefined ? TEXT.nothing[group.key] : TEXT.nothingFor(TEXT.nothing[group.key], repoId)}</p>}
            {listEntries(group.items, group.days, now).map((entry) =>
              entry.kind === "day" ? (
                <h4 key={`day-${entry.day}`} className="pl-day">
                  {entry.label}
                  <span className="pl-day-count mono">{entry.count}</span>
                </h4>
              ) : (
                <Row key={entry.item.id} item={entry.item} setup={setup} now={now} selected={entry.item.id === selectedItemId} onSelect={onSelect} onFinish={onFinish} onDiscard={onDiscard} onOpenAgent={onOpenAgent} />
              ),
            )}
            {footers?.[group.key]}
          </section>
        );
      })}
    </div>
  );
}

interface RowProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  readonly onFinish: ((itemId: string, action: FinishAction) => void | Promise<void>) | undefined;
  readonly onDiscard: ((itemId: string) => void) | undefined;
  readonly onOpenAgent: ((agent: AgentTarget) => void) | undefined;
}

/** The row's time: a running item's ticks every second in its own component, so only this text renders again. */
function RowTime({ item, now }: { readonly item: ItemRecord; readonly now: number }) {
  const working = item.state === "running";
  const ticking = useNow(working);
  const time = timeOf(item, working ? ticking : now);
  return (
    <span className="pl-time mono" title={time.title}>
      {time.text}
    </span>
  );
}

function Row({ item, setup, now, selected, onSelect, onFinish, onDiscard, onOpenAgent }: RowProps) {
  const mark = rowMark(item);
  const steps = pipelineOf(item);
  const agent = rowAgent(item, setup?.agents ?? []);
  // Tokama's own steps (checks) have no agent to describe: the row names Tokama in plain text.
  const agentTip = agentInfo(item, currentStep(item) ?? item.steps.length - 1, setup);
  const working = item.state === "running";
  const template = templateOf(item, setup);
  const ask = item.state === "needs_you" ? (item.decision?.question ?? mark.word) : undefined;
  const finished = finishNote(item);
  // Until Merge or Open PR, a done row and a failed row say what was measured where the steps were.
  const facts = finished === undefined ? factsOf(item) : [];
  return (
    <div className="pl-row-wrap">
      <Button variant="plain" className="pl-row" data-item-id={item.id} data-state={item.state} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
        <BreathMark className="pl-mark" on={working} data-tone={mark.tone}>
          <span aria-hidden="true">{mark.symbol}</span>
          <span className="visually-hidden">{mark.word}: </span>
        </BreathMark>
        <span className="pl-main">
          <span className="pl-title">{item.title}</span>
          <span className="pl-meta">
            <TemplateIcon icon={template?.icon} color={template?.color} />
            <span className="pl-workflow">{template?.name ?? item.templateId}</span>
            {item.repoIds.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="ellipsis mono">{item.repoIds.join(", ")}</span>
              </>
            )}
          </span>
          {ask !== undefined && <span className="pl-ask ellipsis">{markOf("needs_you").symbol} {ask}</span>}
        </span>
        {finished !== undefined ? (
          // A finished row says how it ended where the steps were.
          <span className="pl-finish ellipsis">
            <span className="mark" data-tone={finished.mark.tone} aria-hidden="true">
              {finished.mark.symbol}
            </span>
            <span className="visually-hidden">{finished.mark.word}: </span>
            {finished.text}
          </span>
        ) : facts.length > 0 ? (
          <Facts facts={facts} className="pl-facts" />
        ) : (
          <span className="pl-pipe" role="img" aria-label={`${TEXT.steps}: ${steps.map(stepWords).join(", ")}`}>
            {steps.map((step, index) => (
              <span key={index} className="pl-step" data-current={step.current || undefined} title={`${step.name} · ${step.mark.word}`} aria-hidden="true">
                {index > 0 && <span className="pl-link" />}
                <BreathMark className="pl-step-mark" on={working && step.current && step.mark.tone === "live"} data-tone={step.mark.tone}>
                  {step.mark.symbol}
                </BreathMark>
                {step.current && <span className="pl-step-name ellipsis">{step.name}</span>}
                {step.current && step.attempt !== undefined && <span className="pl-step-attempt">· {TEXT.attempt(step.attempt)}</span>}
              </span>
            ))}
          </span>
        )}
        <RowTime item={item} now={now} />
      </Button>
      {agent !== undefined && (
        <span className="pl-agent">
          {agentTip !== undefined ? (
            <AgentLabel info={agentTip} onOpen={onOpenAgent} />
          ) : (
            <AgentChip agent={agent} ellipsis />
          )}
        </span>
      )}
      {onFinish !== undefined && onDiscard !== undefined && <FinishSplit item={item} setup={setup} onFinish={onFinish} onDiscard={onDiscard} />}
    </div>
  );
}
