// Electron main process: one hardened window, and the connection to the engine service through
// @tokama/client. The engine runs detached and keeps running when the app quits.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { connect, requestShutdown } from "@tokama/client";
import { API_VERSION, defaultEngineDir, engineEndpoint, err, pidAlive, posixEngineProcesses, readEngineLock, resolveToolsPath, type ToolsPath } from "@tokama/core";
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell } from "electron";
import { type BridgeEvent, CHANNELS } from "../shared/bridge.js";
import { buildInfoText } from "../shared/build-info.js";
import { applyLayoutPatch, applyNotificationsPatch } from "../shared/desktop-state.js";
import { aboutInfo } from "./about.js";
import { engineApi, mainQuery } from "./api.js";
import { openAttemptFile } from "./attempt-file.js";
import { type ConnectionWatch, watchConnection } from "./connection.js";
import { type DesktopStore, desktopStore } from "./desktop-store.js";
import { DIAGNOSTICS_URL, diagnosticsService, saveToFile } from "./diagnostics-send.js";
import { createReporter, mainErrorReport, rateLimit, rendererErrorReport, rendererGoneKind, rendererUsageReport, type Reporter, runMarker } from "./diagnostics.js";
import { attachTracker, engineCommand, engineCommandEnd, engineDirFor, engineEnv, engineRuntime, readLogTail, toolsPathInfo } from "./engine.js";
import { showMainWindow } from "./main-window.js";
import { itemsRunningIn, offerMove, shouldOfferMove } from "./move-to-applications.js";
import { replaceOlderEngine } from "./replace.js";
import { pickRepoFolder } from "./folder.js";
import { createNotifier } from "./notifier.js";
import { appIcons } from "./icon.js";
import { recordingShow, systemShow } from "./system-notification.js";
import { openTemplateFile } from "./template-file.js";
import { fitBounds, trackWindow } from "./window-state.js";
import { backgroundModeEnabled, devServerUrl, diagnosticsUrl, e2eEnabled, guardedHandler, isAppUrl, isDevToolsUrl, isWebsiteUrl, sampleEngineEnabled, secureWebPreferences } from "./policy.js";

const rendererDir = join(import.meta.dirname, "..", "renderer");
const preloadPath = join(import.meta.dirname, "..", "preload", "index.cjs");
const devServer = devServerUrl(process.env["ELECTRON_RENDERER_URL"], app.isPackaged);
const isAppPage = (url: string) => isAppUrl(url, rendererDir, devServer);
// Dev only: `pnpm dev:sample` sets TOKAMA_SAMPLE=1 to start the engine's fake mode with sample data;
// `pnpm dev` runs the real engine on ~/.tokama.
const sample = sampleEngineEnabled(process.env["TOKAMA_SAMPLE"], app.isPackaged);
// UI tests only: the harness sets TOKAMA_E2E=1 so the app never takes focus from the developer.
const background = backgroundModeEnabled(process.env["TOKAMA_E2E"], app.isPackaged, process.platform);
// UI tests, on every platform: notifications go to a list the test reads, never to the system.
const recordNotifications = e2eEnabled(process.env["TOKAMA_E2E"], app.isPackaged);

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

// The PATH the engine starts with, read once per app run. A packaged app started from the Finder
// has only the system folders on its PATH, so it asks the user's login shell; development keeps
// the PATH it was started with, and starts no shell.
let toolsPathRead: Promise<ToolsPath> | undefined;
// The answer once it is in, for callers that must not wait for it.
let toolsPathValue: ToolsPath | undefined;
function toolsPath(): Promise<ToolsPath> {
  toolsPathRead ??= (
    app.isPackaged
      ? resolveToolsPath({ platform: process.platform, shell: userShell(), inheritedPath: process.env["PATH"], home: homedir() })
      : Promise.resolve<ToolsPath>({ path: process.env["PATH"], source: "inherited" })
  ).then((read) => (toolsPathValue = read));
  return toolsPathRead;
}
// Whether the connected engine was already running, which then has its own PATH; told at every connect.
const attach = attachTracker();

