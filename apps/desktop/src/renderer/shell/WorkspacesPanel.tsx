// The workspaces panel (CLAUDE.md, locked layout): "+ New work", then workspaces grouped by
// host, each expanding to its live items only. Repos, connections and templates are not listed
// here. Engine text (names, titles) is rendered as React text only.
import type { ItemRecord, WorkspaceSummary } from "@tokama/core";
import { groupByHost, isLive, markerOf, needsYouCount } from "../model.js";

const TEXT = {
  panel: "Workspaces",
  newWork: "+ New work",
  workspaces: "Workspaces",
  thisMachine: "This machine",
  workspaceCount: (count: number) => `${count} workspace${count === 1 ? "" : "s"}`,
  needsYou: (count: number) => `${count} need${count === 1 ? "s" : ""} you`,
  nothingLive: "Nothing running",
} as const;

/** v1 runs every workspace on the local host. */
const hostLabel = (host: string) => (host === "local" ? TEXT.thisMachine : host);

export interface WorkspacesPanelProps {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly items: readonly ItemRecord[];
  readonly selectedId: string | undefined;
  readonly expanded: ReadonlySet<string>;
  /** Selects the workspace and opens or closes its item list. */
  readonly onPick: (workspaceId: string) => void;
}

export function WorkspacesPanel({ workspaces, items, selectedId, expanded, onPick }: WorkspacesPanelProps) {
  return (
    <aside className="panel" aria-label={TEXT.panel}>
      <button type="button" className="new-work">
        {TEXT.newWork}
      </button>
      <h2 className="panel-heading">{TEXT.workspaces}</h2>
      {groupByHost(workspaces).map((group) => (
        <section key={group.host} className="host" aria-label={hostLabel(group.host)}>
          <h3 className="host-heading">
            {hostLabel(group.host)}
            <span className="host-count">{TEXT.workspaceCount(group.workspaces.length)}</span>
          </h3>
          {group.workspaces.map((workspace) => (
            <Workspace
              key={workspace.id}
              workspace={workspace}
              items={items.filter((item) => item.workspaceId === workspace.id && isLive(item))}
              selected={workspace.id === selectedId}
              open={expanded.has(workspace.id)}
              onPick={() => onPick(workspace.id)}
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
}

function Workspace({ workspace, items, selected, open, onPick }: WorkspaceProps) {
  const waiting = needsYouCount(items);
  const listId = `workspace-items-${workspace.id}`;
  return (
    <div className="workspace">
      <button type="button" className="workspace-row" aria-expanded={open} aria-controls={listId} aria-current={selected ? "true" : undefined} onClick={onPick}>
        <span className="tile" aria-hidden="true">
          {workspace.name.charAt(0).toUpperCase()}
        </span>
        <span className="ellipsis">{workspace.name}</span>
        {waiting > 0 && (
          <span className="waiting mono" title={TEXT.needsYou(waiting)}>
            {waiting}
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
                <span className="marker" data-tone={marker.tone} aria-hidden="true">
                  {marker.symbol}
                </span>
                <span className="ellipsis">{item.title}</span>
                <span className="marker-word" data-tone={marker.tone}>
                  {marker.word}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
