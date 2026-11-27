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

/** What the app knows about itself: its API version, and one of two ways to tell that an engine of the same API runs older code. */
export interface EngineApp {
  readonly apiVersion: number;
  /** A packaged app's version: an engine of a lower plain release is older. */
  readonly appVersion?: string;
  /** A dev app's newest built engine file, ms since the Unix epoch: a dev engine that started before it runs older code. */
  readonly newestBuildAt?: number;
}

/** The version a dev engine says (its package.json holds `0.0.0`). Only such an engine is ever compared by its start time, so a dev app never touches an installed engine. */
const DEV_ENGINE_VERSION = "0.0.0";

/**
 * True when the engine speaks this app's API and runs older code: a packaged app sees a lower
 * plain release, a dev app a dev engine that started before the newest built file. Never true
 * when the side that would tell is missing.
 */
export function engineStale(engine: Pick<EngineInfo, "apiVersion" | "engineVersion" | "startedAt">, app: EngineApp): boolean {
  if (engine.apiVersion !== app.apiVersion) return false;
  if (olderBuild(engine.engineVersion, app.appVersion)) return true;
  return app.newestBuildAt !== undefined && engine.engineVersion === DEV_ENGINE_VERSION && engine.startedAt !== undefined && engine.startedAt < app.newestBuildAt;
}

/**
 * The engine's API version decides first. An engine of another API cannot be talked to: a newer
 * one is never stopped, an older one is replaced when idle and asked about otherwise. An engine of
 * the same API is used; when it is stale (`engineStale`) and idle it is replaced, and when it is
 * busy it is used until it is found idle. An engine that did not say how many items it runs
 * counts as busy. A packaged app compares plain releases only, and a dev app compares only
 * with a dev engine, so neither replaces an engine it cannot compare.
 */
export function engineAction(engine: Pick<EngineInfo, "apiVersion" | "engineVersion" | "startedAt" | "runningItems">, app: EngineApp): EngineAction {
  if (engine.apiVersion > app.apiVersion) return "newer";
  const idle = engine.runningItems === 0;
  if (engine.apiVersion < app.apiVersion) return idle ? "replace" : "ask";
  return engineStale(engine, app) && idle ? "replace" : "use";
}
