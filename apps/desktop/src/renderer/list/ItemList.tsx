// The pipeline list: one flat row per item, in groups (Needs you, Running, Done, Failed). A row
// shows the status, the title, the workflow and repos, the item's own steps as a small pipeline,
// its agent and its time. A row is a native button, so Enter and Space select it as a click does.
// Engine text (titles, questions, names) is rendered as React text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { templateOf } from "../drawer/describe.js";
import { finishNote } from "../drawer/finish-view.js";
import { type ItemGroup, pipelineOf, rowAgent, rowMark, timeOf } from "../model.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { FinishSplit } from "./FinishSplit.js";
import { useFocusFollow } from "./useFocusFollow.js";

const TEXT = {
  nothing: { needs: "Nothing waiting", running: "Nothing running", done: "Nothing finished", failed: "Nothing failed" },
  nothingFor: (what: string, name: string) => `${what} for ${name}`,
  steps: "Steps",
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
  readonly onFinish?: (itemId: string, action: FinishAction) => void;
  /** Discard… from a Done row: opens the item with its Discard question. */
  readonly onDiscard?: (itemId: string) => void;
}

const GROUP_SYMBOL = { needs: "⏸", running: "●", done: "✓", failed: "✕" } as const;

export function ItemList({ groups, setup, now, selectedItemId, onSelect, repoId, onFinish, onDiscard }: ItemListProps) {
  const focus = useFocusFollow();
  return (
    <div className="pipeline-list" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {groups.map((group) => (
        <section key={group.key} className="pl-group" aria-label={group.name}>
          <h3 className="pl-group-heading">
            <span className="pl-group-symbol" data-group={group.key} aria-hidden="true">
              {GROUP_SYMBOL[group.key]}
            </span>
            {group.name}
            <span className="pl-group-count mono">{group.items.length}</span>
          </h3>
          {group.items.length === 0 && <p className="pl-empty">{repoId === undefined ? TEXT.nothing[group.key] : TEXT.nothingFor(TEXT.nothing[group.key], repoId)}</p>}
          {group.items.map((item) => (
            <Row key={item.id} item={item} setup={setup} now={now} selected={item.id === selectedItemId} onSelect={onSelect} onFinish={onFinish} onDiscard={onDiscard} />
          ))}
        </section>
      ))}
    </div>
  );
}

interface RowProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  readonly onFinish: ((itemId: string, action: FinishAction) => void) | undefined;
  readonly onDiscard: ((itemId: string) => void) | undefined;
}

function Row({ item, setup, now, selected, onSelect, onFinish, onDiscard }: RowProps) {
  const mark = rowMark(item);
  const steps = pipelineOf(item);
  const agent = rowAgent(item, setup?.agents ?? []);
  const time = timeOf(item, now);
  const template = templateOf(item, setup);
  const ask = item.state === "needs_you" ? (item.decision?.question ?? mark.word) : undefined;
  const finished = finishNote(item);
  return (
    <div className="pl-row-wrap">
      <button type="button" className="pl-row" data-item-id={item.id} data-state={item.state} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
        <span className="pl-mark" data-tone={mark.tone}>
          <span aria-hidden="true">{mark.symbol}</span>
          <span className="visually-hidden">{mark.word}: </span>
        </span>
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
          {ask !== undefined && <span className="pl-ask ellipsis">⏸ {ask}</span>}
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
          <span className="pl-pipe" role="img" aria-label={`${TEXT.steps}: ${steps.map((step) => `${step.name} ${step.mark.word}`).join(", ")}`}>
            {steps.map((step, index) => (
              <span key={index} className="pl-step" data-current={step.current || undefined} title={`${step.name} · ${step.mark.word}`} aria-hidden="true">
                {index > 0 && <span className="pl-link" />}
                <span className="pl-step-mark" data-tone={step.mark.tone}>
                  {step.mark.symbol}
                </span>
                {step.current && <span className="pl-step-name ellipsis">{step.name}</span>}
              </span>
            ))}
          </span>
        )}
        <span className="pl-agent">
          {agent && (
            <>
              <span className="agent-dot" data-agent={agent.dot} aria-hidden="true" />
              <span className="ellipsis">{agent.name}</span>
            </>
          )}
        </span>
        <span className="pl-time mono" title={time.title}>
          {time.text}
        </span>
      </button>
      {onFinish !== undefined && onDiscard !== undefined && <FinishSplit item={item} setup={setup} onFinish={onFinish} onDiscard={onDiscard} />}
    </div>
  );
}
