// The main area: the header (the current view as "All work" or a breadcrumb such as
// "All work › Plan and build", with a List | Board switch for workflows), the status switch, and
// the pipeline list or the workflow's kanban. When the engine is not available, its failure
// details take the place of the list; a failed load shows its reason and a Retry action there.
import type { BoardCount, FinishAction, ItemRecord, Setup } from "@tokama/core";
import type { ReactNode } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { WorkArea } from "../list/WorkArea.js";
import { ALL_WORK, finishedIn, inView, summaryOf } from "../model.js";
import type { AgentTarget } from "../settings/describe.js";
import type { Layout, ViewState } from "../useViewState.js";
import { ConnectionFailure, EngineChip, startingWords, UpdatingEngine } from "./ConnectionStatus.js";
import { NoWork } from "./EmptyStates.js";
import { RepoIcon } from "../ui/icons.js";
import { TemplateIcon } from "./TemplateIcon.js";
import { Button } from "../ui/Button.js";
import { ErrorRetry } from "../ui/ErrorRetry.js";
import { Placeholder } from "../ui/EmptyState.js";

const TEXT = {
  app: "Tokama",
  allWork: "All work",
  board: "Board",
  breadcrumb: "Breadcrumb",
  layout: "Layout",
  list: "List",
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loading: "Loading",
  loadFailed: "Could not load the setup and items",
} as const;

export interface MainAreaProps {
  /** The work list loads its pages and searches through it. */
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly loadError: string | undefined;
  readonly onRetry: () => void;
  /** Starts the engine connection again after it failed. */
  readonly onRetryConnection: () => void;
  /** With an older engine still running: replace it now. */
  readonly onRestartEngine?: () => void;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  /** The open items. */
  readonly items: readonly ItemRecord[];
  /** The finished items, counted. */
  readonly counts: readonly BoardCount[];
  readonly now: number;
  readonly views: ViewState;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
  /** Finish actions from a Done row's split button. */
  readonly onFinish?: (itemId: string, action: FinishAction) => void | Promise<void>;
  /** Discard… from a Done row: opens the item with its Discard question. */
  readonly onDiscard?: (itemId: string) => void;
  /** An agent tooltip's "Open in Settings →". */
  readonly onOpenAgent?: (agent: AgentTarget) => void;
  /** Pinned below the board: the New work input. */
  readonly composer?: ReactNode;
  /**
   * The Get started checklist: in place of the empty board (`instead`, before the first item), or
   * at the top of All work (`above`, opened from Help), in front of the list.
   */
  readonly checklist?: { readonly node: ReactNode; readonly where: "instead" | "above" } | undefined;
  /** The "Setup done" line above the list, until it is closed or the first item ends. */
  readonly doneLine?: ReactNode;
}

export function MainArea(props: MainAreaProps) {
  const { views, setup } = props;
  const { view } = views;
  const template = view.kind === "workflow" ? setup?.templates.find((candidate) => candidate.id === view.id) : undefined;
  // Before the first item the board has no work to name or count: the checklist is the page.
  const firstRun = props.checklist?.where === "instead";
  return (
    <main className="main">
      <header className="main-header">
        {view.kind === "all" ? (
          <h1 className="ellipsis">{firstRun ? TEXT.app : TEXT.allWork}</h1>
        ) : (
          <nav aria-label={TEXT.breadcrumb}>
            <ol className="breadcrumb">
              <li>
                <Button variant="plain" className="crumb" onClick={() => views.setView(ALL_WORK)}>
                  {TEXT.allWork}
                </Button>
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
        <EngineChip state={props.connection} restartable={props.onRestartEngine !== undefined} />
        {setup !== undefined && !firstRun && <span className="summary mono">{summaryOf(props.items.filter((item) => inView(item, view)), props.counts.filter((row) => inView(row, view)), props.now)}</span>}
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
        <Button variant="plain" key={choice} className="segment" aria-pressed={layout === choice} onClick={() => onChange(choice)}>
          {choice === "list" ? TEXT.list : TEXT.board}
        </Button>
      ))}
    </div>
  );
}

function Body(props: MainAreaProps & { readonly template: Setup["templates"][number] | undefined }) {
  const { connection, loadError, onRetry, onRetryConnection, setup, items, counts, now, views, selectedItemId, onSelectItem, template } = props;
  if (connection.status === "failed") {
    return (
      <ConnectionFailure
        state={connection}
        onRetry={onRetryConnection}
        {...(props.onRestartEngine !== undefined && { onRestart: props.onRestartEngine })}
      />
    );
  }
  if (connection.status === "starting" && connection.updating === true) return <UpdatingEngine />;
  const scoped = items.filter((item) => inView(item, views.view));
  const scopedCounts = counts.filter((row) => inView(row, views.view));
  const finished = finishedIn(scopedCounts, "all", now);
  return (
    <>
      {loadError !== undefined && <ErrorRetry title={TEXT.loadFailed} detail={loadError} onRetry={onRetry} />}
      {setup === undefined ? (
        loadError === undefined && <Placeholder>{waiting(connection)}</Placeholder>
      ) : props.checklist?.where === "instead" ? (
        props.checklist.node
      ) : scoped.length === 0 && finished.done + finished.failed === 0 ? (
        <>
          {props.checklist?.node}
          {props.doneLine}
          <NoWork />
        </>
      ) : (
        <>
          {props.checklist?.node}
          {props.doneLine}
          <WorkArea
            bridge={props.bridge}
            connected={connection.status === "connected"}
            setup={setup}
            scoped={scoped}
            counts={scopedCounts}
            items={new Map(items.map((item) => [item.id, item]))}
            view={views.view}
            filter={views.filter}
            onFilter={views.setFilter}
            layout={views.layout}
            template={template}
            now={now}
            selectedItemId={selectedItemId}
            onSelectItem={onSelectItem}
            onFinish={props.onFinish}
            onDiscard={props.onDiscard}
            onOpenAgent={props.onOpenAgent}
          />
        </>
      )}
    </>
  );
}

function waiting(connection: ConnectionState): string {
  if (connection.status === "starting") return startingWords(connection, TEXT.starting);
  return connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading;
}
