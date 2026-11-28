// The contract between the main process, the preload bridge and the renderer. Types and
// constants only: the renderer and the sandboxed preload import nothing else from outside.
import type { ClientEvent, CommandReply, QueryReply } from "@tokama/client";
import type { CommandInput, DiagnosticEntry, PostFailure, QueryInput, UsageAction } from "@tokama/core";
import type { AwayInfo, DesktopState, LayoutPatch, NotificationSettings, SoundName, SoundSet } from "./desktop-state.js";
import type { InstallResult, UpdateState } from "./update.js";
import type { Note } from "./whats-new.js";

/** The desktop app's view of its engine connection. */
export type ConnectionState =
  /** `updating`: an older engine is being stopped, and this version's starts next. */
  | { readonly status: "starting"; readonly updating?: true }
  /** `staleEngine`: the engine runs older code and items, so it is used until it is idle, then replaced. */
  | { readonly status: "connected"; readonly engineId: string; readonly staleEngine?: true }
  | { readonly status: "reconnecting" }
  | {
      readonly status: "failed";
      readonly reason: string;
      /** The engine's log file, where a started engine writes its output. */
      readonly logPath: string;
      /** The last lines of the log, when it could be read. */
      readonly logTail: readonly string[];
      /** An older engine of this app still runs and may be busy: the app asks before it restarts it. */
      readonly older?: OlderEngine;
    };

export interface OlderEngine {
  /** Items it runs now; absent when it is too old to say. */
  readonly runningItems?: number;
  /** When the user pressed Try again and the engine was found busy still, epoch ms. */
  readonly checkedAt?: number;
  readonly lockPath: string;
  /** The pid in its lock, when it could be read. */
  readonly pid?: number;
}

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
  restartEngine: "tokama:connection:restart-engine",
  query: "tokama:engine:query",
  command: "tokama:engine:command",
  event: "tokama:engine:event",
  pickFolder: "tokama:dialog:pick-folder",
  openTemplateFile: "tokama:template:open",
  openAttemptFile: "tokama:attempt:open",
  getToolsPath: "tokama:engine:tools-path",
  getAboutInfo: "tokama:about:info",
  copyBuildInfo: "tokama:about:copy",
  showDataFolder: "tokama:about:show-folder",
  openNotices: "tokama:about:open-notices",
  getDesktopState: "tokama:desktop:get",
  saveLayout: "tokama:desktop:save-layout",
  reportError: "tokama:diagnostics:report-error",
  countUsage: "tokama:diagnostics:count-usage",
  saveNotifications: "tokama:notifications:save",
  playSound: "tokama:sounds:play",
  notificationStatus: "tokama:notifications:status",
  sendTestNotification: "tokama:notifications:test",
  openNotificationSettings: "tokama:notifications:open-settings",
  viewedItem: "tokama:notifications:viewed",
  openItem: "tokama:notifications:open-item",
  openGetStarted: "tokama:help:get-started",
  loadDiagnostics: "tokama:diagnostics:load",
  sendDiagnostics: "tokama:diagnostics:send",
  saveDiagnostics: "tokama:diagnostics:save",
  stopCrashPrompt: "tokama:diagnostics:stop-crash-prompt",
  getWhatsNew: "tokama:whats-new:get",
  closeWhatsNew: "tokama:whats-new:close",
  getUpdate: "tokama:update:get",
  updateChanged: "tokama:update:changed",
  checkForUpdates: "tokama:update:check",
  installUpdate: "tokama:update:install",
  openUpdateNotes: "tokama:update:notes",
  getAway: "tokama:away:get",
  awayChanged: "tokama:away:changed",
  closeAway: "tokama:away:close",
} as const;

/** The usage actions only the window sees. The main process counts no other name from the window. */
export const RENDERER_USAGE_ACTIONS = ["expand_view"] as const satisfies readonly UsageAction[];
export type RendererUsageAction = (typeof RENDERER_USAGE_ACTIONS)[number];

/** What the page of notifications knows of how the system treats them. */
export interface NotificationStatus {
  /** The system turned the last notification down (or has no notification service). False until one was tried. */
  readonly blocked: boolean;
  /** The app can open the system's notification settings: macOS. */
  readonly canOpenSettings: boolean;
  /** Linux has none of `pw-play`, `paplay` and `aplay`, so Tokama's own sounds cannot play and every play beeps. */
  readonly soundPlayerMissing: boolean;
}

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

/**
 * The release notes this app ships, for the card, the chip and About. `notes` are the notes of this
 * version and earlier ones that parsed, newest first. `due` is what has not been shown yet: the
 * card of a release with highlights, or the chip of a fixes-only or security release, each named
 * by its version.
 */
