// One flat kanban card: the workflow icon and repos with the privacy label, an optional flag line
// (needs you, failed, stopped), the title, the engine's one mono line and the agent. The card is
// a native button, so Enter and Space select it as a click does. Engine text is rendered as React
// text only.
import type { AgentSummary, ItemRecord } from "@tokama/core";
import { PRIVACY } from "../drawer/describe.js";
import { flagOf, rowAgent } from "../model.js";
import { WorkflowIcon } from "../shell/icons.js";

export interface CardProps {
  readonly item: ItemRecord;
  readonly agents: readonly AgentSummary[];
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
}

export function Card({ item, agents, selected, onSelect }: CardProps) {
  const flag = flagOf(item);
  const agent = rowAgent(item, agents);
  return (
    <button type="button" className="card" data-state={item.state} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
      <span className="card-meta">
        <WorkflowIcon />
        <span className="ellipsis mono">{item.repoIds.length > 0 ? item.repoIds.join(", ") : ""}</span>
        <span className="card-privacy">{PRIVACY[item.privacy]}</span>
      </span>
      {flag && (
        <span className="card-flag ellipsis" data-tone={flag.mark.tone} title={flag.text}>
          <span aria-hidden="true">{flag.mark.symbol}</span>
          <span className="visually-hidden">{flag.mark.word}: </span> {flag.text}
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
