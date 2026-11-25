// The main area: the header (the current view as "All work" or a breadcrumb such as
// "All work › Plan and build", with a List | Board switch for workflows), the status switch, and
// the pipeline list or the workflow's kanban. When the engine is not available, its failure
// details take the place of the list; a failed load shows its reason and a Retry action there.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import type { ReactNode } from "react";
import { Board } from "../board/Board.js";
import type { ConnectionState } from "../../shared/bridge.js";
import { ItemList } from "../list/ItemList.js";
import { ALL_WORK, groupItems, inView, summaryOf, visibleItems } from "../model.js";
import type { Layout, ViewState } from "../useViewState.js";
import { ConnectionFailure } from "./ConnectionStatus.js";
import { FirstLaunch, NoWork } from "./EmptyStates.js";
import { RepoIcon } from "./icons.js";
import { StatusFilter } from "./StatusFilter.js";
import { TemplateIcon } from "./TemplateIcon.js";

const TEXT = {
  allWork: "All work",
  board: "Board",
  breadcrumb: "Breadcrumb",
  layout: "Layout",
  list: "List",
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loading: "Loading",
  loadFailed: "Could not load the setup and items",
  retry: "Retry",
} as const;

export interface MainAreaProps {
  readonly connection: ConnectionState;
  readonly loadError: string | undefined;
  readonly onRetry: () => void;
  /** Starts the engine connection again after it failed. */
  readonly onRetryConnection: () => void;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly now: number;
  readonly views: ViewState;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
  /** Finish actions from a Done row's split button. */
  readonly onFinish?: (itemId: string, action: FinishAction) => void | Promise<void>;
  /** Discard… from a Done row: opens the item with its Discard question. */
  readonly onDiscard?: (itemId: string) => void;
  /** Pinned below the board: the New work input. */
  readonly composer?: ReactNode;
}

export function MainArea(props: MainAreaProps) {
  const { views, setup } = props;
  const { view } = views;
  const template = view.kind === "workflow" ? setup?.templates.find((candidate) => candidate.id === view.id) : undefined;
  return (
    <main className="main">
      <header className="main-header">
        {view.kind === "all" ? (
          <h1 className="ellipsis">{TEXT.allWork}</h1>
        ) : (
          <nav aria-label={TEXT.breadcrumb}>
            <ol className="breadcrumb">
              <li>
                <button type="button" className="crumb" onClick={() => views.setView(ALL_WORK)}>
                  {TEXT.allWork}
                </button>
              </li>
              <li aria-hidden="true" className="crumb-sep">
                ›
              </li>
              <li className="crumb-here" aria-current="page">
                {view.kind === "workflow" ? <TemplateIcon icon={template?.icon} color={template?.color} size={13} /> : <RepoIcon size={13} />}
                <h1 className={view.kind === "repo" ? "ellipsis mono" : "ellipsis"}>{template?.name ?? view.id}</h1>
              </li>
            </ol>
          </nav>
        )}
        {setup !== undefined && <span className="summary mono">{summaryOf(props.items.filter((item) => inView(item, view)), props.now)}</span>}
        {template !== undefined && <LayoutSwitch layout={views.layout} onChange={views.setLayout} />}
      </header>
      <section className="board" aria-label={TEXT.board}>
        <Body {...props} template={template} />
      </section>
      {props.composer}
    </main>
  );
}

function LayoutSwitch({ layout, onChange }: { readonly layout: Layout; readonly onChange: (layout: Layout) => void }) {
  return (
    <div className="segments layout" role="group" aria-label={TEXT.layout}>
      {(["list", "board"] as const).map((choice) => (
        <button key={choice} type="button" className="segment" aria-pressed={layout === choice} onClick={() => onChange(choice)}>
          {choice === "list" ? TEXT.list : TEXT.board}
        </button>
      ))}
    </div>
  );
}

function Body(props: MainAreaProps & { readonly template: Setup["templates"][number] | undefined }) {
  const { connection, loadError, onRetry, onRetryConnection, setup, items, now, views, selectedItemId, onSelectItem, template } = props;
  if (connection.status === "failed") return <ConnectionFailure state={connection} onRetry={onRetryConnection} />;
  const scoped = items.filter((item) => inView(item, views.view));
  return (
    <>
      {loadError !== undefined && (
        <div className="failure" role="alert">
          <p className="failure-title">
            <span className="symbol" aria-hidden="true">
              ✕
            </span>
            {TEXT.loadFailed}
          </p>
          <p className="detail">{loadError}</p>
          <button type="button" className="retry" onClick={onRetry}>
            {TEXT.retry}
          </button>
        </div>
      )}
      {setup === undefined ? (
        loadError === undefined && <p className="placeholder">{waiting(connection)}</p>
      ) : setup.repos.length === 0 ? (
        <FirstLaunch />
      ) : scoped.length === 0 ? (
        <NoWork />
      ) : (
        <>
          <StatusFilter items={scoped} filter={views.filter} now={now} onChange={views.setFilter} />
          {template !== undefined && views.layout === "board" ? (
            <Board items={visibleItems(scoped, views.filter, now)} agents={setup.agents} template={template} selectedItemId={selectedItemId} onSelect={onSelectItem} />
          ) : (
            <ItemList
              groups={groupItems(scoped, views.filter, now)}
              setup={setup}
              now={now}
              selectedItemId={selectedItemId}
              onSelect={onSelectItem}
              repoId={views.view.kind === "repo" ? views.view.id : undefined}
              {...(props.onFinish !== undefined && { onFinish: props.onFinish })}
              {...(props.onDiscard !== undefined && { onDiscard: props.onDiscard })}
            />
          )}
        </>
      )}
    </>
  );
}

function waiting(connection: ConnectionState): string {
  if (connection.status === "starting") return TEXT.starting;
  return connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading;
}
