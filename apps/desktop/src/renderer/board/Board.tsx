// One workflow's kanban: Queued, one column per step of its template, and Done, each with a
// count. Selection lives with the caller, so the item drawer is shared with the list.
import type { AgentSummary, ItemRecord, TemplateSummary } from "@tokama/core";
import { boardColumns } from "../model.js";
import { useFocusFollow } from "../list/useFocusFollow.js";
import { Card } from "./Card.js";

export interface BoardProps {
  /** The workflow's items that pass the status filter, finished ones as far as they are loaded. */
  readonly items: readonly ItemRecord[];
  /** Finished items that pass the filter but are not loaded: the Done column counts them too. */
  readonly notLoaded?: number;
  readonly agents: readonly AgentSummary[];
  readonly template: TemplateSummary;
  readonly selectedItemId: string | undefined;
  readonly onSelect: (itemId: string) => void;
  readonly now: number;
}

export function Board({ items, notLoaded = 0, agents, template, selectedItemId, onSelect, now }: BoardProps) {
  const focus = useFocusFollow();
  return (
    <div className="columns" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {boardColumns(items, template).map((column) => (
        <section key={column.key} className="column" aria-labelledby={`column-${column.key}`}>
          <h3 className="column-heading" id={`column-${column.key}`}>
            <span className="column-name ellipsis" title={column.name}>
              {column.name}
            </span>
            <span className="column-count mono">{column.items.length + (column.key === "done" ? notLoaded : 0)}</span>
          </h3>
          {column.items.map((item) => (
            <Card key={item.id} item={item} agents={agents} selected={item.id === selectedItemId} onSelect={onSelect} now={now} />
          ))}
        </section>
      ))}
    </div>
  );
}
