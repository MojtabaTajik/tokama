// The workspaces panel: "+ New work", then workspaces grouped by
// host, each expanding to its live items only. The local host's row carries the engine's health.
// Repos, connections and templates are not listed here. Engine text (names, titles) is rendered
// as React text only.
import type { ItemRecord, WorkspaceSummary } from "@tokama/core";
import type { ConnectionState } from "../../shared/bridge.js";
import { groupByHost, type HostGroup, isLive, markerOf, needsYouCount } from "../model.js";
import { HostHealth } from "./ConnectionStatus.js";

const TEXT = {
  panel: "Workspaces",
  newWork: "+ New work",
  workspaces: "Workspaces",
  thisMachine: "This machine",
  workspaceCount: (count: number) => `${count} workspace${count === 1 ? "" : "s"}`,
  needsYou: (count: number) => `${count} need${count === 1 ? "s" : ""} you`,
  nothingLive: "Nothing running",
  stale: "Out of date: the last update failed",
} as const;

/** The host of this machine's engine. v1 runs every workspace on it. */
const LOCAL = "local";
const hostLabel = (host: string) => (host === LOCAL ? TEXT.thisMachine : host);

/** The groups to show: the local host always, first, so its health has a row. */
function hostGroups(workspaces: readonly WorkspaceSummary[]): HostGroup[] {
  const groups = groupByHost(workspaces);
  const local = groups.find((group) => group.host === LOCAL) ?? { host: LOCAL, workspaces: [] };
  return [local, ...groups.filter((group) => group !== local)];
}

export interface WorkspacesPanelProps {
  readonly id: string;
  readonly connection: ConnectionState;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly items: readonly ItemRecord[];
  /** The items are from an earlier load: the last one failed. */
  readonly stale: boolean;
  readonly selectedId: string | undefined;
  readonly expanded: ReadonlySet<string>;
  /** Selects the workspace and opens or closes its item list. */
  readonly onPick: (workspaceId: string) => void;
  /** The item whose drawer is open. */
  readonly selectedItemId: string | undefined;
  /** Opens an item's drawer. */
  readonly onSelectItem: (itemId: string) => void;
}

export function WorkspacesPanel(props: WorkspacesPanelProps) {
  const { id, connection, workspaces, items, stale, selectedId, expanded, onPick, selectedItemId, onSelectItem } = props;
  return (
    <aside className="panel" id={id} aria-label={TEXT.panel} data-stale={stale || undefined}>
      <button type="button" className="new-work" aria-disabled="true">
        {TEXT.newWork}
      </button>
      <h2 className="panel-heading">{TEXT.workspaces}</h2>
      {stale && (
        <p className="stale" role="status">
          <span className="symbol" aria-hidden="true">
            !
          </span>
          {TEXT.stale}
        </p>
      )}
      {hostGroups(workspaces).map((group) => (
        <section key={group.host} className="host" aria-label={hostLabel(group.host)}>
          <h3 className="host-heading">
            {hostLabel(group.host)}
            {group.host === LOCAL && <HostHealth state={connection} />}
            {group.workspaces.length > 0 && <span className="host-count">{TEXT.workspaceCount(group.workspaces.length)}</span>}
          </h3>
          {group.workspaces.map((workspace) => (
            <Workspace
              key={workspace.id}
              workspace={workspace}
              items={items.filter((item) => item.workspaceId === workspace.id && isLive(item))}
              selected={workspace.id === selectedId}
              open={expanded.has(workspace.id)}
              onPick={() => onPick(workspace.id)}
              selectedItemId={selectedItemId}
              onSelectItem={onSelectItem}
            />
          ))}
        </section>
      ))}
    </aside>
  );
}

interface WorkspaceProps {
  readonly workspace: WorkspaceSummary;
  readonly items: readonly ItemRecord[];
  readonly selected: boolean;
  readonly open: boolean;
  readonly onPick: () => void;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
}

function Workspace({ workspace, items, selected, open, onPick, selectedItemId, onSelectItem }: WorkspaceProps) {
  const waiting = needsYouCount(items);
  const listId = `workspace-items-${workspace.id}`;
  return (
    <div className="workspace">
      <button
        type="button"
        className="workspace-row"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={onPick}
      >
        <span className="tile" aria-hidden="true">
          {workspace.name.charAt(0).toUpperCase()}
        </span>
        <span className="ellipsis">{workspace.name}</span>
        {waiting > 0 && (
          <span className="waiting mono" title={TEXT.needsYou(waiting)}>
            <span aria-hidden="true">⏸ {waiting}</span>
            <span className="visually-hidden">{TEXT.needsYou(waiting)}</span>
          </span>
        )}
        <span className="chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <ul className="live-items" id={listId}>
          {items.length === 0 && <li className="live-item empty">{TEXT.nothingLive}</li>}
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
