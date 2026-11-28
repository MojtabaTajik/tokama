// The local engine connection: its health under "+ New work" in the sidebar, a chip in the main
// header for the two states that need a word there, and the screens of the board area when the
// engine is not available: an older engine that still runs (Needs you), the engine being
// updated, or an engine that could not start. All of it is React text.
import type { ConnectionState } from "../../shared/bridge.js";
import { clock } from "../format/time.js";
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
  staleEngine: "The engine is from an older version and restarts when idle",
  log: "Log",
  tryAgain: "Try again",
  lock: "lock",
  pid: "pid",
  restartNow: "Restart engine now",
  needsYou: "Needs you",
  olderChip: "Older engine running",
  olderTitle: "An older engine is still running",
  olderKnown: (count: number) => `It is from the Tokama version before the update, and it is running ${count === 1 ? "1 item" : `${count} items`}. This version can’t use it.`,
  olderUnknown: "It is from the Tokama version before the update. It did not say whether it is running items. This version can’t use it.",
  restartKnown: "stops these items. Each one then waits in Needs you, where you choose Retry step or Stop.",
  restartUnknown: "stops any items it is running. Each one then waits in Needs you, where you choose Retry step or Stop.",
  tryKnown: "checks whether they have finished. Once nothing is running, Tokama updates the engine by itself.",
  tryUnknown: "checks the engine again.",
  checked: (at: number) => `Checked at ${clock(at)}. Not finished yet.`,
  olderHint: "Tokama stops only its own engine, the one shown above. It never touches other processes.",
  notRunningKicker: "Engine not running",
  notRunning: "The engine is not available",
  updating: "Updating engine…",
  updatingDetail: "Stopping the older engine and starting the new one. This takes a few seconds.",
} as const;

/** The words for a "starting" state: updating the engine, or starting it. */
export function startingWords(state: Extract<ConnectionState, { status: "starting" }>, starting: string): string {
  return state.updating === true ? TEXT.updating : starting;
}

// A symbol with every status, so colour is never the only signal.
const SYMBOL = {
  starting: markOf("queued").symbol,
  reconnecting: markOf("checking").symbol,
  failed: markOf("failed").symbol,
} as const satisfies Partial<Record<ConnectionState["status"], string>>;

/** Symbol and word when something is off; nothing to see while connected, where only screen readers get the word. The status region stays mounted, so a change is announced. */
export function EngineHealth({ state }: { readonly state: ConnectionState }) {
  if (state.status === "connected") {
    return (
      <span className="health" data-status="connected" role="status">
        <span className="visually-hidden">{TEXT.health.connected}</span>
      </span>
    );
  }
  return (
    <span className="health" data-status={state.status} role="status">
      <span className="symbol" aria-hidden="true">
        {SYMBOL[state.status]}
      </span>
      <span className="health-word">{state.status === "starting" && state.updating === true ? TEXT.health.updating : TEXT.health[state.status]}</span>
    </span>
  );
}

/** A quiet note under the engine line while the engine in use runs older code and items, and restarts when idle. Nothing otherwise. */
export function StaleEngineNote({ state }: { readonly state: ConnectionState }) {
  if (state.status !== "connected" || state.staleEngine !== true) return null;
  return (
    <p className="engine-note" role="status">
      <span className="symbol" aria-hidden="true">
        {SYMBOL.starting}
      </span>
      {TEXT.staleEngine}
    </p>
  );
}

/** The main header's chip: an older engine waits for the user, or the engine is being updated. Nothing for any other state. */
export function EngineChip({ state, restartable }: { readonly state: ConnectionState; readonly restartable: boolean }) {
  if (state.status === "failed" && state.older !== undefined && restartable) {
    return (
      <span className="engine-chip" data-tone="warn" role="status">
        <span className="symbol" aria-hidden="true">
          {markOf("needs_you").symbol}
        </span>
        {TEXT.olderChip}
      </span>
    );
  }
  if (state.status === "starting" && state.updating === true) {
    return (
      <span className="engine-chip" data-tone="live" role="status">
        <span className="symbol" aria-hidden="true">
          {markOf("running").symbol}
        </span>
        {TEXT.updating}
      </span>
    );
  }
  return null;
}

/** The engine is being replaced: a status line and what happens. No buttons. */
export function UpdatingEngine() {
  return (
    <section className="failure updating" aria-label={TEXT.updating}>
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          {markOf("running").symbol}
        </span>{" "}
        {TEXT.updating}
      </p>
      <p className="detail">{TEXT.updatingDetail}</p>
    </section>
  );
}

export interface FailureActions {
  readonly onRetry: () => void;
  /** With an older engine: stop it, whatever it runs, and start this version's. */
  readonly onRestart?: () => void;
}

export function ConnectionFailure({ state, onRetry, onRestart }: { readonly state: Extract<ConnectionState, { status: "failed" }> } & FailureActions) {
  const older = state.older;
  if (older !== undefined && onRestart !== undefined) return <OlderEngine older={older} onRestart={onRestart} onRetry={onRetry} />;
  return (
    <section className="failure" aria-label={TEXT.notRunning}>
      <p className="failure-kicker" data-tone="fail">
        <span className="symbol" aria-hidden="true">
          {SYMBOL.failed}
        </span>{" "}
        {TEXT.notRunningKicker}
      </p>
      <p className="failure-title">{TEXT.notRunning}</p>
      <p className="detail">{state.reason}</p>
      <p className="detail">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      {state.logTail.length > 0 && <pre className="log mono">{state.logTail.join("\n")}</pre>}
      <Button variant="primary" className="retry" onClick={onRetry}>
        {TEXT.tryAgain}
      </Button>
    </section>
  );
}

/** An older engine of this app still runs, busy or not saying: the user restarts it now, or checks again later. */
function OlderEngine({
  older,
  onRestart,
  onRetry,
}: {
  readonly older: NonNullable<Extract<ConnectionState, { status: "failed" }>["older"]>;
  readonly onRestart: () => void;
  readonly onRetry: () => void;
}) {
  // An engine that says it runs nothing was not replaced only by a race; it reads like one that did not say.
  const known = older.runningItems !== undefined && older.runningItems > 0 ? older.runningItems : undefined;
  return (
    <section className="failure older" aria-label={TEXT.olderTitle}>
      <p className="failure-kicker" data-tone="warn">
        <span className="symbol" aria-hidden="true">
          {markOf("needs_you").symbol}
        </span>{" "}
        {TEXT.needsYou}
      </p>
      <p className="failure-title">{TEXT.olderTitle}</p>
      <p className="detail">{known === undefined ? TEXT.olderUnknown : TEXT.olderKnown(known)}</p>
      <pre className="log mono">
        {`${TEXT.lock}  ${older.lockPath}`}
        {older.pid === undefined ? "" : `\n${TEXT.pid}   ${older.pid}`}
      </pre>
      <p className="detail">
        <strong>{TEXT.restartNow}</strong> {known === undefined ? TEXT.restartUnknown : TEXT.restartKnown}
      </p>
      <p className="detail">
        <strong>{TEXT.tryAgain}</strong> {known === undefined ? TEXT.tryUnknown : TEXT.tryKnown}
      </p>
      <div className="older-actions">
        <Button variant="primary" className="retry" onClick={onRestart}>
          {TEXT.restartNow}
        </Button>
        <Button onClick={onRetry}>{TEXT.tryAgain}</Button>
      </div>
      {known !== undefined && older.checkedAt !== undefined && <p className="detail older-checked">{TEXT.checked(older.checkedAt)}</p>}
      <p className="detail hint">{TEXT.olderHint}</p>
    </section>
  );
}
