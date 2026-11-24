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
 * Whether the app may load `url`: files of the built renderer, or with a dev server only that
 * server (http, and ws for hot reload). DevTools pages are allowed. Everything else, remote
 * content above all, is refused.
 */
export function isAppUrl(url: string, rendererDir: string, devServer: URL | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "devtools:") return true;
  if (devServer !== undefined) return (parsed.protocol === "http:" || parsed.protocol === "ws:") && parsed.host === devServer.host;
  if (parsed.protocol !== "file:") return false;
  const rel = relative(rendererDir, fileURLToPath(parsed));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
