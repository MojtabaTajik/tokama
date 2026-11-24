// The contract between the main process, the preload bridge and the renderer. Types and
// constants only: the renderer and the sandboxed preload import nothing else from outside.
import type { ClientEvent, CommandReply, QueryReply } from "@tokama/client";
import type { CommandInput, QueryInput } from "@tokama/core";

/** The desktop app's view of its engine connection. */
export type ConnectionState =
  | { readonly status: "starting" }
  | { readonly status: "connected"; readonly engineId: string }
  | { readonly status: "reconnecting" }
  | {
      readonly status: "failed";
      readonly reason: string;
      /** The engine's log file, where a started engine writes its output. */
      readonly logPath: string;
      /** The last lines of the log, when it could be read. */
      readonly logTail: readonly string[];
    };

/**
 * An engine event with its stream position. Losing and regaining the connection comes through
 * the connection state instead: after every return to "connected", re-run the queries.
 */
export type BridgeEvent = Extract<ClientEvent, { kind: "event" }>;

/**
 * The error codes the main process adds to the engine's own (`invalid_request`, `not_found`, ...)
 * when it answers a query or command itself.
 */
export const BRIDGE_ERROR_CODES = {
  /** The renderer sent something that is not a valid query or command; nothing was sent to the engine. */
  invalidRequest: "invalid_request",
  /** There is no engine connection yet, or no more. */
  notConnected: "not_connected",
} as const;

/** IPC channels. The renderer never sees them: it gets the bridge below. */
export const CHANNELS = {
  getConnection: "tokama:connection:get",
  connectionChanged: "tokama:connection:changed",
  retryConnection: "tokama:connection:retry",
  query: "tokama:engine:query",
  command: "tokama:engine:command",
  event: "tokama:engine:event",
} as const;

/** What the preload script exposes to the renderer as `window.tokama`. */
export interface TokamaBridge {
  getConnection(): Promise<ConnectionState>;
  /** After a failed connection: tries to start and reach the engine again. Does nothing in any other state. */
  retryConnection(): Promise<void>;
  /** Calls `listener` on every change; returns a function that stops it. */
  onConnection(listener: (state: ConnectionState) => void): () => void;
  /** Any engine API query. The main process validates it before it reaches the engine. */
  query<Q extends QueryInput>(query: Q): Promise<QueryReply<Q["type"]>>;
  /** Any engine API command. The main process validates it before it reaches the engine. */
  command<C extends CommandInput>(command: C): Promise<CommandReply<C["type"]>>;
  /** Calls `listener` with every engine event; returns a function that stops it. */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}