/** The login shell of this account; `os.userInfo` throws on some systems, then $SHELL is used. */
function userShell(): string | undefined {
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // Fall through to $SHELL.
  }
  return process.env["SHELL"];
}

function startWatch(onConnected: () => void, onItemEvent: (event: BridgeEvent["event"]) => void): ConnectionWatch {
  // One dir for both sides: the client gets it directly, the engine as `--dir`, since the
  // engine's reduced env has no TOKAMA_ENGINE_DIR or XDG_RUNTIME_DIR to find it by itself.
  const dir = engineDirFor(defaultEngineDir(process.env, homedir()), sample);
  const endpoint = engineEndpoint(dir);
  // In development the engine is the checkout's built apps/engine/dist on the node found on PATH;
  // a packaged app runs the Node and the engine bundle it ships.
  const runtime = engineRuntime({ platform: process.platform, isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, path: process.env["PATH"] });
  // The shell is asked now, while the window loads; the first connect waits for the answer.
  const start = toolsPath().then((tools) => engineCommand({ ...runtime, dir, env: engineEnv(process.env, tools, sample), sample }));
  const lockPath = endpoint.ok ? endpoint.value.lockPath : join(dir, "engine.lock");
  return watchConnection({
    connect: async () => {
      const command = await start;
      if (!command.ok) return err({ code: "start_failed" as const, message: command.error });
      const lock = readEngineLock(lockPath);
      attach.connecting(lock !== undefined && pidAlive(lock.pid));
      return connect({ dir, start: command.value });
    },
    apiVersion: API_VERSION,
    // Only a packaged app compares builds; a dev build is 0.0.0 and never replaces an engine for it.
    ...(app.isPackaged && { appVersion: app.getVersion() }),
    // Only this app's own engine for this dir is stopped; the home lock is the real engine's.
    replaceOlder: (expectedEngineId) =>
      replaceOlderEngine({
        ...(expectedEngineId !== undefined && { expectedEngineId }),
        dir,
        engine: { lockPath, commandEnd: engineCommandEnd(dir, sample), otherLocks: [join(homedir(), ".tokama", "engine.lock")] },
        processes: posixEngineProcesses,
        requestShutdown: (engineDir) => requestShutdown(engineDir),
      }),
    olderLock: () => {
      const lock = readEngineLock(lockPath);
      return { lockPath, ...(lock !== undefined && { pid: lock.pid, engineId: lock.engineId }) };
    },
    logPath: endpoint.ok ? endpoint.value.logPath : join(dir, "engine.log"),
    readLogTail: (path) => readLogTail(path),
    onState: (state) => {
      send(CHANNELS.connectionChanged, state);
      if (state.status === "connected") onConnected();
    },
    onEvent: (event) => {
      send(CHANNELS.event, event);
      onItemEvent(event.event);
    },
  });
}

const icons = appIcons(process.platform, app.getAppPath(), app.isPackaged);

const WINDOW = { width: 1200, height: 800, minWidth: 720, minHeight: 480 } as const;

function createWindow(store: DesktopStore, reporter: Reporter): BrowserWindow {
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
  window.on("unresponsive", () => reporter.report({ type: "warning", source: "renderer", code: "renderer_unresponsive" }));
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
  return window;
}

/** Brings a window to the front, restoring it when minimized. A background test run never takes focus. */
function showWindow(window: BrowserWindow): void {
  if (background) return;
  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
  window.focus();
}

// One app process per user when packaged, so two windows never run two updaters. Development and the UI tests start many.
const primary = !app.isPackaged || app.requestSingleInstanceLock();
if (!primary) app.quit();
// Set once the app is ready: shows the main window, making it again when it was closed.
let showMain: (() => void) | undefined;
app.on("second-instance", () => showMain?.());

