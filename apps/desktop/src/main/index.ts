// Electron main process: one hardened window, and the connection to the engine service through
// @tokama/client. The engine runs detached and keeps running when the app quits.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@tokama/client";
import { buildEnv, defaultEngineDir, engineEndpoint, err } from "@tokama/core";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { CHANNELS } from "../shared/bridge.js";
import { type ConnectionWatch, watchConnection } from "./connection.js";
import { engineCommand, findExecutable, readLogTail } from "./engine.js";
import { devServerUrl, guardedHandler, isAppUrl, isDevToolsUrl, secureWebPreferences } from "./policy.js";

const rendererDir = join(import.meta.dirname, "..", "renderer");
const preloadPath = join(import.meta.dirname, "..", "preload", "index.cjs");
const devServer = devServerUrl(process.env["ELECTRON_RENDERER_URL"], app.isPackaged);
const isAppPage = (url: string) => isAppUrl(url, rendererDir, devServer);

/** Registers a bridge channel; it answers app pages only. */
function handle(channel: string, fn: () => unknown): void {
  ipcMain.handle(channel, guardedHandler(isAppPage, fn));
}

app.enableSandbox();

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(isAppPage(details.url) || isDevToolsUrl(details.url)) }));
}

function startWatch(): ConnectionWatch {
  // One dir for both sides: the client gets it directly, the engine as `--dir`, since the
  // engine's reduced env has no TOKAMA_ENGINE_DIR or XDG_RUNTIME_DIR to find it by itself.
  const dir = defaultEngineDir(process.env, homedir());
  const endpoint = engineEndpoint(dir);
  // Dev layout: apps/desktop is the app path, the engine is built to apps/engine/dist.
  // A packaged app will ship the engine and a runtime with it (not yet).
  const start = engineCommand({
    node: findExecutable("node", process.env["PATH"]),
    entry: resolve(app.getAppPath(), "..", "engine", "dist", "main.js"),
    dir,
    env: buildEnv(process.env),
  });
  return watchConnection({
    connect: () => {
      if (!start.ok) return Promise.resolve(err({ code: "start_failed" as const, message: start.error }));
      return connect({ dir, start: start.value });
    },
    logPath: endpoint.ok ? endpoint.value.logPath : join(dir, "engine.log"),
    readLogTail: (path) => readLogTail(path),
    onState: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNELS.connectionChanged, state);
    },
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Tokama",
    backgroundColor: "#0B0F17",
    show: false,
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.once("ready-to-show", () => window.show());
  if (devServer !== undefined) void window.loadURL(devServer.href);
  else void window.loadFile(join(rendererDir, "index.html"));
}

void app.whenReady().then(() => {
  hardenSession();
  const watch = startWatch();
  handle(CHANNELS.getConnection, () => watch.state());
  app.on("before-quit", () => void watch.close());
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
