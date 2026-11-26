// The Build rows of About, and the clipboard text made from them. Pure, so the window and the
// main process show and copy the same words.
import type { AboutInfo, ToolsPathInfo } from "./bridge.js";

/**
 * The rows under Build, as label and value. `status` is the engine connection's status. The engine's
 * version and pid are shown only while connected: a lock file may belong to an older engine, or to one that crashed.
 */
export function buildRows(info: AboutInfo, status: string): ReadonlyArray<readonly [string, string]> {
  const engine = status === "connected" ? [info.engine.version, "running", ...(info.engine.pid === undefined ? [] : [`pid ${info.engine.pid}`])] : [status];
  return [
    ["App", `${info.app.version} · ${info.app.built} · ${info.app.commit}`],
    ["Engine", engine.join(" · ")],
    ["Engine API", `v${info.engine.apiVersion}`],
    ["Data folder", info.dataFolder],
    ["Runtime", `Electron ${info.runtime.electron} · Node ${info.runtime.node}`],
  ];
}

/** How the engine got its PATH, in one phrase. It never holds the PATH itself. */
export function toolsPathText(toolsPath: ToolsPathInfo): string {
  if (toolsPath.source === "login-shell") return toolsPath.shell === undefined ? "login shell" : `login shell (${toolsPath.shell})`;
  return toolsPath.problem === undefined ? "inherited" : `inherited (login shell failed: ${toolsPath.problem})`;
}

/** One `Label: value` line per row, then the platform, then where the engine's PATH came from when that is known. */
export function buildInfoText(info: AboutInfo, status: string, toolsPath?: ToolsPathInfo): string {
  const rows = [...buildRows(info, status), ["Platform", info.platform] as const, ...(toolsPath === undefined ? [] : [["Tools PATH", toolsPathText(toolsPath)] as const])];
  return rows.map(([label, value]) => `${label}: ${value}`).join("\n");
}
