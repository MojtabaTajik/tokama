// The main area: the selected workspace's header and, below it, the board (#30 fills it).
// When the engine is not available, the failure details take the board's place.
import type { WorkspaceSummary } from "@tokama/core";
import type { ConnectionState } from "../../shared/bridge.js";
import { summaryLine } from "../model.js";
import { ConnectionFailure, ConnectionStatus } from "./ConnectionStatus.js";

const TEXT = {
  board: "Board",
  boardPlaceholder: "The board for this workspace comes here.",
  loading: "Loading workspaces",
  noWorkspaces: "No workspaces yet.",
  loadFailed: "Could not load the workspaces",
} as const;

export interface MainAreaProps {
  readonly connection: ConnectionState;
  /** Undefined until the first load. */
  readonly workspace: WorkspaceSummary | undefined;
  readonly loaded: boolean;
  readonly loadError: string | undefined;
}

export function MainArea({ connection, workspace, loaded, loadError }: MainAreaProps) {
  return (
    <main className="main">
      <header className="main-header">
        {workspace && (
          <>
            <h1 className="ellipsis">{workspace.name}</h1>
            <span className="summary">{summaryLine(workspace)}</span>
          </>
        )}
        <span className="main-spacer" />
        <ConnectionStatus state={connection} />
      </header>
      <section className="board" aria-label={TEXT.board}>
        <Body connection={connection} workspace={workspace} loaded={loaded} loadError={loadError} />
      </section>
    </main>
  );
}

function Body({ connection, workspace, loaded, loadError }: MainAreaProps) {
  if (connection.status === "failed") return <ConnectionFailure state={connection} />;
  if (loadError !== undefined) {
    return (
      <div className="failure">
        <p className="detail">{TEXT.loadFailed}</p>
        <p className="detail">{loadError}</p>
      </div>
    );
  }
  if (!loaded) return <p className="placeholder">{connection.status === "connected" ? TEXT.loading : null}</p>;
  return <p className="placeholder">{workspace ? TEXT.boardPlaceholder : TEXT.noWorkspaces}</p>;
}
