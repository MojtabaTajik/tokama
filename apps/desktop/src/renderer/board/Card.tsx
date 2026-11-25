// One flat kanban card: the template icon and repos with the privacy label, a status line, the
// title, the engine's one mono line and the agent. A card that works right now has a breathing dot
// before "working" or "checking" and a thin light along its top edge; cards that wait or ended are
// still, with a mark and words (an ended one with its time and total). The card is a native
// button, so Enter and Space select it as a click does. Engine text is rendered as React text only.
import type { AgentSummary, ItemRecord, TemplateSummary } from "@tokama/core";
import { PRIVACY } from "../drawer/describe.js";
import { LiveDot } from "../drawer/Progress.js";
import { cardStatus, rowAgent } from "../model.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";

export interface CardProps {
  readonly item: ItemRecord;
  readonly agents: readonly AgentSummary[];
  readonly template: TemplateSummary;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  /** For an ended card's day or clock time. */
  readonly now: number;
}

export function Card({ item, agents, template, selected, onSelect, now }: CardProps) {
  const status = cardStatus(item, now);
  const agent = rowAgent(item, agents);
  return (
    <button type="button" className="card" data-item-id={item.id} data-state={item.state} data-live={status?.live === true} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
      {status?.live === true && <span className="card-edge" aria-hidden="true" />}
      <span className="card-meta">
        <TemplateIcon icon={template.icon} color={template.color} />
        <span className="ellipsis mono">{item.repoIds.length > 0 ? item.repoIds.join(", ") : ""}</span>
        <span className="card-privacy">{PRIVACY[item.privacy]}</span>
      </span>
      {status?.live === true && (
        <span className="card-flag card-working">
          <LiveDot />
          {status.word}
        </span>
      )}
      {status?.live === false && (
        <span className="card-flag ellipsis" data-tone={status.mark.tone} title={status.text}>
          <span aria-hidden="true">{status.mark.symbol}</span>
          <span className="visually-hidden">{status.mark.word}: </span> {status.text}
        </span>
      )}
      <span className="card-title">{item.title}</span>
      {item.cardLine !== undefined && <span className="card-line mono">{item.cardLine}</span>}
      {agent && (
        <span className="card-agent">
          <span className="agent-dot" data-agent={agent.dot} aria-hidden="true" />
          {agent.name}
        </span>
      )}
    </button>
  );
}
