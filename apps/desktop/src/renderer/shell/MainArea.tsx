// The main area: the selected workspace's header and, below it, the board (#30 fills it).
// When the engine is not available, its failure details take the board's place; a failed load
// shows its reason and a Retry action there.
import type { WorkspaceSummary } from "@tokama/core";
import type { ConnectionState } from "../../shared/bridge.js";
import { summaryLine } from "../model.js";
import { ConnectionFailure } from "./ConnectionStatus.js";

const TEXT = {
  board: "Board",
  boardPlaceholder: "The board for this workspace comes here.",
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loading: "Loading workspaces",
  noWorkspaces: "No workspaces yet.",
  loadFailed: "Could not load the workspaces",
  retry: "Retry",
  workspaceSettings: "Workspace settings",
} as const;

export interface MainAreaProps {
  readonly connection: ConnectionState;
  /** Undefined until the first load. */
  readonly workspace: WorkspaceSummary | undefined;
  readonly loaded: boolean;
  readonly loadError: string | undefined;
  readonly onRetry: () => void;
}

export function MainArea(props: MainAreaProps) {
  const { workspace } = props;
  return (
    <main className="main">
      <header className="main-header">
        {workspace && (
          <>
            <h1 className="ellipsis">{workspace.name}</h1>
            <span className="summary">{summaryLine(workspace)}</span>
            {/* Not wired yet: Workspace settings comes with the settings screens. */}
            <button type="button" className="link" aria-disabled="true">
              {TEXT.workspaceSettings}
            </button>
          </>
        )}
      </header>
      <section className="board" aria-label={TEXT.board}>
        <Body {...props} />
      </section>
    </main>
  );
}

function Body({ connection, workspace, loaded, loadError, onRetry }: MainAreaProps) {
  if (connection.status === "failed") return <ConnectionFailure state={connection} />;
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
      {(loaded || loadError === undefined) && <p className="placeholder">{placeholder(connection, workspace, loaded)}</p>}
    </>
  );
}

function placeholder(connection: ConnectionState, workspace: WorkspaceSummary | undefined, loaded: boolean): string {
  if (connection.status === "starting") return TEXT.starting;
  if (!loaded) return connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading;
  return workspace ? TEXT.boardPlaceholder : TEXT.noWorkspaces;
}
