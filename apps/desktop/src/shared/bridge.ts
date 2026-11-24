// The contract between the main process, the preload bridge and the renderer. Types and
// constants only: the renderer and the sandboxed preload import nothing else from outside.

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

/** IPC channels. The renderer never sees them: it gets the bridge below. */
export const CHANNELS = {
  getConnection: "tokama:connection:get",
  connectionChanged: "tokama:connection:changed",
} as const;

/** What the preload script exposes to the renderer as `window.tokama`. */
export interface TokamaBridge {
  getConnection(): Promise<ConnectionState>;
  /** Calls `listener` on every change; returns a function that stops it. */
  onConnection(listener: (state: ConnectionState) => void): () => void;
}