export interface WhatsNewInfo {
  readonly appVersion: string;
  readonly notes: readonly Note[];
  readonly due?: { readonly card?: string; readonly chip?: { readonly version: string; readonly kind: "fixes" | "security" } };
}

/**
 * Where the PATH the engine started with came from. It never carries the PATH itself, which holds
 * the user's folder names. `problem` is one plain sentence, set when the login shell could not be read.
 * `engine-running`: this app run attached to an engine that was already running, so it does not
 * know that engine's PATH.
 */
export interface ToolsPathInfo {
  readonly source: "login-shell" | "inherited" | "engine-running";
  /** The login shell's file name, when one was run. */
  readonly shell?: string;
  readonly problem?: string;
  /** The login shell answered, but only after the 5 s timeout. */
  readonly slow?: true;
}

/** Where the engine found a template file: a repo id and the repo-relative path. */
export interface TemplateFileName {
  readonly origin: string;
  readonly file: string;
}

/** A saved file of a step's attempt: its transcript, or the output of check number `file` (from 1). */
export interface AttemptFileName {
  readonly itemId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly file: "transcript" | number;
}

/** Whether a file opened; the message says why not, in plain words. */
export type OpenResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A waiting diagnostics entry and its text: exactly what Send all and Save as file put out for it. */
export interface DiagnosticsItem {
  readonly entry: DiagnosticEntry;
  readonly text: string;
}

/** Every waiting diagnostics entry, newest first. */
export type DiagnosticsLoad = { readonly ok: true; readonly items: readonly DiagnosticsItem[] } | { readonly ok: false; readonly reason: "not_connected" | "unavailable" };

/**
 * Why Send all sent nothing. `busy`: a send runs already. `nothing`: none of the entries is waiting.
 * The others say how the receiver answered, or that it did not: `rejected` (400), `too_large` (413,
 * or larger than an upload may be), `unsupported` (415), `rate_limited` (429), `busy_today` (503:
 * its daily budget is used up), `server` (any other status), `bad_reply` (a success without a
 * report id), `timeout` and `network` (no answer). `no_receiver`: a development build on the sample
 * engine sends nowhere unless a local test server is named. The egress post's own kinds pass
 * through as they are; its `not_allowed` and `status` become the words above.
 */
export type DiagnosticsSendFailure =
  | Exclude<PostFailure["kind"], "not_allowed" | "status">
  | "not_connected"
  | "no_receiver"
  | "busy"
  | "nothing"
  | "rejected"
  | "unsupported"
  | "rate_limited"
  | "busy_today"
  | "server";

/**
 * `sent` entries went out and were removed, except `kept` of them whose delete failed (they stay
 * listed). On failure nothing was removed. `detail`: with
 * `rejected`, the receiver's short reason, one line of plain text.
 */
export type DiagnosticsSendResult = { readonly ok: true; readonly sent: number; readonly kept?: number } | { readonly ok: false; readonly reason: DiagnosticsSendFailure; readonly count: number; readonly detail?: string };

export type DiagnosticsSaveResult = { readonly ok: true } | { readonly ok: false; readonly reason: "cancelled" | "nothing" | "failed" };

