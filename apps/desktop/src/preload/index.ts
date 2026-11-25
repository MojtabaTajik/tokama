// Preload bridge. It runs sandboxed, so it is bundled into one CommonJS file and may import only
// `electron`. It exposes `window.tokama` (TokamaBridge) and nothing else: no ipcRenderer, no
// channel names, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type AboutInfo, type BridgeEvent, CHANNELS, type ConnectionState, type OpenResult, type TokamaBridge } from "../shared/bridge.js";
import type { DesktopState } from "../shared/desktop-state.js";

/** Subscribes to a pushed channel. Wrapped, so the renderer never receives the IPC event object (it carries `sender`). */
function subscribe<T>(channel: string, listener: (message: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, message: T) => listener(message);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

export const bridge: TokamaBridge = {
  getConnection: () => ipcRenderer.invoke(CHANNELS.getConnection) as Promise<ConnectionState>,
  retryConnection: () => ipcRenderer.invoke(CHANNELS.retryConnection) as Promise<void>,
  onConnection: (listener) => subscribe<ConnectionState>(CHANNELS.connectionChanged, listener),
  // The reply's type follows the request's: main validates the request, the client parses the reply.
  query: (query) => ipcRenderer.invoke(CHANNELS.query, query) as never,
  command: (command) => ipcRenderer.invoke(CHANNELS.command, command) as never,
  onEvent: (listener) => subscribe<BridgeEvent>(CHANNELS.event, listener),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder) as Promise<string | null>,
  // Only the two names cross, whatever else the renderer passes.
  openTemplateFile: ({ origin, file }) => ipcRenderer.invoke(CHANNELS.openTemplateFile, { origin, file }) as Promise<OpenResult>,
  getAboutInfo: () => ipcRenderer.invoke(CHANNELS.getAboutInfo) as Promise<AboutInfo>,
  copyBuildInfo: () => ipcRenderer.invoke(CHANNELS.copyBuildInfo) as Promise<void>,
  showDataFolder: () => ipcRenderer.invoke(CHANNELS.showDataFolder) as Promise<OpenResult>,
  getDesktopState: () => ipcRenderer.invoke(CHANNELS.getDesktopState) as Promise<DesktopState>,
  saveLayout: (patch) => ipcRenderer.invoke(CHANNELS.saveLayout, patch) as Promise<void>,
  // Only the two strings cross, whatever else the renderer passes.
  reportError: ({ message, stack }) => ipcRenderer.invoke(CHANNELS.reportError, { message: String(message), stack: String(stack) }) as Promise<void>,
  countUsage: (action) => ipcRenderer.invoke(CHANNELS.countUsage, String(action)) as Promise<void>,
};

contextBridge.exposeInMainWorld("tokama", bridge);
