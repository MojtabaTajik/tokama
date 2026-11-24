// The main area: the "All work" header and, below it, the board (#30 fills it).
// When the engine is not available, its failure details take the board's place; a failed load
// shows its reason and a Retry action there.
import type { ConnectionState } from "../../shared/bridge.js";
import { ConnectionFailure } from "./ConnectionStatus.js";

const TEXT = {
  title: "All work",
  board: "Board",
  boardPlaceholder: "The board comes here.",
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loading: "Loading",
  loadFailed: "Could not load the setup and items",
  retry: "Retry",
} as const;

export interface MainAreaProps {
  readonly connection: ConnectionState;
  readonly loaded: boolean;
  readonly loadError: string | undefined;
  readonly onRetry: () => void;
}

export function MainArea(props: MainAreaProps) {
  return (
    <main className="main">
      <header className="main-header">
        <h1 className="ellipsis">{TEXT.title}</h1>
      </header>
      <section className="board" aria-label={TEXT.board}>
        <Body {...props} />
      </section>
    </main>
  );
}

function Body({ connection, loaded, loadError, onRetry }: MainAreaProps) {
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
      {(loaded || loadError === undefined) && <p className="placeholder">{placeholder(connection, loaded)}</p>}
    </>
  );
}

function placeholder(connection: ConnectionState, loaded: boolean): string {
  if (connection.status === "starting") return TEXT.starting;
  if (!loaded) return connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading;
  return TEXT.boardPlaceholder;
}
