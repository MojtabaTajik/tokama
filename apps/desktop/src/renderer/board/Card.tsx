// One flat kanban card: the repos with the privacy label, a status line, the
// title, the engine's one mono line (a done or failed card shows its facts instead) and the agent. A card that works right now has a breathing dot
// before "working" or "checking" and a thin light along its top edge; cards that wait or ended are
// still, with a mark and words (an ended one with its time and total). The card is a native
// button, so Enter and Space select it as a click does. Engine text is rendered as React text only.
import type { AgentSummary, ItemRecord } from "@tokama/core";
import { PRIVACY } from "../drawer/describe.js";
import { cardStatus, rowAgent } from "../model.js";
import { Button } from "../ui/Button.js";
import { LiveDot } from "../ui/LiveDot.js";
import { AgentChip } from "../ui/agent.js";
import { Facts } from "../ui/Facts.js";
import { factsOf } from "../../shared/item-facts.js";

export interface CardProps {
  readonly item: ItemRecord;
  readonly agents: readonly AgentSummary[];
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  /** For an ended card's day or clock time. */
  readonly now: number;
}

export function Card({ item, agents, selected, onSelect, now }: CardProps) {
  const status = cardStatus(item, now);
  const agent = rowAgent(item, agents);
  // Until a Merge, a pull request or a discard has ended it, a done card and a failed card say what
  // was measured in place of the engine's line (which names the commit). A refused or running action ends nothing.
  const finish = item.finish;
  const facts = finish !== undefined && (finish.merged !== undefined || finish.pullRequest !== undefined || finish.worktreeRemoved) ? [] : factsOf(item);
  return (
    <Button variant="plain" className="card" data-item-id={item.id} data-state={item.state} data-live={status?.live === true} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
      {status?.live === true && <span className="card-edge" aria-hidden="true" />}
      <span className="card-meta">
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
      {facts.length > 0 ? <Facts facts={facts} className="card-line" /> : item.cardLine !== undefined && <span className="card-line mono">{item.cardLine}</span>}
      {agent && (
        <AgentChip agent={agent} className="card-agent" />
      )}
    </Button>
  );
}
