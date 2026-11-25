// The local engine connection: its health under "+ New work" in the sidebar, and the
// failure details (reason, log path, log tail) in the board area when the engine is not
// available. All of it is React text.
import type { ConnectionState } from "../../shared/bridge.js";
import { Button } from "../ui/Button.js";
import { markOf } from "../ui/status.js";

const TEXT = {
  health: {
    starting: "starting",
    connected: "engine connected",
    reconnecting: "reconnecting",
    failed: "not available",
    updating: "updating engine",
  },
  failed: "The engine is not available",
  engineId: "Engine",
  log: "Log",
  retry: "Retry",
  hint: "Tokama stops only its own older engine, after checking it is one. It never touches other processes.",
  lock: "lock",
  pid: "pid",
  restart: "Restart engine",
  restartNow: "Restart now",
  wait: "Wait",
  busyBefore: (count: number) => `It is running ${tasks(count)}. `,
  busyMiddle: " (they pause and ask Retry or Stop) or ",
  busyAfter: " until they finish.",
  waiting: (count: number) => `Waiting for ${tasks(count)} to finish; then Tokama restarts the engine.`,
  updating: "Updating engine…",
} as const;

function tasks(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

/** The words for a "starting" state: updating the engine, or starting it. */
export function startingWords(state: Extract<ConnectionState, { status: "starting" }>, starting: string): string {
  return state.updating === true ? TEXT.updating : starting;
}

// A symbol with every status, so colour is never the only signal.
const SYMBOL: Record<ConnectionState["status"], string> = {
  starting: markOf("queued").symbol,
  connected: markOf("running").symbol,
  reconnecting: markOf("checking").symbol,
  failed: markOf("failed").symbol,
};

/** Symbol and word; healthy is a quiet dot whose word only screen readers get. */
export function EngineHealth({ state }: { readonly state: ConnectionState }) {
  const title = state.status === "connected" ? `${TEXT.engineId} ${state.engineId}` : undefined;
  return (
    <span className="health" data-status={state.status} title={title} role="status">
      <span className="symbol" aria-hidden="true">
        {SYMBOL[state.status]}
      </span>
      <span className={state.status === "connected" ? "visually-hidden" : "health-word"}>{state.status === "starting" && state.updating === true ? TEXT.health.updating : TEXT.health[state.status]}</span>
    </span>
  );
}

export interface FailureActions {
  readonly onRetry: () => void;
  /** With an older engine: stop it and start this version's. */
  readonly onRestart?: () => void;
  /** With an older busy engine: restart it once nothing runs. */
  readonly onWait?: () => void;
}

export function ConnectionFailure({ state, onRetry, onRestart, onWait }: { readonly state: Extract<ConnectionState, { status: "failed" }> } & FailureActions) {
  const older = state.older;
  if (older !== undefined && onRestart !== undefined) return <OlderEngine state={state} older={older} onRestart={onRestart} {...(onWait !== undefined && { onWait })} />;
  return (
    <section className="failure" aria-label={TEXT.failed}>
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          {SYMBOL.failed}
        </span>
        {TEXT.failed}
      </p>
      <p className="detail">{state.reason}</p>
      <p className="detail">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      {state.logTail.length > 0 && <pre className="log mono">{state.logTail.join("\n")}</pre>}
      <p className="detail hint">{TEXT.hint}</p>
      <Button variant="primary" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </Button>
    </section>
  );
}

/** An older engine of this app still runs: restart it, or (when busy) wait until it is idle. */
function OlderEngine({
  state,
  older,
  onRestart,
  onWait,
}: {
  readonly state: Extract<ConnectionState, { status: "failed" }>;
  readonly older: NonNullable<Extract<ConnectionState, { status: "failed" }>["older"]>;
  readonly onRestart: () => void;
  readonly onWait?: () => void;
}) {
  const busy = older.runningItems !== undefined && older.runningItems > 0 ? older.runningItems : undefined;
  return (
    <section className="failure" aria-label={TEXT.failed}>
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          {SYMBOL.failed}
        </span>
        {TEXT.failed}
      </p>
      <p className="detail">{state.reason}</p>
      <pre className="log mono">
        {`${TEXT.lock}  ${older.lockPath}`}
        {older.pid === undefined ? "" : `\n${TEXT.pid}   ${older.pid}`}
      </pre>
      <p className="detail older-log">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      <Button variant="primary" className="retry" onClick={onRestart}>
        {TEXT.restart}
      </Button>
      {busy !== undefined && (
        <p className="detail hint">
          {older.waiting ? (
            TEXT.waiting(busy)
          ) : (
            <>
              {TEXT.busyBefore(busy)}
              <Button variant="link" inline onClick={onRestart}>
                {TEXT.restartNow}
              </Button>
              {TEXT.busyMiddle}
              {onWait === undefined ? (
                TEXT.wait.toLowerCase()
              ) : (
                <Button variant="link" inline onClick={onWait}>
                  {TEXT.wait}
                </Button>
              )}
              {TEXT.busyAfter}
            </>
          )}
        </p>
      )}
    </section>
  );
}
