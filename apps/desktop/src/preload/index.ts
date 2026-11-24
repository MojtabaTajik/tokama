// Preload bridge. It runs sandboxed, so it is bundled into one CommonJS file and may import only
// `electron`. It exposes `window.tokama` (TokamaBridge) and nothing else: no ipcRenderer, no
// channel names, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type BridgeEvent, CHANNELS, type ConnectionState, type TokamaBridge } from "../shared/bridge.js";

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
  onConnection: (listener) => subscribe<ConnectionState>(CHANNELS.connectionChanged, listener),
  // The reply's type follows the request's: main validates the request, the client parses the reply.
  query: (query) => ipcRenderer.invoke(CHANNELS.query, query) as never,
  command: (command) => ipcRenderer.invoke(CHANNELS.command, command) as never,
  onEvent: (listener) => subscribe<BridgeEvent>(CHANNELS.event, listener),
};

contextBridge.exposeInMainWorld("tokama", bridge);