/** What the preload script exposes to the renderer as `window.tokama`. */
export interface TokamaBridge {
  getConnection(): Promise<ConnectionState>;
  /** After a failed connection: tries to start and reach the engine again. Does nothing in any other state. */
  retryConnection(): Promise<void>;
  /** With an older engine on screen: stop it now and start this version's. Does nothing in any other state. */
  restartEngine(): Promise<void>;
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
  /**
   * Opens a saved check log or agent transcript in the system's app for its type. The main process
   * asks the engine where the file is and opens only `.log` and `.txt` files in that item's folder.
   */
  openAttemptFile(name: AttemptFileName): Promise<OpenResult>;
  /** Where the engine's PATH came from: the login shell, or the PATH the app was started with. */
  getToolsPath(): Promise<ToolsPathInfo>;
  /** What About shows about this build. */
  getAboutInfo(): Promise<AboutInfo>;
  /** Puts the build info as text on the clipboard. The main process writes it; the renderer sends no text. */
  copyBuildInfo(): Promise<void>;
  /** Opens the Tokama home in the system's file manager. */
  showDataFolder(): Promise<OpenResult>;
  /** Opens the file of third-party licence texts that ships with the app in the system's default app for Markdown. */
  openNotices(): Promise<OpenResult>;
  /** What this machine's `desktop.json` holds, validated; the defaults when it is missing or broken. */
  getDesktopState(): Promise<DesktopState>;
  /** Remembers the layout choices in `patch`. The main process validates them and ignores any other field. */
  saveLayout(patch: LayoutPatch): Promise<void>;
  /**
   * Reports an error the window did not catch, for the engine's diagnostics. Only the message and
   * the stack cross; the engine cleans them before it records anything.
   */
  reportError(error: { readonly message: string; readonly stack: string }): Promise<void>;
  /**
   * Counts one use of an action that only the window sees, such as expanding a view, for the
   * engine's daily usage counts. Only the fixed names of `RENDERER_USAGE_ACTIONS` count; the main
   * process ignores anything else.
   */
  countUsage(action: RendererUsageAction): Promise<void>;
  /** Remembers the notification choices in `patch`: a mode per kind and the sound set. The main process validates them and ignores any other field. */
  saveNotifications(patch: Partial<NotificationSettings>): Promise<void>;
  /** Plays a sound now, from `set`, whatever the mode of its kind and whatever Focus says: the user asked for it. The main process ignores a name or set it does not know. */
  playSound(name: SoundName, set: SoundSet): Promise<void>;
  /** Whether the system turned the app's last notification down, and whether the app can open the system's notification settings. */
  notificationStatus(): Promise<NotificationStatus>;
  /** Shows one sample banner and plays the Needs you sound the way a real event does, whatever the modes say. */
  sendTestNotification(): Promise<void>;
  /** Opens the system's notification settings (macOS only; a no-op elsewhere). The address is fixed in the main process. */
  openNotificationSettings(): Promise<void>;
  /**
   * Tells the main process which item the window shows in the drawer or the full view now (none:
   * undefined), so it shows no notification for that item while the window is in front.
   */
  setViewedItem(itemId: string | undefined): Promise<void>;
  /**
   * Calls `listener` with the id of an item the user asked to open by clicking its notification;
   * one that came before the listener was set is delivered at once. Returns a function that stops it.
   */
  onOpenItem(listener: (itemId: string) => void): () => void;
  /**
   * Calls `listener` when the user chose Help > Get started in the menu; one that came before the
   * listener was set is delivered at once. Returns a function that stops it.
   */
  onOpenGetStarted(listener: () => void): () => void;
  /** Every waiting diagnostics entry with its text. The main process keeps the texts it gave out. */
  loadDiagnostics(): Promise<DiagnosticsLoad>;
  /**
   * Sends the entries with these ids from the last load, as the texts that load gave out, in one
   * request to the diagnostics receiver, and removes them after it stored them. The URL is the main
   * process's own.
   */
  sendDiagnostics(ids: readonly string[]): Promise<DiagnosticsSendResult>;
  /** Writes the same text Send all would send for these ids to a file the user picks. */
  saveDiagnostics(ids: readonly string[]): Promise<DiagnosticsSaveResult>;
  /** Don't ask again: no crash prompt from now on. */
  stopCrashPrompt(): Promise<void>;
  /** The release notes of this version and earlier ones, and which of them are still to show. The main process reads them from files that ship with the app. */
  getWhatsNew(): Promise<WhatsNewInfo>;
  /** The card or the chip of this version was shown or closed: it never shows again. The main process ignores any version that is not the one due. */
  closeWhatsNew(version: string, what: "card" | "chip"): Promise<void>;
  /** Where updating stands now. */
  getUpdate(): Promise<UpdateState>;
  /** Calls `listener` on every change of the update state; returns a function that stops it. */
  onUpdate(listener: (state: UpdateState) => void): () => void;
  /** Checks for an update now. Does nothing while one is being checked or downloaded, or is ready. */
  checkForUpdates(): Promise<void>;
  /**
   * Restarts into the ready update. The main process asks the engine itself whether anything runs
   * and refuses (`busy`) if it does or cannot tell; nothing stops running work.
   */
  installUpdate(): Promise<InstallResult>;
  /**
   * Opens the release page of the update that is downloading or ready in the system browser. No
   * address comes from the window: the main process builds it from the update's own version.
   */
  openUpdateNotes(): Promise<void>;
  /** Whether the user was away 15 minutes or more and has not pressed Got it, and what they have seen until. */
  getAway(): Promise<AwayInfo>;
  /** Calls `listener` on every change of the away state; returns a function that stops it. */
  onAway(listener: (info: AwayInfo) => void): () => void;
  /** Got it: the main process sets "seen until" to its own now and ends the strip. The window sends no time. */
  closeAway(): Promise<void>;
}
