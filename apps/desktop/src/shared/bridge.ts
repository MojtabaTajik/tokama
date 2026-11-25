// The contract between the main process, the preload bridge and the renderer. Types and
// constants only: the renderer and the sandboxed preload import nothing else from outside.
import type { ClientEvent, CommandReply, QueryReply } from "@tokama/client";
import type { CommandInput, QueryInput } from "@tokama/core";
import type { DesktopState, LayoutPatch } from "./desktop-state.js";

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
  pickFolder: "tokama:dialog:pick-folder",
  openTemplateFile: "tokama:template:open",
  getAboutInfo: "tokama:about:info",
  copyBuildInfo: "tokama:about:copy",
  showDataFolder: "tokama:about:show-folder",
  getDesktopState: "tokama:desktop:get",
  saveLayout: "tokama:desktop:save-layout",
  reportError: "tokama:diagnostics:report-error",
  countUsage: "tokama:diagnostics:count-usage",
} as const;

/** What About shows about this build. The main process fills it; every field is plain text or a number. */
export interface AboutInfo {
  readonly app: { readonly version: string; /** The build day, `YYYY-MM-DD`; "unknown" without git. */ readonly built: string; /** The short commit; "unknown" without git. */ readonly commit: string };
  /** `pid` is the engine's own, from its lock file; absent while no engine has written one. */
  readonly engine: { readonly version: string; readonly apiVersion: number; readonly pid?: number };
  /** The Tokama home, written with `~` for the user's home folder. */
  readonly dataFolder: string;
  readonly runtime: { readonly electron: string; readonly node: string };
  /** The system and CPU, for example "macOS · arm64". */
  readonly platform: string;
}

/** Where the engine found a template file: a repo id and the repo-relative path. */
export interface TemplateFileName {
  readonly origin: string;
  readonly file: string;
}

/** Whether a file opened; the message says why not, in plain words. */
export type OpenResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

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
  /** The native folder picker; null when cancelled. The engine checks the folder before using it. */
  pickFolder(): Promise<string | null>;
  /**
   * Opens a template file in the system's editor for its type. The main process asks the engine
   * where the file is and opens only template files in a `.tokama` folder or the Tokama home.
   */
  openTemplateFile(name: TemplateFileName): Promise<OpenResult>;
  /** What About shows about this build. */
  getAboutInfo(): Promise<AboutInfo>;
  /** Puts the build info as text on the clipboard. The main process writes it; the renderer sends no text. */
  copyBuildInfo(): Promise<void>;
  /** Opens the Tokama home in the system's file manager. */
  showDataFolder(): Promise<OpenResult>;
  /** What this machine's `desktop.json` holds, validated; the defaults when it is missing or broken. */
  getDesktopState(): Promise<DesktopState>;
  /** Remembers the layout choices in `patch`. The main process validates them and ignores any other field. */
  saveLayout(patch: LayoutPatch): Promise<void>;
  /**
   * Reports an error the window did not catch, for the engine's diagnostics. Only the message and
   * the stack cross; the engine cleans them before it records anything.
   */
  reportError(error: { readonly message: string; readonly stack: string }): Promise<void>;
  /** Counts one use of an action only the window sees, such as expanding a view. */
  countUsage(action: "expand_view"): Promise<void>;
}
