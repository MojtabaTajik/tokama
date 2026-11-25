// Electron main process: one hardened window, and the connection to the engine service through
// @tokama/client. The engine runs detached and keeps running when the app quits.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@tokama/client";
import { API_VERSION, buildEnv, defaultEngineDir, engineEndpoint, err } from "@tokama/core";
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell } from "electron";
import { CHANNELS } from "../shared/bridge.js";
import { buildInfoText } from "../shared/build-info.js";
import { applyLayoutPatch } from "../shared/desktop-state.js";
import { aboutInfo } from "./about.js";
import { engineApi } from "./api.js";
import { type ConnectionWatch, watchConnection } from "./connection.js";
import { type DesktopStore, desktopStore } from "./desktop-store.js";
import { engineCommand, engineDirFor, findExecutable, otherVersionMessage, readLogTail } from "./engine.js";
import { pickRepoFolder } from "./folder.js";
import { appIcons } from "./icon.js";
import { openTemplateFile } from "./template-file.js";
import { fitBounds, trackWindow } from "./window-state.js";
import { backgroundModeEnabled, devServerUrl, guardedHandler, isAppUrl, isDevToolsUrl, isWebsiteUrl, sampleEngineEnabled, secureWebPreferences } from "./policy.js";

const rendererDir = join(import.meta.dirname, "..", "renderer");
const preloadPath = join(import.meta.dirname, "..", "preload", "index.cjs");
const devServer = devServerUrl(process.env["ELECTRON_RENDERER_URL"], app.isPackaged);
const isAppPage = (url: string) => isAppUrl(url, rendererDir, devServer);
// Dev only: `pnpm dev:sample` sets TOKAMA_SAMPLE=1 to start the engine's fake mode with sample data;
// `pnpm dev` runs the real engine on ~/.tokama.
const sample = sampleEngineEnabled(process.env["TOKAMA_SAMPLE"], app.isPackaged);
// UI tests only: the harness sets TOKAMA_E2E=1 so the app never takes focus from the developer.
const background = backgroundModeEnabled(process.env["TOKAMA_E2E"], app.isPackaged, process.platform);

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
    // The SSH agent socket reaches the engine for Open PR's push to an SSH remote; the engine's
    // process runner drops it again for every agent, check and other git call.
    env: buildEnv(process.env, process.env["SSH_AUTH_SOCK"] === undefined ? {} : { SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] }),
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

const WINDOW = { width: 1200, height: 800, minWidth: 720, minHeight: 480 } as const;

function createWindow(store: DesktopStore): void {
  const saved = store.get().window;
  // The remembered place, moved onto a display that is there now.
  const placement = fitBounds(saved.bounds, screen.getAllDisplays().map((display) => display.workArea), screen.getPrimaryDisplay().workArea, WINDOW);
  const window = new BrowserWindow({
    ...placement,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    title: "Tokama",
    backgroundColor: "#0B0F17",
    show: false,
    ...(icons.window === undefined ? {} : { icon: icons.window }),
    webPreferences: { ...secureWebPreferences(preloadPath), ...(background ? { backgroundThrottling: false } : {}) },
  });
  trackWindow(window, store);
  // A background test run never shows the window; maximizing or full-screening would show it, so they wait for a real show.
  if (!background) {
    window.once("ready-to-show", () => {
      // Maximizing shows a window at once, so it waits until the page is ready.
      if (saved.maximized) window.maximize();
      if (saved.fullscreen) window.setFullScreen(true);
      window.show();
    });
  }
  if (devServer !== undefined) void window.loadURL(devServer.href);
  else void window.loadFile(join(rendererDir, "index.html"));
}

void app.whenReady().then(() => {
  if (background) app.dock?.hide();
  if (icons.dock !== undefined) app.dock?.setIcon(icons.dock);
  hardenSession();
  const tokamaHome = join(homedir(), ".tokama");
  const store = desktopStore(join(tokamaHome, "desktop.json"), { onError: (error) => console.error("could not save desktop.json:", error) });
  handle(CHANNELS.getDesktopState, () => store.get());
  handle(CHANNELS.saveLayout, (patch) => store.update((state) => applyLayoutPatch(state, patch)));
  const watch = startWatch();
  handle(CHANNELS.getConnection, () => watch.state());
  handle(CHANNELS.retryConnection, () => watch.retry());
  const api = engineApi(() => watch.client());
  handle(CHANNELS.query, (query) => api.query(query));
  handle(CHANNELS.command, (command) => api.command(command));
  // Looked up on each call, so the UI flow tests can stand in for the native picker.
  handle(CHANNELS.pickFolder, () => pickRepoFolder((options) => {
    const window = BrowserWindow.getFocusedWindow();
    return window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options);
  }, store));
  // shell.openPath is looked up on each call too, so the UI flow tests can stand in for the editor.
  handle(CHANNELS.openTemplateFile, (name) => openTemplateFile(name, { api, tokamaHome, openPath: (path) => shell.openPath(path) }));
  const about = () => {
    const dir = engineDirFor(defaultEngineDir(process.env, homedir()), sample);
    const endpoint = engineEndpoint(dir);
    return aboutInfo({
      version: app.getVersion(),
      build: __BUILD__,
      apiVersion: API_VERSION,
      tokamaHome,
      lockPath: endpoint.ok ? endpoint.value.lockPath : join(dir, "engine.lock"),
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
    });
  };
  handle(CHANNELS.getAboutInfo, about);
  handle(CHANNELS.copyBuildInfo, () => clipboard.writeText(buildInfoText(about(), watch.state().status)));
  handle(CHANNELS.showDataFolder, async () => {
    const message = await shell.openPath(tokamaHome);
    return message === "" ? { ok: true } : { ok: false, message };
  });
  app.on("before-quit", () => {
    store.flush();
    void watch.close();
  });
  createWindow(store);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
