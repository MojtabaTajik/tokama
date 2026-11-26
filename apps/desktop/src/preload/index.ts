// Preload bridge. It runs sandboxed, so it is bundled into one CommonJS file and may import only
// `electron`. It exposes `window.tokama` (TokamaBridge) and nothing else: no ipcRenderer, no
// channel names, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type AboutInfo, type BridgeEvent, CHANNELS, type ConnectionState, type DiagnosticsLoad, type DiagnosticsSaveResult, type DiagnosticsSendResult, type OpenResult, type ToolsPathInfo, type TokamaBridge, type WhatsNewInfo } from "../shared/bridge.js";
import type { DesktopState } from "../shared/desktop-state.js";
import type { InstallResult, UpdateState } from "../shared/update.js";

/** Subscribes to a pushed channel. Wrapped, so the renderer never receives the IPC event object (it carries `sender`). */
function subscribe<T>(channel: string, listener: (message: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, message: T) => listener(message);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// A click on a notification can come while the window is still loading, before the renderer has a
// listener. The latest item id waits here until one is set.
let openListener: ((itemId: string) => void) | undefined;
let waitingItemId: string | undefined;
ipcRenderer.on(CHANNELS.openItem, (_event: IpcRendererEvent, itemId: unknown) => {
  if (typeof itemId !== "string") return;
  if (openListener === undefined) waitingItemId = itemId;
  else openListener(itemId);
});

export const bridge: TokamaBridge = {
  getConnection: () => ipcRenderer.invoke(CHANNELS.getConnection) as Promise<ConnectionState>,
  retryConnection: () => ipcRenderer.invoke(CHANNELS.retryConnection) as Promise<void>,
  restartEngine: () => ipcRenderer.invoke(CHANNELS.restartEngine) as Promise<void>,
  waitForEngine: () => ipcRenderer.invoke(CHANNELS.waitForEngine) as Promise<void>,
  onConnection: (listener) => subscribe<ConnectionState>(CHANNELS.connectionChanged, listener),
  // The reply's type follows the request's: main validates the request, the client parses the reply.
  query: (query) => ipcRenderer.invoke(CHANNELS.query, query) as never,
  command: (command) => ipcRenderer.invoke(CHANNELS.command, command) as never,
  onEvent: (listener) => subscribe<BridgeEvent>(CHANNELS.event, listener),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder) as Promise<string | null>,
  // Only the two names cross, whatever else the renderer passes.
  openTemplateFile: ({ origin, file }) => ipcRenderer.invoke(CHANNELS.openTemplateFile, { origin, file }) as Promise<OpenResult>,
  // Only the four names cross, whatever else the renderer passes.
  openAttemptFile: ({ itemId, stepIndex, attempt, file }) => ipcRenderer.invoke(CHANNELS.openAttemptFile, { itemId, stepIndex, attempt, file }) as Promise<OpenResult>,
  getToolsPath: () => ipcRenderer.invoke(CHANNELS.getToolsPath) as Promise<ToolsPathInfo>,
  getAboutInfo: () => ipcRenderer.invoke(CHANNELS.getAboutInfo) as Promise<AboutInfo>,
  copyBuildInfo: () => ipcRenderer.invoke(CHANNELS.copyBuildInfo) as Promise<void>,
  showDataFolder: () => ipcRenderer.invoke(CHANNELS.showDataFolder) as Promise<OpenResult>,
  getDesktopState: () => ipcRenderer.invoke(CHANNELS.getDesktopState) as Promise<DesktopState>,
  saveLayout: (patch) => ipcRenderer.invoke(CHANNELS.saveLayout, patch) as Promise<void>,
  // Only the two strings cross, whatever else the renderer passes.
  reportError: ({ message, stack }) => ipcRenderer.invoke(CHANNELS.reportError, { message: String(message), stack: String(stack) }) as Promise<void>,
  // Only the action's name crosses, as a string.
  countUsage: (action) => ipcRenderer.invoke(CHANNELS.countUsage, String(action)) as Promise<void>,
  saveNotifications: (patch) => ipcRenderer.invoke(CHANNELS.saveNotifications, patch) as Promise<void>,
  // Only the two names cross, as strings.
  playSound: (name, set) => ipcRenderer.invoke(CHANNELS.playSound, String(name), String(set)) as Promise<void>,
  setViewedItem: (itemId) => ipcRenderer.invoke(CHANNELS.viewedItem, itemId) as Promise<void>,
  onOpenItem: (listener) => {
    openListener = listener;
    if (waitingItemId !== undefined) {
      const itemId = waitingItemId;
      waitingItemId = undefined;
      listener(itemId);
    }
    return () => {
      if (openListener === listener) openListener = undefined;
    };
  },
  loadDiagnostics: () => ipcRenderer.invoke(CHANNELS.loadDiagnostics) as Promise<DiagnosticsLoad>,
  // Only a list of strings crosses, whatever else the renderer passes; main checks each id.
  sendDiagnostics: (ids) => ipcRenderer.invoke(CHANNELS.sendDiagnostics, Array.from(ids, String)) as Promise<DiagnosticsSendResult>,
  saveDiagnostics: (ids) => ipcRenderer.invoke(CHANNELS.saveDiagnostics, Array.from(ids, String)) as Promise<DiagnosticsSaveResult>,
  stopCrashPrompt: () => ipcRenderer.invoke(CHANNELS.stopCrashPrompt) as Promise<void>,
  getWhatsNew: () => ipcRenderer.invoke(CHANNELS.getWhatsNew) as Promise<WhatsNewInfo>,
  // Only the two values cross, as strings.
  closeWhatsNew: (version, what) => ipcRenderer.invoke(CHANNELS.closeWhatsNew, String(version), String(what)) as Promise<void>,
  getUpdate: () => ipcRenderer.invoke(CHANNELS.getUpdate) as Promise<UpdateState>,
  onUpdate: (listener) => subscribe<UpdateState>(CHANNELS.updateChanged, listener),
  // No argument crosses: main decides everything from its own state.
  checkForUpdates: () => ipcRenderer.invoke(CHANNELS.checkForUpdates) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate) as Promise<InstallResult>,
  openUpdateNotes: () => ipcRenderer.invoke(CHANNELS.openUpdateNotes) as Promise<void>,
};

contextBridge.exposeInMainWorld("tokama", bridge);
