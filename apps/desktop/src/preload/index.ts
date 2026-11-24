// Preload bridge. It runs sandboxed, so it is bundled into one CommonJS file and may import only
// `electron`. It exposes `window.tokama` (TokamaBridge) and nothing else: no ipcRenderer, no
// channel names, no Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type ConnectionState, type TokamaBridge } from "../shared/bridge.js";

export const bridge: TokamaBridge = {
  getConnection: () => ipcRenderer.invoke(CHANNELS.getConnection) as Promise<ConnectionState>,
  onConnection: (listener) => {
    // Wrapped, so the renderer never receives the IPC event object (it carries `sender`).
    const handler = (_event: IpcRendererEvent, state: ConnectionState) => listener(state);
    ipcRenderer.on(CHANNELS.connectionChanged, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.connectionChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld("tokama", bridge);
