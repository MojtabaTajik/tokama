// Electron main process: one hardened window, and the connection to the engine service through
// @tokama/client. The engine runs detached and keeps running when the app quits.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@tokama/client";
import { buildEnv, defaultEngineDir, engineEndpoint, err } from "@tokama/core";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { CHANNELS } from "../shared/bridge.js";
import { engineApi } from "./api.js";
import { type ConnectionWatch, watchConnection } from "./connection.js";
import { engineCommand, engineDirFor, findExecutable, otherVersionMessage, readLogTail } from "./engine.js";
import { pickFolder } from "./folder.js";
import { appIcons } from "./icon.js";
import { openTemplateFile } from "./template-file.js";
import { backgroundModeEnabled, devServerUrl, guardedHandler, isAppUrl, isDevToolsUrl, isWebsiteUrl, sampleEngineEnabled, secureWebPreferences } from "./policy.js";

const rendererDir = join(import.meta.dirname, "..", "renderer");
const preloadPath = join(import.meta.dirname, "..", "preload", "index.cjs");
const devServer = devServerUrl(process.env["ELECTRON_RENDERER_URL"], app.isPackaged);
const isAppPage = (url: string) => isAppUrl(url, rendererDir, devServer);
// Dev only: `pnpm dev:sample` sets TOKAMA_SAMPLE=1 to start the engine's fake mode with sample data;
// `pnpm dev` runs the real engine on ~/.tokama.
const sample = sampleEngineEnabled(process.env["TOKAMA_SAMPLE"], app.isPackaged);
// UI tests only: the harness sets TOKAMA_E2E=1 so the app never takes focus from the developer.
const background = backgroundModeEnabled(process.env["TOKAMA_E2E"], app.isPackaged);

/** Registers a bridge channel; it answers app pages only. */
function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, guardedHandler(isAppPage, fn));
}

app.enableSandbox();

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // No window opens. The one link in the app, to the product site, goes to the system browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebsiteUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(isAppPage(details.url) || isDevToolsUrl(details.url)) }));
}

/** Pushes a message to every window; each loads only the app's own pages. */
function send(channel: string, message: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, message);
}

function startWatch(): ConnectionWatch {
  // One dir for both sides: the client gets it directly, the engine as `--dir`, since the
  // engine's reduced env has no TOKAMA_ENGINE_DIR or XDG_RUNTIME_DIR to find it by itself.
  const dir = engineDirFor(defaultEngineDir(process.env, homedir()), sample);
  const endpoint = engineEndpoint(dir);
  // Dev layout: apps/desktop is the app path, the engine is built to apps/engine/dist.
  // A packaged app will ship the engine and a runtime with it (not yet).
  const start = engineCommand({
    node: findExecutable("node", process.env["PATH"]),
    entry: resolve(app.getAppPath(), "..", "engine", "dist", "main.js"),
    dir,
    env: buildEnv(process.env),
    sample,
  });
  return watchConnection({
    connect: () => {
      if (!start.ok) return Promise.resolve(err({ code: "start_failed" as const, message: start.error }));
      return connect({ dir, start: start.value });
    },
    logPath: endpoint.ok ? endpoint.value.logPath : join(dir, "engine.log"),
    readLogTail: (path) => readLogTail(path),
    onState: (state) => send(CHANNELS.connectionChanged, state),
    onEvent: (event) => send(CHANNELS.event, event),
    otherVersion: otherVersionMessage(endpoint.ok ? endpoint.value.lockPath : join(dir, "engine.lock")),
  });
}

const icons = appIcons(process.platform, app.getAppPath(), app.isPackaged);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Tokama",
    backgroundColor: "#0B0F17",
    show: false,
    ...(icons.window === undefined ? {} : { icon: icons.window }),
    webPreferences: { ...secureWebPreferences(preloadPath), ...(background ? { backgroundThrottling: false } : {}) },
  });
  if (!background) window.once("ready-to-show", () => window.show());
  if (devServer !== undefined) void window.loadURL(devServer.href);
  else void window.loadFile(join(rendererDir, "index.html"));
}

void app.whenReady().then(() => {
  if (background) app.dock?.hide();
  if (icons.dock !== undefined) app.dock?.setIcon(icons.dock);
  hardenSession();
  const watch = startWatch();
  handle(CHANNELS.getConnection, () => watch.state());
  handle(CHANNELS.retryConnection, () => watch.retry());
  const api = engineApi(() => watch.client());
  handle(CHANNELS.query, (query) => api.query(query));
  handle(CHANNELS.command, (command) => api.command(command));
  // Looked up on each call, so the UI flow tests can stand in for the native picker.
  handle(CHANNELS.pickFolder, () => pickFolder((options) => {
    const window = BrowserWindow.getFocusedWindow();
    return window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options);
  }));
  // shell.openPath is looked up on each call too, so the UI flow tests can stand in for the editor.
  const tokamaHome = join(homedir(), ".tokama");
  handle(CHANNELS.openTemplateFile, (name) => openTemplateFile(name, { api, tokamaHome, openPath: (path) => shell.openPath(path) }));
  app.on("before-quit", () => void watch.close());
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