/** Unfinished items of an engine that runs from the copy of the app in Applications: 0 when there is none, undefined when that could not be told. */
function itemsRunningInApplications(): Promise<number | undefined> {
  const dir = engineDirFor(defaultEngineDir(process.env, homedir()), sample);
  return itemsRunningIn({
    endpoint: () => engineEndpoint(dir),
    readLock: readEngineLock,
    describe: (pid) => posixEngineProcesses.describe(pid),
    // No start: this only asks an engine that already runs.
    connect: () => connect({ dir }),
  });
}

void app.whenReady().then(async () => {
  if (!primary) return;
  // Before anything starts an engine: a packaged app outside Applications asks to move there, and quits either way.
  if (shouldOfferMove({ platform: process.platform, isPackaged: app.isPackaged, inApplications: () => app.isInApplicationsFolder() })) {
    await offerMove({
      ask: async (question) => (await dialog.showMessageBox({ type: "question", ...question, defaultId: 0, cancelId: 1 })).response,
      askSync: (question) => dialog.showMessageBoxSync({ type: "question", ...question, defaultId: 0, cancelId: 1 }),
      moveToApplicationsFolder: (options) => app.moveToApplicationsFolder(options),
      showErrorBox: (title, content) => dialog.showErrorBox(title, content),
      itemsRunningInApplications,
    });
    app.quit();
    return;
  }
  if (background) app.dock?.hide();
  if (icons.dock !== undefined) app.dock?.setIcon(icons.dock);
  hardenSession();
  const tokamaHome = join(homedir(), ".tokama");
  const store = desktopStore(join(tokamaHome, "desktop.json"), { onError: (error) => console.error("could not save desktop.json:", error) });
  handle(CHANNELS.getDesktopState, () => store.get());
  handle(CHANNELS.saveLayout, (patch) => store.update((state) => applyLayoutPatch(state, patch)));
  // Diagnostics: reports wait for the engine, and go out once it answers. An engine that does not
  // know the command (an older one still running) refuses it, and the report is dropped.
  let engineClient: () => ReturnType<ConnectionWatch["client"]> = () => undefined;
  const reporter = createReporter(async (report) => {
    const client = engineClient();
    if (client === undefined) return "retry";
    const reply = await client.command({ type: "report_diagnostic", report, appVersion: app.getVersion() });
    return reply.ok ? "sent" : reply.error.code === "disconnected" ? "retry" : "dropped";
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => reporter.report(mainErrorReport(error, origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught")));
  const marker = runMarker(join(tokamaHome, "desktop.running"), process.pid, pidAlive);
  if (marker.crashedBefore) reporter.report({ type: "crash", source: "desktop", kind: "unclean_exit" });
  app.on("render-process-gone", (_event, _contents, details) => {
    const kind = rendererGoneKind(details.reason);
    if (kind !== undefined) reporter.report({ type: "crash", source: "renderer", kind });
  });
  const rendererReports = rateLimit(20, 60_000);
  handle(CHANNELS.reportError, (input) => {
    const report = rendererErrorReport(input);
    if (report !== undefined && rendererReports()) reporter.report(report);
  });
  const rendererUsage = rateLimit(120, 60_000);
  handle(CHANNELS.countUsage, (input) => {
    const report = rendererUsageReport(input);
    if (report !== undefined && rendererUsage()) reporter.report(report);
  });
  // Notifications: told about every item update, and it learns the open items again on each connect.
  const notifier = createNotifier({
    settings: () => store.get().notifications,
    windowFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    board: async () => {
      const reply = await engineClient()?.query({ type: "board" });
      return reply?.ok ? reply.data.items : undefined;
    },
    setup: async () => {
      const reply = await engineClient()?.query({ type: "setup" });
      return reply?.ok ? reply.data : undefined;
    },
    show: recordNotifications ? recordingShow() : systemShow(),
    open: (itemId) => openItem(itemId),
    now: () => Date.now(),
    platform: process.platform,
  });
  // A click on a notification: the window comes to the front (made again if it was closed, as on
  // macOS) and opens the item. The renderer is told once its page has loaded.
  const openItem = (itemId: string) => {
    const existing = BrowserWindow.getAllWindows()[0];
    const window = existing ?? createWindow(store, reporter);
    showWindow(window);
    const tell = () => window.webContents.send(CHANNELS.openItem, itemId);
    // A window made just now is told once its page has loaded, whatever its loading state says yet.
    if (existing === undefined || window.webContents.isLoading()) window.webContents.once("did-finish-load", tell);
    else tell();
  };
  handle(CHANNELS.saveNotifications, (patch) => store.update((state) => applyNotificationsPatch(state, patch)));
  handle(CHANNELS.viewedItem, (itemId) => notifier.setViewedItem(typeof itemId === "string" && itemId.length <= 200 ? itemId : undefined));
  const watch = startWatch(() => {
    void reporter.flush();
    void notifier.resync();
  }, (event) => notifier.onEvent(event));
  engineClient = () => watch.client();
  handle(CHANNELS.getConnection, () => watch.state());
  handle(CHANNELS.retryConnection, () => watch.retry());
  handle(CHANNELS.restartEngine, () => watch.restartEngine());
  handle(CHANNELS.waitForEngine, () => watch.waitForEngine());
  const api = engineApi(() => watch.client());
  handle(CHANNELS.query, (query) => api.query(query));
  handle(CHANNELS.command, (command) => api.command(command));
  // The Diagnostics page. Send all posts to the app's own URL; a development build may point it at
  // a local test server, and on the sample engine it sends nowhere without one. The save dialog is looked up on each call, so the UI flow tests can stand in for it.
  const diagnostics = diagnosticsService({
    client: () => watch.client(),
    url: diagnosticsUrl(process.env["TOKAMA_DIAGNOSTICS_URL"], app.isPackaged, sample ? undefined : DIAGNOSTICS_URL),
    saveFile: (text) => saveToFile(text, (options) => {
      const window = BrowserWindow.getFocusedWindow();
      return window === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options);
    }, new Date()),
  });
  handle(CHANNELS.loadDiagnostics, () => diagnostics.load());
  handle(CHANNELS.sendDiagnostics, (ids) => diagnostics.send(ids));
  handle(CHANNELS.saveDiagnostics, (ids) => diagnostics.save(ids));
  handle(CHANNELS.stopCrashPrompt, () => store.update((state) => ({ ...state, askAfterCrash: false })));
  // Looked up on each call, so the UI flow tests can stand in for the native picker.
  handle(CHANNELS.pickFolder, () => pickRepoFolder((options) => {
    const window = BrowserWindow.getFocusedWindow();
    return window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options);
  }, store));
  // shell.openPath is looked up on each call too, so the UI flow tests can stand in for the editor.
  handle(CHANNELS.openTemplateFile, (name) => openTemplateFile(name, { api, tokamaHome, openPath: (path) => shell.openPath(path) }));
  const ownQuery = mainQuery(() => watch.client());
  handle(CHANNELS.openAttemptFile, (name) => openAttemptFile(name, { query: ownQuery, tokamaHome, openPath: (path) => shell.openPath(path) }));
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
  handle(CHANNELS.getToolsPath, async () => toolsPathInfo(await toolsPath(), attach.attached()));
  // Without the Tools PATH line while the shell is still being read: the copy does not wait for it.
  handle(CHANNELS.copyBuildInfo, () => clipboard.writeText(buildInfoText(about(), watch.state().status, toolsPathValue === undefined ? undefined : toolsPathInfo(toolsPathValue, attach.attached()))));
  handle(CHANNELS.showDataFolder, async () => {
    const message = await shell.openPath(tokamaHome);
    return message === "" ? { ok: true } : { ok: false, message };
  });
  app.on("before-quit", () => {
    store.flush();
    marker.clear();
    void watch.close();
  });
  createWindow(store, reporter);
  showMain = () => showMainWindow({ windows: () => BrowserWindow.getAllWindows(), create: () => createWindow(store, reporter), show: showWindow });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store, reporter);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
