// Window hardening that does not need Electron to test: the web preferences of every window and
// the rule for which URLs the app may load.
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Web preferences of every window. Electron's secure defaults, stated so a change shows in review. */
export function secureWebPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  } as const;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The renderer's dev server (electron-vite's ELECTRON_RENDERER_URL), accepted only as an http
 * URL on a loopback host. Undefined in a packaged app or when the value is anything else.
 */
export function devServerUrl(value: string | undefined, isPackaged: boolean): URL | undefined {
  if (isPackaged || value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where Send all posts diagnostics: `fixed` (the app's constant), or in a development build a
 * loopback test server named by TOKAMA_DIAGNOSTICS_URL. A packaged app never reads the variable.
 * `fixed` is undefined on the sample engine, so sample entries never reach the real receiver.
 */
export function diagnosticsUrl(value: string | undefined, isPackaged: boolean, fixed: URL | undefined): URL | undefined {
  if (isPackaged || value === undefined) return fixed;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname) ? url : fixed;
  } catch {
    return fixed;
  }
}

/**
 * Whether `url` is one of the app's own pages or files: files of the built renderer, or with a
 * dev server only that server (http, and ws for hot reload). Everything else, remote content
 * above all, is refused; so is a `file:` URL with a host, which is not a local path.
 */
export function isAppUrl(url: string, rendererDir: string, devServer: URL | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServer !== undefined) return (parsed.protocol === "http:" || parsed.protocol === "ws:") && parsed.host === devServer.host;
  if (parsed.protocol !== "file:") return false;
  let path: string;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return false;
  }
  const rel = relative(rendererDir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** DevTools pages: the session may load them, but they never count as an app page for IPC. */
export function isDevToolsUrl(url: string): boolean {
  return url.startsWith("devtools:");
}

/** What an IPC handler needs of its event: the frame that sent it. */
export interface IpcSender {
  readonly senderFrame?: { readonly url: string } | null;
}

/**
 * Wraps an IPC handler so it answers only the app's own pages (`isAppPage` gets the sending
 * frame's URL). Every bridge channel goes through this, so a new one cannot skip the check.
 * `fn` gets the renderer's arguments as `unknown`: it validates them itself.
 */
export function guardedHandler<T>(
  isAppPage: (url: string) => boolean,
  fn: (...args: unknown[]) => T,
): (event: IpcSender, ...args: unknown[]) => T {
  return (event, ...args) => {
    if (!isAppPage(event.senderFrame?.url ?? "")) throw new Error("refused: not an app page");
    return fn(...args);
  };
}

/**
 * Whether the app starts the engine in its fake mode (`--sample`, sample data): only outside a
 * packaged app, and only when the dev:sample script sets TOKAMA_SAMPLE=1.
 */
export function sampleEngineEnabled(value: string | undefined, isPackaged: boolean): boolean {
  return !isPackaged && value === "1";
}

/**
 * Whether the app runs in the background for UI tests (`TOKAMA_E2E=1`, set by the test harness):
 * only outside a packaged app, and only on macOS, where a test window would take the developer's
 * focus. It then shows no Dock icon, never takes focus and keeps rendering while hidden. Linux
 * runs under a virtual display and keeps the normal, visible window.
 */
export function backgroundModeEnabled(value: string | undefined, isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return !isPackaged && value === "1" && platform === "darwin";
}

/**
 * Whether the app runs under the UI tests (`TOKAMA_E2E=1`): only outside a packaged app, on every
 * platform. It records notifications for the test instead of showing them.
 */
export function e2eEnabled(value: string | undefined, isPackaged: boolean): boolean {
  return !isPackaged && value === "1";
}

/** The addresses the app opens in the system browser: the product site and its docs pages. Nothing else ever leaves the window. */
export const WEBSITE_URLS: ReadonlySet<string> = new Set([
  "https://tokama.dev/",
  "https://tokama.dev/docs/",
  "https://tokama.dev/docs/install-claude-code",
  "https://tokama.dev/docs/install-git",
  "https://tokama.dev/docs/linux-sandbox",
]);

/**
 * The one system address besides the website that the app opens: the Notifications pane of macOS
 * System Settings. It is a constant the main process opens itself; no address from the window is
 * ever passed to `shell.openExternal`, and this one is opened on macOS only.
 */
export const MACOS_NOTIFICATION_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.notifications";

/** The address of the system's notification settings on `platform`, or undefined where the app cannot open them. */
export const notificationSettingsUrl = (platform: NodeJS.Platform): string | undefined => (platform === "darwin" ? MACOS_NOTIFICATION_SETTINGS_URL : undefined);

/** The docs start page, which Help > Tokama docs opens. */
export const DOCS_URL = "https://tokama.dev/docs/";

/**
 * The checked, parsed address of `url` when it is exactly one of the pages in `WEBSITE_URLS` (no
 * other host, path, query, fragment or credentials); undefined otherwise. Open this string, not
 * the one that was given: it is the one that was checked.
 */
export function websiteHref(url: string): string | undefined {
  try {
    const { href } = new URL(url);
    return WEBSITE_URLS.has(href) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `url` is exactly one of the pages in `WEBSITE_URLS`. */
export const isWebsiteUrl = (url: string): boolean => websiteHref(url) !== undefined;
