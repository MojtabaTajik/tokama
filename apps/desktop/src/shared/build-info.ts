// The Build rows of About, and the clipboard text made from them. Pure, so the window and the
// main process show and copy the same words.
import type { AboutInfo } from "./bridge.js";

/** The rows under Build, as label and value. `status` is the engine connection's status. */
export function buildRows(info: AboutInfo, status: string): ReadonlyArray<readonly [string, string]> {
  const engine = [info.engine.version, status === "connected" ? "running" : status, ...(info.engine.pid === undefined ? [] : [`pid ${info.engine.pid}`])];
  return [
    ["App", `${info.app.version} · ${info.app.built} · ${info.app.commit}`],
    ["Engine", engine.join(" · ")],
    ["Engine API", `v${info.engine.apiVersion}`],
    ["Data folder", info.dataFolder],
    ["Runtime", `Electron ${info.runtime.electron} · Node ${info.runtime.node}`],
  ];
}

/** One `Label: value` line per row, then the platform. */
export function buildInfoText(info: AboutInfo, status: string): string {
  return [...buildRows(info, status), ["Platform", info.platform] as const].map(([label, value]) => `${label}: ${value}`).join("\n");
}
