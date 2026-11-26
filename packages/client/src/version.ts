// What a client does with an engine that is already running, by comparing versions. Pure, so every
// client (the desktop app, later the CLI) decides the same way.
import type { EngineInfo } from "./client.js";

/** The numbers of a plain `x.y.z` release; undefined for anything else, and for `0.0.0` (a dev build). */
function release(version: string | undefined): readonly [number, number, number] | undefined {
  const match = version === undefined ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => part === 0) ? undefined : parts;
}

/** True when both are plain `x.y.z` releases (not `0.0.0`) and the engine's is lower. */
export function olderBuild(engineVersion: string | undefined, appVersion: string | undefined): boolean {
  const engine = release(engineVersion);
  const app = release(appVersion);
  if (engine === undefined || app === undefined) return false;
  for (const [index, part] of engine.entries()) {
    const other = app[index] ?? 0;
    if (part !== other) return part < other;
  }
  return false;
}

/**
 * - `use`: work with the engine as it is.
 * - `replace`: it is older and runs nothing; stop it (only if it is still idle) and start this version's.
 * - `ask`: it is older, of another API version, and runs items (or cannot say); ask the user.
 * - `newer`: it is newer and of another API version; it is never stopped.
 */
export type EngineAction = "use" | "replace" | "ask" | "newer";

/**
 * The engine's API version decides first. An engine of another API cannot be talked to: a newer
 * one is never stopped, an older one is replaced when idle and asked about otherwise. An engine of
 * the same API is used; when its build is lower and it is idle it is replaced, and when it is busy
 * it is used until the next connect finds it idle. An engine that did not say how many items it
 * runs counts as busy. Builds are compared only when both are plain releases, so a dev build
 * never replaces an engine.
 */
export function engineAction(engine: Pick<EngineInfo, "apiVersion" | "engineVersion" | "runningItems">, app: { readonly apiVersion: number; readonly appVersion?: string }): EngineAction {
  if (engine.apiVersion > app.apiVersion) return "newer";
  const idle = engine.runningItems === 0;
  if (engine.apiVersion < app.apiVersion) return idle ? "replace" : "ask";
  return olderBuild(engine.engineVersion, app.appVersion) && idle ? "replace" : "use";
}
