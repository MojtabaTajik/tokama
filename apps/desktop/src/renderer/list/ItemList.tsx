// The pipeline list: one flat row per item, in groups (Needs you, Running, Done, Failed). A row
// shows the status, the title, and on line two in words the workflow, the repos, the step the item
// is at ("Build, step 2 of 3"), how long it has run and its agent, then its time. The one running
// mark of a row is the working agent's badge, which breathes; a row that waits, checks or ended shows
// its status symbol and word instead. A row is a native button, so Enter and Space select it as a
// click does; the badge next to it has its own tooltip and does not select the row. Engine text
// (titles, questions, names) is rendered as React text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import type { ReactNode } from "react";
import { AgentBadge } from "../agent/AgentBadge.js";
import { agentInfo } from "../agent/agent-info.js";
import { formatDuration } from "../format/duration.js";
import { useNow } from "../useNow.js";
import { templateOf } from "../drawer/describe.js";
import { finishNote } from "../drawer/finish-view.js";
import { currentStep, type GroupKey, type ItemGroup, listEntries, rowLine, rowMark, timeOf } from "../model.js";
import type { AgentTarget } from "../settings/describe.js";
import { FinishSplit } from "./FinishSplit.js";
import { useFocusFollow } from "./useFocusFollow.js";
import { Button } from "../ui/Button.js";
import { markOf } from "../ui/status.js";
import { AgentName } from "../ui/agent.js";
import { Facts } from "../ui/Facts.js";
import { factsOf } from "../../shared/item-facts.js";

const TEXT = {
  nothing: { needs: "Nothing waiting", running: "Nothing running", done: "Nothing finished", failed: "Nothing failed" },
  nothingFor: (what: string, name: string) => `${what} for ${name}`,
} as const;

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

export function ItemList({ groups, setup, now, selectedItemId, onSelect, repoId, onFinish, onDiscard, onOpenAgent, footers }: ItemListProps) {
  const focus = useFocusFollow();
  return (
    <div className="pipeline-list" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {groups.map((group) => {
        const count = "count" in group ? group.count : group.items.length;
        return (
          <section key={group.key} className="pl-group" aria-label={group.name}>
            <h3 className="pl-group-heading">
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

/** How long the running attempt has run, ticking every second in its own component so only this text renders again. */
function StepTime({ since }: { readonly since: number }) {
  const now = useNow(true);
  return <span className="pl-for">{formatDuration(now - since, "coarse")}</span>;
}

function Row({ item, setup, now, selected, onSelect, onFinish, onDiscard, onOpenAgent }: RowProps) {
  const mark = rowMark(item);
  const line = rowLine(item, setup?.agents ?? []);
  const working = item.state === "running";
  const template = templateOf(item, setup);
  // The working agent's badge is the row's running mark; a step Tokama runs itself (the checks) shows its own mark.
  const info = working && mark.word === "running" ? agentInfo(item, currentStep(item) ?? 0, setup) : undefined;
  const ask = item.state === "needs_you" ? (item.decision?.question ?? mark.word) : undefined;
  const finished = finishNote(item);
  // Until Merge or Open PR, a done row and a failed row say what was measured where the steps were.
  const facts = finished === undefined ? factsOf(item) : [];
  const separator = (
    <span aria-hidden="true" className="pl-sep">
      ·
    </span>
  );
  return (
    <div className="pl-row-wrap">
      <Button variant="plain" className="pl-row" data-item-id={item.id} data-state={item.state} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
        <span className="pl-mark" data-tone={mark.tone}>
          {info === undefined && <span aria-hidden="true">{mark.symbol}</span>}
          <span className="visually-hidden">{mark.word}: </span>
        </span>
        <span className="pl-main" data-wide={(finished === undefined && facts.length === 0) || undefined}>
          <span className="pl-title">{item.title}</span>
          <span className="pl-meta">
            <span className="pl-workflow">{template?.name ?? item.templateId}</span>
            {item.repoIds.length > 0 && (
              <>
                {separator}
                <span className="pl-repos ellipsis mono">{item.repoIds.join(", ")}</span>
              </>
            )}
            {line !== undefined && (
              <>
                {separator}
                <span className="pl-where">{line.step}</span>
                {line.since !== undefined && (
                  <>
                    {separator}
                    <StepTime since={line.since} />
                  </>
                )}
                {separator}
                <AgentName name={line.agent.name} hue={line.agent.hue} />
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
        ) : (
          facts.length > 0 && <Facts facts={facts} className="pl-facts" />
        )}
        <RowTime item={item} now={now} />
      </Button>
      {info !== undefined && <AgentBadge info={info} stepName={line?.stepName} since={line?.since} className="pl-badge" onOpen={onOpenAgent} />}
      {onFinish !== undefined && onDiscard !== undefined && <FinishSplit item={item} setup={setup} onFinish={onFinish} onDiscard={onDiscard} />}
    </div>
  );
}
