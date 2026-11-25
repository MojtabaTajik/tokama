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

/** The one address the app opens in the system browser: the product site. Nothing else ever leaves the window. */
const WEBSITE = "https://tokama.dev/";

/** Whether `url` is exactly the product site (no other host, path, query or credentials). */
export function isWebsiteUrl(url: string): boolean {
  try {
    return new URL(url).href === WEBSITE;
  } catch {
    return false;
  }
}
