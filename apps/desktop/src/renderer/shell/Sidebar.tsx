// The sidebar: "+ New work", then WORKFLOWS (one row per template, with its live items under it)
// and REPOS (one row per repo, with a count of its live items). The engine's health sits under
// "+ New work". Engine text (names, titles) is rendered as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import type { ConnectionState } from "../../shared/bridge.js";
import { isLive, markerOf, needsYouCount } from "../model.js";
import { EngineHealth } from "./ConnectionStatus.js";

const TEXT = {
  panel: "Sidebar",
  newWork: "+ New work",
  thisMachine: "This machine",
  workflows: "Workflows",
  repos: "Repos",
  needsYou: (count: number) => `${count} need${count === 1 ? "s" : ""} you`,
  running: (count: number) => `${count} running`,
  nothingLive: "Nothing running",
  stale: "Out of date: the last update failed",
} as const;

export interface SidebarProps {
  readonly id: string;
  readonly connection: ConnectionState;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  /** The items are from an earlier load: the last one failed. */
  readonly stale: boolean;
  /** The item whose drawer is open. */
  readonly selectedItemId: string | undefined;
  /** Opens an item's drawer. */
  readonly onSelectItem: (itemId: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { id, connection, setup, items, stale, selectedItemId, onSelectItem } = props;
  const live = items.filter(isLive);
  return (
    <aside className="panel" id={id} aria-label={TEXT.panel} data-stale={stale || undefined}>
      <button type="button" className="new-work" aria-disabled="true">
        {TEXT.newWork}
      </button>
      <p className="engine-line">
        {TEXT.thisMachine}
        <EngineHealth state={connection} />
      </p>
      {stale && (
        <p className="stale" role="status">
          <span className="symbol" aria-hidden="true">
            !
          </span>
          {TEXT.stale}
        </p>
      )}
      <h2 className="panel-heading">{TEXT.workflows}</h2>
      {(setup?.templates ?? []).map((template) => (
        <Workflow
          key={template.id}
          name={template.name}
          items={live.filter((item) => item.templateId === template.id)}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
        />
      ))}
      <h2 className="panel-heading">{TEXT.repos}</h2>
      {(setup?.repos ?? []).map((repo) => {
        const count = live.filter((item) => item.repoIds.includes(repo.id)).length;
        return (
          <div key={repo.id} className="repo-row">
            <span className="ellipsis">{repo.id}</span>
            {count > 0 && <span className="count mono">{TEXT.running(count)}</span>}
          </div>
        );
      })}
    </aside>
  );
}

interface WorkflowProps {
  readonly name: string;
  readonly items: readonly ItemRecord[];
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
}

function Workflow({ name, items, selectedItemId, onSelectItem }: WorkflowProps) {
  const waiting = needsYouCount(items);
  return (
    <div className="workflow">
      <div className="workflow-row">
        <span className="ellipsis">{name}</span>
        {waiting > 0 && (
          <span className="waiting mono" title={TEXT.needsYou(waiting)}>
            <span aria-hidden="true">⏸ {waiting}</span>
            <span className="visually-hidden">{TEXT.needsYou(waiting)}</span>
          </span>
        )}
      </div>
      {items.length > 0 && (
        <ul className="live-items" aria-label={name}>
          {items.map((item) => {
            const marker = markerOf(item);
            return (
              <li key={item.id} className="live-item" data-state={item.state} title={item.title}>
                <button
                  type="button"
                  className="live-item-button"
                  aria-current={item.id === selectedItemId ? "true" : undefined}
                  onClick={() => onSelectItem(item.id)}
                >
                  <span className="marker" data-tone={marker.tone} aria-hidden="true">
                    {marker.symbol}
                  </span>
                  <span className="ellipsis">{item.title}</span>
                  <span className="marker-word" data-tone={marker.tone}>
                    {marker.word}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
